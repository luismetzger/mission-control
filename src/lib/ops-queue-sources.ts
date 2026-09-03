/**
 * T3 approval queue — the GitHub reads and the disposition PR.
 *
 * Split from ops-queue.ts so the panel can import the types and the expiry rules
 * without pulling a server-side GitHub client into the client bundle, matching
 * the ops-timeline / ops-timeline-sources split.
 *
 * There is exactly one write in this file and it opens a pull request. The
 * cockpit cannot record an approval, only propose one: git markdown is the
 * source of truth, so the merge is the approval. That is not a limitation to be
 * worked around later — a one-click T3 button is the thing architecture/04 §2
 * forbids, and a PR is what makes the decision reviewable and revertible.
 */

import { logger } from '@/lib/logger'
import { opsGithubJson, OpsGitHubError, type FetchImpl } from '@/lib/ops-github'
import type { OpsConfig, OpsRepoRef } from '@/lib/ops-config'
import {
  DISPOSITION_BRANCH_PREFIX,
  QUEUE_ARCHIVE,
  QUEUE_DIR,
  buildDisposition,
  dispositionBranchName,
  dispositionRefusal,
  isQueuePath,
  parseApprovalRequest,
  sortRequests,
  type ApprovalRequest,
  type Disposition,
} from '@/lib/ops-queue'

interface ContentsEntry {
  name?: string
  path?: string
  type?: string
}

interface ContentsFile {
  content?: string
  encoding?: string
  sha?: string
  html_url?: string
}

function decode(file: ContentsFile): string {
  return file.encoding === 'base64' && file.content
    ? Buffer.from(file.content, 'base64').toString('utf8')
    : String(file.content ?? '')
}

/**
 * List one queue directory. A 404 means the directory does not exist, which is
 * an empty queue rather than a failure — the same reading the watchdog takes.
 */
async function listDir(
  ref: OpsRepoRef,
  dir: string,
  deps: { token: string; fetchImpl?: FetchImpl },
): Promise<string[]> {
  try {
    const entries = await opsGithubJson<ContentsEntry[]>({
      path: `/repos/${ref.repo}/contents/${dir}`,
      token: deps.token,
      fetchImpl: deps.fetchImpl,
    })
    return (Array.isArray(entries) ? entries : [])
      .filter(e => e.type === 'file' && typeof e.path === 'string' && /\.md$/i.test(e.path))
      .map(e => e.path as string)
  } catch (err) {
    if (err instanceof OpsGitHubError && err.status === 404) return []
    throw err
  }
}

export interface QueueSnapshot {
  repo: string
  pending: ApprovalRequest[]
  /** Most recent decisions, for context. Bounded by `archiveLimit`. */
  decided: ApprovalRequest[]
  /** Per-source failures, reported rather than thrown. */
  errors: Array<{ path: string; message: string }>
}

export const DEFAULT_ARCHIVE_LIMIT = 10

/**
 * Read the queue from the brain repo.
 *
 * Only the brain repo is consulted, and it is taken from config rather than a
 * request parameter: the queue is Z0 by policy, so there is no caller-supplied
 * repo to get wrong.
 */
export async function fetchQueue(
  config: OpsConfig,
  deps: { token: string; fetchImpl?: FetchImpl; nowMs?: number; archiveLimit?: number },
): Promise<QueueSnapshot> {
  const ref = config.brainRepo
  const nowMs = deps.nowMs ?? Date.now()
  const errors: QueueSnapshot['errors'] = []

  const [pendingPaths, archivedPaths] = await Promise.all([
    listDir(ref, QUEUE_DIR, deps),
    listDir(ref, QUEUE_ARCHIVE, deps),
  ])

  const archiveLimit = deps.archiveLimit ?? DEFAULT_ARCHIVE_LIMIT
  // Filenames start with the request date, so a reverse sort is newest-first
  // without reading anything.
  const wanted = [
    ...pendingPaths.filter(p => isQueuePath(ref, p)),
    ...archivedPaths.filter(p => isQueuePath(ref, p)).sort((a, b) => b.localeCompare(a)).slice(0, archiveLimit),
  ]

  const loaded = await Promise.all(
    wanted.map(async path => {
      try {
        const file = await opsGithubJson<ContentsFile>({
          path: `/repos/${ref.repo}/contents/${path}`,
          token: deps.token,
          fetchImpl: deps.fetchImpl,
        })
        return parseApprovalRequest(
          { repo: ref.repo, path, raw: decode(file), htmlUrl: file.html_url },
          nowMs,
        )
      } catch (err) {
        errors.push({ path, message: err instanceof Error ? err.message : 'read failed' })
        return null
      }
    }),
  )

  const requests = loaded.filter((r): r is ApprovalRequest => r !== null)
  return {
    repo: ref.repo,
    pending: sortRequests(requests.filter(r => !r.archived)),
    decided: sortRequests(requests.filter(r => r.archived)),
    errors,
  }
}

/** Read one request, for the confirm step. */
export async function fetchRequest(
  config: OpsConfig,
  path: string,
  deps: { token: string; fetchImpl?: FetchImpl; nowMs?: number },
): Promise<{ request: ApprovalRequest; raw: string; sha: string }> {
  const ref = config.brainRepo
  if (!isQueuePath(ref, path)) {
    throw new Error(`not a queue path in ${ref.repo}: ${path}`)
  }
  const file = await opsGithubJson<ContentsFile>({
    path: `/repos/${ref.repo}/contents/${path}`,
    token: deps.token,
    fetchImpl: deps.fetchImpl,
  })
  const raw = decode(file)
  return {
    request: parseApprovalRequest(
      { repo: ref.repo, path, raw, htmlUrl: file.html_url },
      deps.nowMs ?? Date.now(),
    ),
    raw,
    sha: String(file.sha ?? ''),
  }
}

// ---------------------------------------------------------------------------
// Disposition → PR
// ---------------------------------------------------------------------------

export interface ProposeDispositionInput {
  path: string
  disposition: Disposition
  /** The authenticated operator. Never a form field. */
  decidedBy: string
  note?: string
  /** Blob sha the operator was looking at, for optimistic concurrency. */
  sha: string
}

export interface ProposeDispositionResult {
  prUrl: string
  prNumber: number
  branch: string
  base: string
  archivePath: string
  disposition: Disposition
}

/**
 * Open a PR that moves a request to `archive/queue/` with its disposition
 * recorded.
 *
 * Three refusals happen before any write:
 *   - the path must be a queue path in the brain repo (Z0);
 *   - `dispositionRefusal` must pass, so an expired request cannot be approved
 *     and a decided one cannot be re-decided;
 *   - the branch must be a fresh `cockpit/disposition-*`, never the base.
 *
 * The body is not editable through this path at all — `buildDisposition`
 * reproduces everything above `## Disposition` byte-for-byte or throws.
 */
export async function proposeDisposition(
  config: OpsConfig,
  input: ProposeDispositionInput,
  deps: { token: string; fetchImpl?: FetchImpl; nowMs?: number },
): Promise<ProposeDispositionResult> {
  const ref = config.brainRepo
  const nowMs = deps.nowMs ?? Date.now()
  const { token, fetchImpl } = deps

  if (!isQueuePath(ref, input.path)) {
    throw new Error(`not a queue path in ${ref.repo}: ${input.path}`)
  }
  if (!input.sha) throw new Error('missing base blob sha; reload the request before deciding')
  if (!input.decidedBy.trim()) throw new Error('a decision needs a decider')

  const current = await fetchRequest(config, input.path, { token, fetchImpl, nowMs })
  if (current.sha !== input.sha) {
    throw new Error('the request changed since it was loaded; reload and read it again')
  }

  const refusal = dispositionRefusal(current.request, input.disposition)
  if (refusal) throw new Error(refusal)

  const decidedAt = new Date(nowMs).toISOString().slice(0, 10)
  const built = buildDisposition({
    raw: current.raw,
    path: input.path,
    disposition: input.disposition,
    decidedBy: input.decidedBy,
    decidedAt,
    note: input.note,
  })

  const repoInfo = await opsGithubJson<{ default_branch?: string }>({
    path: `/repos/${ref.repo}`,
    token,
    fetchImpl,
  })
  const base = String(repoInfo.default_branch ?? 'main')

  const baseRef = await opsGithubJson<{ object?: { sha?: string } }>({
    path: `/repos/${ref.repo}/git/ref/heads/${encodeURIComponent(base)}`,
    token,
    fetchImpl,
  })
  const baseSha = String(baseRef.object?.sha ?? '')
  if (!baseSha) throw new Error(`could not resolve head of ${ref.repo}@${base}`)

  const branch = dispositionBranchName(input.path, nowMs)
  if (branch === base || !branch.startsWith(DISPOSITION_BRANCH_PREFIX)) {
    throw new Error(`refusing to write outside a ${DISPOSITION_BRANCH_PREFIX}* branch`)
  }

  await opsGithubJson<unknown>({
    path: `/repos/${ref.repo}/git/refs`,
    token,
    fetchImpl,
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
  })

  const title = `t3: ${input.disposition} — ${current.request.title}`
  const commitMessage =
    `${title}\n\n` +
    `Dispositioned from the Mission Control cockpit approval card.\n` +
    `Request body unchanged; only the disposition fields and the Disposition\n` +
    `section were written (policies/t3-queue.md rule 8).`

  // Write the decided file at its archive path, then delete the pending one.
  // Two commits rather than a tree write, because the intent reads plainly in
  // the PR's file list: one addition under archive/queue/, one deletion.
  await opsGithubJson<unknown>({
    path: `/repos/${ref.repo}/contents/${built.archivePath}`,
    token,
    fetchImpl,
    method: 'PUT',
    body: {
      message: commitMessage,
      content: Buffer.from(built.content, 'utf8').toString('base64'),
      branch,
    },
  })
  await opsGithubJson<unknown>({
    path: `/repos/${ref.repo}/contents/${input.path}`,
    token,
    fetchImpl,
    method: 'DELETE',
    body: {
      message: `t3: move ${input.path} to ${built.archivePath}`,
      sha: input.sha,
      branch,
    },
  })

  const expiry = current.request.expiry
  const bodyLines = [
    `Dispositioned from the **Mission Control cockpit** approval card.`,
    '',
    `- request: \`${input.path}\` → \`${built.archivePath}\``,
    `- disposition: **${input.disposition}**`,
    `- decided by: ${input.decidedBy.trim()} (authenticated cockpit identity)`,
    `- decided at: ${decidedAt}`,
    `- action zone: \`${current.request.actionZone}\``,
    expiry.expiresAt ? `- expires_at: ${expiry.expiresAt} (${expiry.state})` : null,
    '',
    '**Merging this PR is the decision.** The cockpit cannot record an approval,',
    `only propose one — it has no write access to \`${base}\`. Nothing has been`,
    'acted on yet.',
    '',
    'The request body above `## Disposition` is unchanged, which the cockpit',
    'enforces when it builds the diff (`policies/t3-queue.md` rule 8 — the wiki',
    'gate reads the tree, not the diff, so it cannot check this itself).',
    ...(input.note?.trim() ? ['', '---', '', input.note.trim()] : []),
  ].filter((l): l is string => l !== null)

  const pr = await opsGithubJson<{ html_url?: string; number?: number }>({
    path: `/repos/${ref.repo}/pulls`,
    token,
    fetchImpl,
    method: 'POST',
    body: { title, head: branch, base, body: bodyLines.join('\n') },
  })

  logger.info(
    {
      repo: ref.repo,
      path: input.path,
      disposition: input.disposition,
      branch,
      base,
      pr: pr.number,
    },
    'cockpit T3 disposition proposed as PR',
  )

  return {
    prUrl: String(pr.html_url ?? ''),
    prNumber: Number(pr.number ?? 0),
    branch,
    base,
    archivePath: built.archivePath,
    disposition: input.disposition,
  }
}

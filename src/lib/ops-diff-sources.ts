/**
 * Diff panel sources — the GitHub reads that produce a `DiffSnapshot`.
 *
 * Server-only. Same reason as the other `ops-*-sources.ts` modules: keep
 * the GitHub client out of the client bundle so importing diff types
 * doesn't drag a fetcher with it. Every fetcher here is read-only; the
 * diff panel proposes nothing.
 *
 * First and only diff today: `retro-proposals`. Reads open PRs from the
 * brain repo and keeps only those that look like a retro-job proposal:
 *
 *   1. head branch starts with `retro/` (see `isRetroBranch`), AND
 *   2. every changed path sits under a retro scope prefix
 *      (`skills/`, `policies/`, `templates/`; see `allPathsInRetroScope`).
 *
 * Both filters have to pass. A `retro/…` branch that also touches infra is
 * not a retro proposal — it is something else labelled wrong, and letting
 * it into the review surface would erode the "the diff viewer shows what
 * the retro job proposed" invariant. Conversely, a branch not named
 * `retro/…` that touches only skills is a hand-authored change; the note
 * panel is where those get reviewed.
 *
 * ### Caps and truncation
 *
 * The API hard-caps at:
 *   - `MAX_PRS`   PRs per snapshot
 *   - `MAX_FILES` files per PR
 *
 * Anything above either cap is truncated and surfaced explicitly in the
 * snapshot (`filesTruncated: true` on the PR, and the caption calls out
 * the PR-list cap). The retro job is expected to open small PRs; if it
 * ever needs more, the answer is a tighter retro job, not a bigger panel.
 */

import { logger } from '@/lib/logger'
import { opsGithubJson, OpsGitHubError, type FetchImpl } from '@/lib/ops-github'
import type { OpsConfig } from '@/lib/ops-config'
import {
  allPathsInRetroScope,
  isRetroBranch,
  normaliseFileStatus,
  type DiffFile,
  type DiffId,
  type DiffPr,
  type DiffSnapshot,
} from '@/lib/ops-diff'

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Maximum PRs the panel will render in one snapshot. Kept low because a
 * retro job that opens more than a handful of PRs in a week is a signal to
 * investigate the retro job, not to widen the panel. */
export const MAX_PRS = 10

/** Maximum files the panel will fetch per PR. GitHub's own `files` endpoint
 * paginates at 30 by default and 100 max; we cap lower because per-file
 * patches can be large and the panel is meant to read like a review, not a
 * whole-repo diff dump. */
export const MAX_FILES = 20

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface DiffSnapshotDeps {
  token: string
  fetchImpl?: FetchImpl
  /** Injectable clock so tests get a stable `asOf`. */
  now?: () => Date
}

/**
 * Dispatch on `diffId`. One `switch` per family, exhaustive: adding a new
 * diffId is a compile error until the case exists. Mirrors chart/table.
 */
export async function fetchDiffSnapshot(
  diffId: DiffId,
  config: OpsConfig,
  deps: DiffSnapshotDeps,
): Promise<DiffSnapshot> {
  switch (diffId) {
    case 'retro-proposals':
      return fetchRetroProposalsSnapshot(config, deps)
    default: {
      const _exhaustive: never = diffId
      throw new Error(`unhandled diffId: ${String(_exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub row types (only the fields we use)
// ---------------------------------------------------------------------------

interface GhPr {
  number: number
  title: string
  html_url: string
  user?: { login?: string }
  head?: { ref?: string }
  created_at?: string
  draft?: boolean
}

interface GhFile {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
  previous_filename?: string
}

// ---------------------------------------------------------------------------
// Retro proposals
// ---------------------------------------------------------------------------

async function fetchRetroProposalsSnapshot(
  config: OpsConfig,
  deps: DiffSnapshotDeps,
): Promise<DiffSnapshot> {
  const brain = config.brainRepo
  const asOf = (deps.now?.() ?? new Date()).toISOString()
  const drillIn = {
    label: 'Open retro PRs on GitHub',
    href: `https://github.com/${brain.repo}/pulls?q=is%3Apr+is%3Aopen+head%3Aretro%2F`,
  }
  const empty = (state: 'empty' | 'unavailable', error?: string): DiffSnapshot => ({
    diffId: 'retro-proposals',
    zone: brain.zone,
    title: 'Retro proposals',
    caption:
      `Open PRs on ${brain.repo} whose head branch starts with retro/ and ` +
      `whose files sit under skills/, policies/, or templates/. ` +
      `Merging a PR is the approval — the cockpit reads, GitHub decides.`,
    prs: [],
    state,
    error,
    drillIn,
    asOf,
  })

  let pulls: GhPr[]
  try {
    pulls = await opsGithubJson<GhPr[]>({
      path: `/repos/${brain.repo}/pulls?state=open&per_page=50&sort=created&direction=desc`,
      token: deps.token,
      fetchImpl: deps.fetchImpl,
    })
  } catch (err) {
    logger.error({ err, repo: brain.repo }, 'GET /repos/.../pulls failed')
    const message =
      err instanceof OpsGitHubError
        ? `GitHub ${err.status}: could not list retro proposals`
        : err instanceof Error
          ? err.message
          : 'could not list retro proposals'
    return empty('unavailable', message)
  }

  // Filter by branch first (cheap), then fetch files for the survivors and
  // apply the path filter (expensive: one API call per PR). Doing it in this
  // order means a hundred-PR repo with two retro branches costs two file
  // calls, not one hundred.
  const branchCandidates = pulls.filter(pr => !pr.draft && isRetroBranch(pr.head?.ref ?? ''))
  const overflow = branchCandidates.length > MAX_PRS
  const trimmed = branchCandidates.slice(0, MAX_PRS)

  const prs: DiffPr[] = []
  for (const pr of trimmed) {
    try {
      const ghFiles = await opsGithubJson<GhFile[]>({
        path: `/repos/${brain.repo}/pulls/${pr.number}/files?per_page=${MAX_FILES}`,
        token: deps.token,
        fetchImpl: deps.fetchImpl,
      })
      const paths = ghFiles.map(f => String(f.filename || ''))
      if (!allPathsInRetroScope(paths)) {
        logger.info(
          { repo: brain.repo, pr: pr.number, paths },
          'retro-proposals: PR skipped, files outside retro scope',
        )
        continue
      }
      const files: DiffFile[] = ghFiles.map(f => ({
        path: String(f.filename),
        status: normaliseFileStatus(String(f.status || '')),
        additions: Number.isFinite(f.additions) ? Number(f.additions) : 0,
        deletions: Number.isFinite(f.deletions) ? Number(f.deletions) : 0,
        patch: typeof f.patch === 'string' ? f.patch : null,
        // GitHub omits `patch` when the file exceeds its size threshold.
        // Distinguish "no textual change" (patch === '') from "too big to
        // fit in the response" (patch missing) so the panel can say so.
        patchTruncated: typeof f.patch !== 'string',
        previousFilename: f.previous_filename ? String(f.previous_filename) : undefined,
      }))
      prs.push({
        number: pr.number,
        title: String(pr.title || ''),
        url: String(pr.html_url || ''),
        author: String(pr.user?.login || 'unknown'),
        branch: String(pr.head?.ref || ''),
        createdAt: String(pr.created_at || ''),
        files,
        // We asked for MAX_FILES; if we got exactly that many, GitHub may
        // have more. Surface it rather than hide it. (An exact-match false
        // positive is fine here — the truthful signal is "there may be
        // more you cannot see," and the fix is to click through.)
        filesTruncated: ghFiles.length >= MAX_FILES,
      })
    } catch (err) {
      logger.error(
        { err, repo: brain.repo, pr: pr.number },
        'GET /repos/.../pulls/:n/files failed',
      )
      // One bad PR shouldn't take the panel down. Surface the failure
      // inline as a stub entry so the reviewer knows a PR exists we
      // couldn't read — silently dropping it would look like "clean."
      prs.push({
        number: pr.number,
        title: String(pr.title || ''),
        url: String(pr.html_url || ''),
        author: String(pr.user?.login || 'unknown'),
        branch: String(pr.head?.ref || ''),
        createdAt: String(pr.created_at || ''),
        files: [],
        filesTruncated: false,
      })
    }
  }

  if (prs.length === 0) {
    return empty('empty')
  }

  return {
    diffId: 'retro-proposals',
    zone: brain.zone,
    title: 'Retro proposals',
    caption:
      `Open PRs on ${brain.repo} whose head branch starts with retro/ and ` +
      `whose files sit under skills/, policies/, or templates/. ` +
      `Merging a PR is the approval — the cockpit reads, GitHub decides.` +
      (overflow ? ` More than ${MAX_PRS} PRs match; showing the ${MAX_PRS} newest.` : ''),
    prs,
    state: 'configured',
    drillIn,
    asOf,
  }
}

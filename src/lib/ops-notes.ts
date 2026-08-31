/**
 * Note panel data access — list, read, and propose edits to wiki pages.
 *
 * Git markdown is the only source of truth: panels READ from git and every edit
 * becomes a pull request. There is no write to main and no database copy of page
 * content that could diverge from the repo.
 */

import { logger } from '@/lib/logger'
import { opsGithubJson, type FetchImpl } from '@/lib/ops-github'
import type { OpsRepoRef } from '@/lib/ops-config'
import type { Zone } from '@/lib/ops-registry'

/** Directories whose markdown the note panel will list, per zone. */
export const BRAIN_PAGE_PREFIXES = ['wiki/', 'policies/', 'checklists/', 'architecture/', 'evals/']
export const CLIENT_PAGE_PREFIXES = ['wiki/']

export const COCKPIT_BRANCH_PREFIX = 'cockpit/edit-'

export function allowedPrefixes(ref: OpsRepoRef): string[] {
  return ref.zone === 'z0' ? BRAIN_PAGE_PREFIXES : CLIENT_PAGE_PREFIXES
}

/**
 * A page path is acceptable when it is a relative markdown path under one of the
 * repo's allowed prefixes. Rejects traversal, absolute paths and non-markdown.
 */
export function isAllowedPagePath(ref: OpsRepoRef, path: string): boolean {
  const p = String(path || '')
  if (!p || p.startsWith('/') || p.includes('..') || p.includes('\\')) return false
  if (!/^[A-Za-z0-9._/-]+\.md$/.test(p)) return false
  return allowedPrefixes(ref).some(prefix => p.startsWith(prefix))
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export interface OpsFrontmatter {
  type?: string
  title?: string
  owner_role?: string
  client?: string
  created_at?: string
  updated_at?: string
  confidence?: string
  review_after?: string
  status?: string
  sources?: string[]
  [key: string]: string | string[] | undefined
}

export interface ParsedNote {
  frontmatter: OpsFrontmatter
  body: string
  /** True when the frontmatter block is absent or unparseable. */
  malformed: boolean
  warnings: string[]
}

function unquote(value: string): string {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * Parse a markdown page into frontmatter + body.
 *
 * Handles the YAML subset these repos actually use: `key: value` scalars and
 * `- item` sequences. Anything else is reported as a warning and the page is
 * flagged malformed — a malformed page still renders, it just says so.
 */
export function parseNote(raw: string): ParsedNote {
  const text = String(raw ?? '')
  const warnings: string[] = []

  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return {
      frontmatter: {},
      body: text,
      malformed: true,
      warnings: ['no frontmatter block: page does not start with ---'],
    }
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) {
    return {
      frontmatter: {},
      body: text,
      malformed: true,
      warnings: ['unterminated frontmatter block: no closing ---'],
    }
  }

  const frontmatter: OpsFrontmatter = {}
  let lastListKey: string | null = null
  let malformed = false

  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue

    const listMatch = /^\s*-\s+(.*)$/.exec(line)
    if (listMatch) {
      if (!lastListKey) {
        malformed = true
        warnings.push(`list item with no key: ${line.trim()}`)
        continue
      }
      const current = frontmatter[lastListKey]
      const arr = Array.isArray(current) ? current : []
      arr.push(unquote(listMatch[1]))
      frontmatter[lastListKey] = arr
      continue
    }

    const kvMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kvMatch) {
      malformed = true
      warnings.push(`unparsed frontmatter line: ${line.trim().slice(0, 80)}`)
      continue
    }
    const [, key, rawValue] = kvMatch
    const value = rawValue.trim()
    if (!value) {
      // Either an empty scalar or the header of a `- item` sequence.
      frontmatter[key] = []
      lastListKey = key
      continue
    }
    frontmatter[key] = unquote(value)
    lastListKey = null
  }

  return {
    frontmatter,
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''),
    malformed,
    warnings,
  }
}

export type ReviewState = 'ok' | 'due-soon' | 'overdue' | 'missing' | 'invalid'

export interface ReviewStatus {
  state: ReviewState
  /** Days past `review_after`; negative when still in the future. */
  daysOverdue: number | null
}

const DAY_MS = 86_400_000

/** Whether a page's `review_after` date has passed. Highlighted in the UI. */
export function reviewStatus(frontmatter: OpsFrontmatter, nowMs: number = Date.now()): ReviewStatus {
  const raw = frontmatter.review_after
  if (typeof raw !== 'string' || !raw.trim()) return { state: 'missing', daysOverdue: null }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return { state: 'invalid', daysOverdue: null }
  const parsed = Date.parse(`${raw.trim()}T00:00:00Z`)
  if (Number.isNaN(parsed)) return { state: 'invalid', daysOverdue: null }
  const days = Math.floor((nowMs - parsed) / DAY_MS)
  if (days >= 0) return { state: 'overdue', daysOverdue: days }
  if (days >= -14) return { state: 'due-soon', daysOverdue: days }
  return { state: 'ok', daysOverdue: days }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface OpsPageSummary {
  repo: string
  zone: Zone
  path: string
  /** Leaf name without the .md extension. */
  name: string
  /** Top-level directory, used for grouping in the list. */
  section: string
}

interface GitTreeResponse {
  tree?: Array<{ path?: string; type?: string }>
  truncated?: boolean
}

export async function listPages(
  ref: OpsRepoRef,
  deps: { token: string; fetchImpl?: FetchImpl },
): Promise<OpsPageSummary[]> {
  const tree = await opsGithubJson<GitTreeResponse>({
    path: `/repos/${ref.repo}/git/trees/HEAD?recursive=1`,
    token: deps.token,
    fetchImpl: deps.fetchImpl,
  })

  return (tree.tree ?? [])
    .filter(entry => entry.type === 'blob' && typeof entry.path === 'string')
    .map(entry => entry.path as string)
    .filter(path => isAllowedPagePath(ref, path))
    .sort((a, b) => a.localeCompare(b))
    .map(path => ({
      repo: ref.repo,
      zone: ref.zone,
      path,
      name: (path.split('/').pop() ?? path).replace(/\.md$/i, ''),
      section: path.split('/')[0] ?? '',
    }))
}

export interface OpsPage extends OpsPageSummary {
  raw: string
  body: string
  frontmatter: OpsFrontmatter
  malformed: boolean
  warnings: string[]
  review: ReviewStatus
  /** Blob sha, required to update the file on a branch. */
  sha: string
  htmlUrl: string
}

interface ContentsResponse {
  content?: string
  encoding?: string
  sha?: string
  html_url?: string
}

export async function fetchPage(
  ref: OpsRepoRef,
  path: string,
  deps: { token: string; fetchImpl?: FetchImpl; nowMs?: number },
): Promise<OpsPage> {
  if (!isAllowedPagePath(ref, path)) {
    throw new Error(`path is not a readable page for ${ref.repo}: ${path}`)
  }
  const file = await opsGithubJson<ContentsResponse>({
    path: `/repos/${ref.repo}/contents/${path}`,
    token: deps.token,
    fetchImpl: deps.fetchImpl,
  })
  const raw = file.encoding === 'base64' && file.content
    ? Buffer.from(file.content, 'base64').toString('utf8')
    : String(file.content ?? '')

  const parsed = parseNote(raw)
  return {
    repo: ref.repo,
    zone: ref.zone,
    path,
    name: (path.split('/').pop() ?? path).replace(/\.md$/i, ''),
    section: path.split('/')[0] ?? '',
    raw,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    malformed: parsed.malformed,
    warnings: parsed.warnings,
    review: reviewStatus(parsed.frontmatter, deps.nowMs ?? Date.now()),
    sha: String(file.sha ?? ''),
    htmlUrl: String(file.html_url ?? ''),
  }
}

// ---------------------------------------------------------------------------
// Edit → PR (T1: reversible, logged)
// ---------------------------------------------------------------------------

export function editBranchName(path: string, nowMs: number = Date.now()): string {
  const slug = path
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'page'
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${COCKPIT_BRANCH_PREFIX}${slug}-${stamp}`
}

export interface ProposeEditInput {
  ref: OpsRepoRef
  path: string
  /** Full replacement markdown, as edited in the panel. */
  content: string
  /** Blob sha the edit was based on, for optimistic concurrency. */
  sha: string
  /** Who is proposing, for the PR body. */
  actor?: string
  summary?: string
}

export interface ProposeEditResult {
  prUrl: string
  prNumber: number
  branch: string
  base: string
}

/**
 * Open a PR with an edited page. Creates a `cockpit/edit-*` branch off the
 * repo's default branch, commits the file there, and opens the PR. It never
 * commits to the default branch — that is asserted before every write.
 */
export async function proposeEdit(
  input: ProposeEditInput,
  deps: { token: string; fetchImpl?: FetchImpl; nowMs?: number },
): Promise<ProposeEditResult> {
  const { ref, path, content, sha } = input
  if (!isAllowedPagePath(ref, path)) {
    throw new Error(`path is not an editable page for ${ref.repo}: ${path}`)
  }
  if (!content.trim()) throw new Error('refusing to propose an empty page')
  if (!sha) throw new Error('missing base blob sha; reload the page before editing')

  const token = deps.token
  const fetchImpl = deps.fetchImpl

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

  const branch = editBranchName(path, deps.nowMs ?? Date.now())
  // Guard: the write target must be a fresh cockpit branch, never the base.
  if (branch === base || !branch.startsWith(COCKPIT_BRANCH_PREFIX)) {
    throw new Error(`refusing to write outside a ${COCKPIT_BRANCH_PREFIX}* branch`)
  }

  await opsGithubJson<unknown>({
    path: `/repos/${ref.repo}/git/refs`,
    token,
    fetchImpl,
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
  })

  const title = `cockpit: edit ${path}`
  await opsGithubJson<unknown>({
    path: `/repos/${ref.repo}/contents/${path}`,
    token,
    fetchImpl,
    method: 'PUT',
    body: {
      message: `${title}\n\nProposed from the Mission Control cockpit note panel.`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha,
      branch,
    },
  })

  const bodyLines = [
    'Proposed from the **Mission Control cockpit** note panel (edit → PR).',
    '',
    `- page: \`${path}\``,
    `- repo zone: \`${ref.zone}\``,
    `- base blob sha: \`${sha}\``,
    input.actor ? `- proposed by: ${input.actor}` : null,
    input.summary ? `\n${input.summary}` : null,
    '',
    'Git markdown is the source of truth, so the cockpit cannot write to',
    `\`${base}\` — review and merge this PR to apply the edit.`,
  ].filter((l): l is string => l !== null)

  const pr = await opsGithubJson<{ html_url?: string; number?: number }>({
    path: `/repos/${ref.repo}/pulls`,
    token,
    fetchImpl,
    method: 'POST',
    body: { title, head: branch, base, body: bodyLines.join('\n') },
  })

  logger.info({ repo: ref.repo, path, branch, base, pr: pr.number }, 'cockpit note edit proposed as PR')

  return {
    prUrl: String(pr.html_url ?? ''),
    prNumber: Number(pr.number ?? 0),
    branch,
    base,
  }
}

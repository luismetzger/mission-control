/**
 * Run timeline data access — the read-only ledger view.
 *
 * policies/run-ledger.md defines the ledger as the union of traces jobs already
 * leave, so this assembles exactly those three, per repo: GitHub Actions runs,
 * open automation PRs, and `log.md` entries. Nothing is written and nothing is
 * cached.
 */

import { opsGithubJson, OpsGitHubError, type FetchImpl } from '@/lib/ops-github'
import type { OpsRepoRef } from '@/lib/ops-config'
import type { Zone } from '@/lib/ops-registry'

/** Branch prefixes the automation opens PRs from (policies/run-ledger.md). */
export const AUTOMATION_BRANCH_PREFIXES = [
  'compile/',
  'log/',
  'policy/',
  'auth/',
  'infra/',
  'ops/',
  'cockpit/',
]

/** A Computer-authored PR open longer than this is flagged as stalled. */
export const STALE_PR_DAYS = 7

/** Floor for auto-refresh: no polling loop tighter than 60s. */
export const MIN_REFRESH_MS = 60_000

export const DEFAULT_RUN_LIMIT = 20
export const DEFAULT_LOG_LIMIT = 15

const DAY_MS = 86_400_000

export interface TimelineRun {
  repo: string
  zone: Zone
  id: number
  name: string
  branch: string
  status: string
  conclusion: string | null
  /** True for any completed run that did not succeed. Rendered as a failure. */
  failed: boolean
  createdAt: string
  htmlUrl: string
}

export interface TimelinePull {
  repo: string
  zone: Zone
  number: number
  title: string
  branch: string
  author: string
  createdAt: string
  ageDays: number
  /** ageDays > STALE_PR_DAYS — a stalled approval per the run ledger. */
  stalled: boolean
  htmlUrl: string
}

export interface TimelineLogEntry {
  repo: string
  zone: Zone
  date: string
  who: string
  what: string
  why: string | null
  source: string | null
}

export interface TimelineRepoResult {
  repo: string
  zone: Zone
  runs: TimelineRun[]
  pulls: TimelinePull[]
  logEntries: TimelineLogEntry[]
  /** Per-source failures, so one broken read does not blank the whole view. */
  errors: string[]
}

export interface Timeline {
  repos: TimelineRepoResult[]
  runs: TimelineRun[]
  pulls: TimelinePull[]
  logEntries: TimelineLogEntry[]
  errors: string[]
  generatedAt: string
}

export function isAutomationBranch(branch: string): boolean {
  return AUTOMATION_BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix))
}

export function ageInDays(iso: string, nowMs: number): number {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return 0
  return Math.floor((nowMs - parsed) / DAY_MS)
}

// ---------------------------------------------------------------------------
// log.md
// ---------------------------------------------------------------------------

/**
 * Parse `log.md` bullets of the form
 *   `- 2026-08-30 — who — what — why: … — source: …`
 * into structured entries. `why:`/`source:` markers are optional; without them
 * the trailing segment is treated as the source, which is how older entries in
 * the brain repo are written.
 */
export function parseLogEntries(
  markdown: string,
  ctx: { repo: string; zone: Zone; limit?: number },
): TimelineLogEntry[] {
  const limit = ctx.limit ?? DEFAULT_LOG_LIMIT
  const entries: TimelineLogEntry[] = []

  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.*)$/.exec(line)
    if (!match) continue
    const [, date, rest] = match

    const segments = rest.split(/\s+—\s+/).map(s => s.trim()).filter(Boolean)
    const who = segments.shift() ?? ''

    let why: string | null = null
    let source: string | null = null
    const whatParts: string[] = []
    for (const segment of segments) {
      if (/^why:\s*/i.test(segment)) {
        why = segment.replace(/^why:\s*/i, '').trim()
      } else if (/^source:\s*/i.test(segment)) {
        source = segment.replace(/^source:\s*/i, '').trim()
      } else {
        whatParts.push(segment)
      }
    }
    // Older entries end with a bare source segment and carry no `source:` label.
    if (!source && whatParts.length > 1) source = whatParts.pop() ?? null

    entries.push({
      repo: ctx.repo,
      zone: ctx.zone,
      date,
      who,
      what: whatParts.join(' — '),
      why,
      source,
    })
    if (entries.length >= limit) break
  }

  return entries
}

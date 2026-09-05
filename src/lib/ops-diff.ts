/**
 * Diff panel kinds and their pure helpers (build-plan 2.2g).
 *
 * The diff viewer renders proposed changes as a list of PRs with per-file
 * unified patches. Registry kind: `diff-panel`. Same one-kind-many-instances
 * shape as chart (2.2e) and table (2.2h) — the `diffId` is a prop, not a
 * kind, because every diff has the same contract: read-only, one deep link
 * to the PR on GitHub, no in-panel merge.
 *
 * ### Why the panel is read-only
 *
 * The doctrine is unchanged from `architecture/04` §2: "T3 actions never
 * render as one-click optimistic buttons; they open the full approval card
 * with read-back." Merging a proposed skill/policy/template change **is**
 * the approval, and the cockpit has no write access to a default branch —
 * it *cannot* merge from here even if the UI said it could. So the panel
 * doesn't pretend: every action link opens the PR on GitHub, where merging
 * is a human typing something.
 *
 * ### Why the first diffId is `retro-proposals`
 *
 * 2.2g exists because step 3.2 (the weekly retro job) will start proposing
 * skill/policy/template changes as PRs, and those need a review surface
 * that shows the actual diff — not a title and a "go to GitHub" link.
 * `retro-proposals` filters the brain repo's open PRs to the ones an
 * automated retro job would open: branches under `retro/` or authored by
 * the Computer identity, on paths the retro job is allowed to touch
 * (skills/, policies/, templates/). That path filter is on purpose: if a
 * PR touches an unrelated path, it isn't a retro proposal, it's a compile
 * PR or something else, and it belongs in a different surface.
 *
 * ### The patch stays whole
 *
 * GitHub returns each file's unified diff as an opaque string. The panel
 * renders it verbatim — no re-tokenising, no syntax highlighting. Reasons:
 * (1) the diff is what a reviewer approves, not a prettified version of it,
 * so any transformation is a lie; (2) the same diff renders in Obsidian and
 * on GitHub already, and this panel matches that; (3) a very large file
 * (renamed skill, generated fixture) is truncated by GitHub to keep the
 * response under ~1MB — the panel surfaces that state explicitly instead of
 * silently showing an incomplete patch.
 *
 * All types here are safe to import in both client and server code. The
 * fetch helpers live in `ops-diff-sources.ts`.
 */

import type { Zone } from '@/lib/ops-registry'

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/** The set of diff ids the registry knows about today. Adding another is a
 * new entry here + a fetcher case in `ops-diff-sources.ts` + one line in
 * `register.tsx` — no new kind, no new route. */
export type DiffId = 'retro-proposals'

export const DIFF_IDS: readonly DiffId[] = ['retro-proposals']

export function isDiffId(v: string): v is DiffId {
  return (DIFF_IDS as readonly string[]).includes(v)
}

/**
 * A file's status inside a PR. This mirrors GitHub's `PullRequestFile.status`
 * closed set (they document six values). The panel colours the header by
 * status; unknown values fall back to `changed` rather than crashing the
 * render.
 */
export type DiffFileStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'renamed'
  | 'copied'
  | 'changed'

export const DIFF_FILE_STATUSES: readonly DiffFileStatus[] = [
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
]

export function normaliseFileStatus(v: string): DiffFileStatus {
  return (DIFF_FILE_STATUSES as readonly string[]).includes(v)
    ? (v as DiffFileStatus)
    : 'changed'
}

/**
 * One file inside a PR. `patch` is the raw unified diff as GitHub returns
 * it; `patchTruncated` is `true` when the API omitted the patch because the
 * file is over its size limit — the panel surfaces that state rather than
 * rendering an empty patch as "no changes".
 *
 * `previousFilename` is only set for renames/copies. Rendering the old path
 * alongside the new one is the whole point of showing a rename as such.
 */
export interface DiffFile {
  path: string
  status: DiffFileStatus
  additions: number
  deletions: number
  patch: string | null
  patchTruncated: boolean
  previousFilename?: string
}

/**
 * One proposed change. `filesTruncated` is `true` when the PR has more files
 * than the panel's per-PR cap; the reviewer needs to know that "5 files"
 * isn't the whole story. Same reason as `patchTruncated`.
 */
export interface DiffPr {
  number: number
  title: string
  url: string
  author: string
  branch: string
  createdAt: string
  files: DiffFile[]
  filesTruncated: boolean
}

/**
 * The rendered shape the diff panel consumes.
 *
 * `state` mirrors chart and table:
 *   - `configured`: at least one PR came back.
 *   - `empty`: the query ran fine, but no PR matched the filter today. This
 *     is the expected steady state before the retro job ships in 3.2 —
 *     "nothing to review" is a valid answer, not an error.
 *   - `unavailable`: the read itself failed (auth, network, 5xx). The panel
 *     renders a destructive banner and does not fabricate an empty list —
 *     a broken read is not the same as a clean queue.
 */
export interface DiffSnapshot {
  diffId: DiffId
  zone: Zone
  title: string
  /** Short caption above the list; names the filter and the source. */
  caption: string
  prs: DiffPr[]
  state: 'configured' | 'empty' | 'unavailable'
  error?: string
  /** Deep link to the source list on GitHub — the panel is the reader; the
   * decision surface is over there. */
  drillIn: { label: string; href: string }
  /** ISO timestamp of when the snapshot was fetched. */
  asOf: string
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The set of top-level paths a retro-job PR is allowed to touch. A PR that
 * changes anything outside this set is not a retro proposal; it might be a
 * compile PR, an infra change, or a mis-labelled branch, and it belongs on
 * a different surface than the diff viewer.
 *
 * Kept narrow on purpose. Widening this list is a policy decision, not a
 * cleanup — anything a retro job can rewrite is by definition something an
 * automated agent can rewrite, so the door has to be small.
 */
export const RETRO_PATH_PREFIXES: readonly string[] = [
  'skills/',
  'policies/',
  'templates/',
] as const

/**
 * The branch prefixes a retro-job PR uses. `retro/` is the primary. The
 * daily watchdog also treats agent-authored PRs on branches with automation
 * prefixes (`compile/`, `log/`, `policy/`, `auth/`, `infra/`) as
 * agent-generated, but only `retro/` is a *retro proposal* — the others are
 * compile jobs, log entries, and infra changes that already have their own
 * review paths.
 */
export const RETRO_BRANCH_PREFIXES: readonly string[] = ['retro/'] as const

/**
 * True when a branch name looks like a retro-job branch. Case-sensitive: the
 * automation writes lowercase, and matching an uppercase variant would let a
 * hand-created `Retro/…` branch sneak in without the retro job's evals having
 * approved it.
 */
export function isRetroBranch(branch: string): boolean {
  const b = String(branch || '')
  return RETRO_BRANCH_PREFIXES.some(p => b.startsWith(p))
}

/**
 * True when every changed path in a PR sits under one of the retro path
 * prefixes. A single out-of-scope file disqualifies the PR — the retro job
 * is supposed to touch skills/policies/templates and nothing else, and a
 * mixed PR is a signal that something went off-script.
 *
 * An empty `paths` list returns `false`: a PR with zero changed files isn't
 * a retro proposal (it isn't a proposal at all), and treating "no files" as
 * "all files match" would silently accept an empty-change PR into the
 * review surface.
 */
export function allPathsInRetroScope(paths: readonly string[]): boolean {
  if (paths.length === 0) return false
  return paths.every(p =>
    RETRO_PATH_PREFIXES.some(prefix => p.startsWith(prefix)),
  )
}

/**
 * Sum the +/- line counts across a PR's files. Rendered under the PR title
 * as the "size" of the proposal. A PR whose files were all truncated for
 * size still has honest totals from GitHub's own count — the truncation is
 * of the patch text, not of the statistics.
 */
export function sumChangeStats(files: readonly DiffFile[]): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const f of files) {
    if (Number.isFinite(f.additions)) additions += f.additions
    if (Number.isFinite(f.deletions)) deletions += f.deletions
  }
  return { additions, deletions }
}

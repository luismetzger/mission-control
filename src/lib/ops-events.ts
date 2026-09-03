/**
 * Ops event model — the Tier-1 audio feedback layer's source of truth.
 *
 * `architecture/02` §Audio feedback design asks for "short distinct cues plus a
 * one-sentence spoken line on state transitions that matter (approval
 * requested, task complete, blocker, budget threshold)". The operative word is
 * *transitions*. The ops panels read GitHub on demand from the browser, so
 * nothing in the cockpit knows that a thing has *changed* — only what it is
 * now. This module supplies the missing half: a snapshot shape, and a pure
 * diff over two snapshots that yields the transitions worth making a noise
 * about.
 *
 * Everything here is pure. The polling, the network and the emitting live in
 * `ops-event-source.ts`, so the interesting logic can be tested without a
 * fixture GitHub.
 *
 * Two decisions are load-bearing and easy to get wrong later:
 *
 * 1. **A diff against nothing is not a transition.** On a cold start the
 *    cockpit has no previous snapshot, so *every* open approval and *every*
 *    failing run looks new. Announcing them would mean a burst of alarms on
 *    every deploy, which trains you to mute the thing. `diffSnapshots` returns
 *    no events when the previous snapshot is null, and the caller seeds
 *    silently. See `SEEDED`.
 *
 * 2. **Silence must be meaningful.** An event stream that speaks on every poll
 *    is noise, and noise gets muted, and a muted alerter is worse than none
 *    because you believe you are covered. Only genuine edges emit: a queue
 *    entry that appeared, a run that went from passing to failing, a threshold
 *    crossed *this* poll. Steady state is silent.
 */

import type { Zone } from '@/lib/ops-registry'

/**
 * Cue classes. Each maps to a distinct tone signature in the client so the
 * sound alone carries the meaning — the point of an audio cue is that you do
 * not have to look at the screen to know roughly what happened.
 *
 * Deliberately few. Twelve subtly different chimes are indistinguishable in
 * practice, so this stays at the four transitions the architecture names plus
 * `info` for everything that is worth a line but not a noise.
 */
export const CUE_KINDS = ['approval', 'blocker', 'complete', 'budget', 'info'] as const
export type CueKind = (typeof CUE_KINDS)[number]

/** Louder than `notice`; used to decide what survives "important only" mode. */
export type Severity = 'notice' | 'alert'

/**
 * An ops event, shaped after the AG-UI event model (a typed `type`, a stable
 * id, a timestamp, and a payload) so the stream can graduate to the real
 * protocol without the panels changing.
 */
export interface OpsEvent {
  /** Stable across re-emission of the same transition, so clients can dedupe. */
  id: string
  type: `ops.${string}`
  cue: CueKind
  severity: Severity
  /** One sentence, already redacted, suitable for reading aloud verbatim. */
  line: string
  zone: Zone
  /** Where to go to act on it, when there is somewhere. */
  href?: string
  timestamp: number
}

/** What one poll of the ops sources looks like, reduced to what cues need. */
export interface OpsSnapshot {
  /** Pending approval requests, keyed by repo path. */
  approvals: SnapshotApproval[]
  /** Most recent completed CI run per repo+workflow. */
  runs: SnapshotRun[]
  /** Month-to-date spend as a fraction of the envelope, or null when unknown. */
  budgetFraction: number | null
  takenAt: number
}

export interface SnapshotApproval {
  path: string
  title: string
  /** 'ok' | 'due-soon' | 'expired' | 'missing' | 'invalid' from ops-queue. */
  expiryState: string
  daysLeft: number | null
}

export interface SnapshotRun {
  /** repo + workflow + branch; identifies the *series*, not the run. */
  key: string
  repo: string
  workflow: string
  /** 'success' | 'failure' | 'cancelled' | ... */
  conclusion: string
  htmlUrl: string
  zone: Zone
}

/** Budget thresholds that are worth interrupting for, per `policies/budgets.md`. */
export const BUDGET_THRESHOLDS = [0.5, 0.8, 1.0] as const

/**
 * Returned instead of events when there was no previous snapshot. The caller
 * stores the snapshot and says nothing.
 */
export const SEEDED: readonly OpsEvent[] = Object.freeze([])

/**
 * Redact anything that must not be spoken aloud or streamed to a client.
 *
 * Rule 9 forbids PII and secrets in the wikis; a spoken line is a *worse*
 * place for them than a wiki, because it leaves the machine as sound in a room
 * that may contain other people. Titles come from markdown we control, so this
 * is a backstop rather than the primary defence — but a backstop that never
 * fires is indistinguishable from one that does not exist, so it is tested.
 */
export function redactLine(text: string): string {
  return text
    // Email addresses — the specific thing rule 9 names.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted]')
    // Long digit runs: QuickBooks customer ids, account numbers, card numbers.
    .replace(/\b\d{9,}\b/g, '[redacted]')
    // Anything shaped like a live key.
    // {16,} rather than {16}: a real key id is AKIA plus exactly 16, but a
    // redactor that misses a 17-character lookalike has failed open, and
    // over-redacting a spoken sentence costs nothing.
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16,}/g, '[redacted]')
    .replace(/\b(?:ghp|gho|ghs|github_pat|sk|lf|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gi, '[redacted]')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Cap a spoken line so a pathological title cannot monopolise the voice. */
export const MAX_LINE_CHARS = 180

function line(text: string): string {
  const clean = redactLine(text)
  return clean.length <= MAX_LINE_CHARS ? clean : `${clean.slice(0, MAX_LINE_CHARS - 1)}…`
}

/**
 * The transitions between two snapshots, as events.
 *
 * Returns `SEEDED` (empty) when `previous` is null — see the module note. This
 * is the single most important line in the file: without it, every restart of
 * the cockpit announces the entire backlog as though it had just happened.
 */
export function diffSnapshots(
  previous: OpsSnapshot | null,
  next: OpsSnapshot,
): OpsEvent[] {
  if (previous === null) return [...SEEDED]

  const events: OpsEvent[] = []
  const at = next.takenAt

  // --- Approvals -----------------------------------------------------------
  const before = new Map(previous.approvals.map((a) => [a.path, a]))

  for (const approval of next.approvals) {
    const prior = before.get(approval.path)

    if (!prior) {
      events.push({
        id: `approval-new:${approval.path}`,
        type: 'ops.approval.requested',
        cue: 'approval',
        severity: 'alert',
        line: line(`Approval requested: ${approval.title}.`),
        zone: 'z0',
        href: '/ops-approvals',
        timestamp: at,
      })
      continue
    }

    // Edges only. A request that was already expiring yesterday is not news
    // today; a request that crossed into expiring since the last poll is.
    if (prior.expiryState !== 'expired' && approval.expiryState === 'expired') {
      events.push({
        id: `approval-expired:${approval.path}`,
        type: 'ops.approval.expired',
        cue: 'blocker',
        severity: 'alert',
        line: line(
          `Approval expired without a decision: ${approval.title}. Silence is denial, and it now fails the wiki gate on every build.`,
        ),
        zone: 'z0',
        href: '/ops-approvals',
        timestamp: at,
      })
    } else if (prior.expiryState === 'ok' && approval.expiryState === 'due-soon') {
      const days = approval.daysLeft
      events.push({
        id: `approval-due:${approval.path}`,
        type: 'ops.approval.due_soon',
        cue: 'approval',
        severity: 'notice',
        line: line(
          `Approval expiring ${days === null ? 'soon' : days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}: ${approval.title}.`,
        ),
        zone: 'z0',
        href: '/ops-approvals',
        timestamp: at,
      })
    }
  }

  // A request leaving the pending queue means it was decided — the one piece
  // of genuinely good news this system produces, so it gets the complete cue.
  const nextPaths = new Set(next.approvals.map((a) => a.path))
  for (const prior of previous.approvals) {
    if (!nextPaths.has(prior.path)) {
      events.push({
        id: `approval-decided:${prior.path}`,
        type: 'ops.approval.decided',
        cue: 'complete',
        severity: 'notice',
        line: line(`Approval decided and archived: ${prior.title}.`),
        zone: 'z0',
        href: '/ops-approvals',
        timestamp: at,
      })
    }
  }

  // --- CI ------------------------------------------------------------------
  const runsBefore = new Map(previous.runs.map((r) => [r.key, r]))

  for (const run of next.runs) {
    const prior = runsBefore.get(run.key)
    if (!prior) continue // First sighting of a workflow is not a transition.
    if (prior.conclusion === run.conclusion) continue

    const wasGreen = prior.conclusion === 'success'
    const isGreen = run.conclusion === 'success'

    if (wasGreen && !isGreen) {
      events.push({
        id: `ci-broke:${run.key}:${run.conclusion}`,
        type: 'ops.ci.failed',
        cue: 'blocker',
        severity: 'alert',
        line: line(`${run.workflow} is failing on ${run.repo}.`),
        zone: run.zone,
        href: run.htmlUrl,
        timestamp: at,
      })
    } else if (!wasGreen && isGreen) {
      events.push({
        id: `ci-fixed:${run.key}`,
        type: 'ops.ci.recovered',
        cue: 'complete',
        severity: 'notice',
        line: line(`${run.workflow} is green again on ${run.repo}.`),
        zone: run.zone,
        href: run.htmlUrl,
        timestamp: at,
      })
    }
  }

  // --- Budget --------------------------------------------------------------
  events.push(...budgetEvents(previous.budgetFraction, next.budgetFraction, at))

  return events
}

/**
 * Budget threshold crossings.
 *
 * Only *upward* crossings emit, and only ones crossed since the previous
 * reading. The daily budget monitor has already been burned once by a
 * threshold check that misread its input and then went permanently silent, so
 * the rule here is deliberately dumb and local: compare two numbers, emit for
 * each threshold strictly between them.
 */
export function budgetEvents(
  previousFraction: number | null,
  nextFraction: number | null,
  at: number,
): OpsEvent[] {
  if (previousFraction === null || nextFraction === null) return []
  if (nextFraction <= previousFraction) return []

  const events: OpsEvent[] = []
  for (const threshold of BUDGET_THRESHOLDS) {
    if (previousFraction < threshold && nextFraction >= threshold) {
      const pct = Math.round(threshold * 100)
      events.push({
        id: `budget:${pct}:${new Date(at).toISOString().slice(0, 7)}`,
        type: 'ops.budget.threshold',
        cue: 'budget',
        severity: threshold >= 0.8 ? 'alert' : 'notice',
        line:
          threshold >= 1
            ? `The monthly AI envelope is spent. Non-critical scheduled jobs should pause; resuming is your call.`
            : `AI spend has passed ${pct} percent of the monthly envelope.`,
        zone: 'z0',
        href: '/runs',
        timestamp: at,
      })
    }
  }
  return events
}

/**
 * Events a client in "important only" mode should still hear.
 *
 * Presence modes in `architecture/04` §1 draw the line at critical interrupts,
 * and this is the mechanical version of that line.
 */
export function filterBySeverity(events: OpsEvent[], alertsOnly: boolean): OpsEvent[] {
  return alertsOnly ? events.filter((e) => e.severity === 'alert') : events
}

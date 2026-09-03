/**
 * The spoken morning digest.
 *
 * `architecture/02` §Audio feedback design asks for a morning digest covering
 * overnight runs, today's meetings, approvals waiting, and per-client status
 * deltas. A daily digest notification already exists as a scheduled task; this
 * is the *spoken* form, and the two differ in a way that matters.
 *
 * A notification is skimmed: you see all of it at once, in any order, and you
 * re-read the bit you care about. Speech is linear and unskippable — you cannot
 * glance at the fourth sentence. So a spoken digest has to be ruthlessly
 * ordered (worst first), short, and free of anything you cannot act on. A
 * spoken list of nine items is not a digest, it is a monologue, and you will
 * stop listening around item four, which is exactly where the important thing
 * ends up if the ordering is wrong.
 *
 * Hence: hard item cap, hard character cap, ordered by severity, and the
 * numbers stay approximate ("three approvals") because precision you cannot
 * write down is wasted breath.
 */

import { redactLine, MAX_LINE_CHARS } from '@/lib/ops-events'

export interface DigestInput {
  /** Failing CI runs since the last digest. */
  failingRuns: Array<{ repo: string; workflow: string }>
  /** Pending T3 approvals, with days left (negative once expired). */
  approvals: Array<{ title: string; daysLeft: number | null }>
  /** Today's meetings, earliest first, in the user's local time. */
  meetings: Array<{ title: string; startsAt: string }>
  /** Per-client status deltas since yesterday. */
  clientDeltas: Array<{ client: string; summary: string }>
  /** Month-to-date spend as a fraction of the envelope, when known. */
  budgetFraction: number | null
}

/** Ceiling on the whole digest. ~900 characters is about 60 seconds of speech. */
export const MAX_DIGEST_CHARS = 900

/** Beyond this many sentences nobody is still listening. */
export const MAX_DIGEST_ITEMS = 6

export interface Digest {
  /** Sentences in speaking order. */
  sentences: string[]
  /** Joined, redacted, capped — what actually gets spoken. */
  text: string
  chars: number
  /** True when items were dropped to fit the caps. */
  truncated: boolean
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Compose the digest.
 *
 * Order is the design: expired approvals, then broken CI, then approvals due,
 * then money, then the day's shape, then client deltas. Everything above the
 * cut is something that is already wrong; everything below is information.
 */
export function composeDigest(input: DigestInput, nowMs: number = Date.now()): Digest {
  const parts: string[] = []

  const greeting = greetingFor(new Date(nowMs))
  parts.push(`${greeting}.`)

  const expired = input.approvals.filter((a) => a.daysLeft !== null && a.daysLeft < 0)
  const dueSoon = input.approvals.filter(
    (a) => a.daysLeft !== null && a.daysLeft >= 0 && a.daysLeft <= 3,
  )

  // 1. Expired approvals. These are already failing the wiki gate on every
  //    build, so they are strictly worse than a pending decision and go first.
  if (expired.length > 0) {
    parts.push(
      expired.length === 1
        ? `One approval has expired without a decision — ${expired[0].title} — and it is failing the wiki gate on every build.`
        : `${plural(expired.length, 'approval', 'approvals')} have expired without a decision and are failing the wiki gate on every build.`,
    )
  }

  // 2. Broken CI.
  if (input.failingRuns.length > 0) {
    const first = input.failingRuns[0]
    parts.push(
      input.failingRuns.length === 1
        ? `${first.workflow} is failing on ${shortRepo(first.repo)}.`
        : `${plural(input.failingRuns.length, 'workflow is', 'workflows are')} failing, including ${first.workflow} on ${shortRepo(first.repo)}.`,
    )
  }

  // 3. Approvals waiting. The useful shape is "how many and how urgent", not
  //    a recital of titles — the panel has the titles.
  if (dueSoon.length > 0) {
    const soonest = Math.min(...dueSoon.map((a) => a.daysLeft ?? 0))
    parts.push(
      `${plural(dueSoon.length, 'approval', 'approvals')} waiting on you, the soonest ${soonest <= 0 ? 'expiring today' : `expiring in ${plural(soonest, 'day', 'days')}`}.`,
    )
  } else if (input.approvals.length > 0 && expired.length === 0) {
    parts.push(`${plural(input.approvals.length, 'approval', 'approvals')} waiting, none urgent.`)
  }

  // 4. Money.
  if (input.budgetFraction !== null) {
    const pct = Math.round(input.budgetFraction * 100)
    if (pct >= 80) {
      parts.push(`AI spend is at ${pct} percent of the monthly envelope.`)
    }
  }

  // 5. The day's shape. First meeting and a count is what you need before
  //    coffee; the full agenda is what the calendar is for.
  if (input.meetings.length > 0) {
    const first = input.meetings[0]
    parts.push(
      input.meetings.length === 1
        ? `One meeting today: ${first.title} at ${first.startsAt}.`
        : `${plural(input.meetings.length, 'meeting', 'meetings')} today, first is ${first.title} at ${first.startsAt}.`,
    )
  } else {
    parts.push('Nothing on the calendar today.')
  }

  // 6. Client deltas.
  for (const delta of input.clientDeltas) {
    parts.push(`${delta.client}: ${delta.summary}`)
  }

  // Nothing wrong and nothing on. Worth saying explicitly — a digest that only
  // speaks when there is bad news is a digest you cannot trust the silence of.
  if (parts.length === 2 && input.meetings.length === 0) {
    parts.push('Nothing is broken and nothing is waiting on you.')
  }

  return finalise(parts)
}

function shortRepo(repo: string): string {
  const slash = repo.lastIndexOf('/')
  return slash === -1 ? repo : repo.slice(slash + 1)
}

function greetingFor(date: Date): string {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Apply the caps.
 *
 * Truncation drops from the *end*, which is the whole reason the ordering above
 * is by severity: what gets cut is the least important thing, deterministically.
 * The greeting is never dropped, so a truncated digest still sounds like a
 * digest rather than starting mid-thought.
 */
function finalise(parts: string[]): Digest {
  let sentences = parts.map((p) => redactLine(p)).filter((p) => p.length > 0)
  let truncated = false

  if (sentences.length > MAX_DIGEST_ITEMS) {
    sentences = sentences.slice(0, MAX_DIGEST_ITEMS)
    truncated = true
  }

  let text = sentences.join(' ')
  while (text.length > MAX_DIGEST_CHARS && sentences.length > 1) {
    sentences = sentences.slice(0, -1)
    truncated = true
    text = sentences.join(' ')
  }

  // A single sentence longer than the whole budget can still happen if a client
  // delta is pathological; clamp rather than emit a five-minute utterance.
  if (text.length > MAX_DIGEST_CHARS) {
    text = `${text.slice(0, MAX_DIGEST_CHARS - 1)}…`
    truncated = true
  }

  if (truncated) {
    const suffix = ' More in the cockpit.'
    if (text.length + suffix.length <= MAX_DIGEST_CHARS) text += suffix
  }

  return { sentences, text, chars: text.length, truncated }
}

/** Re-exported so callers can cap a single line the same way cues are capped. */
export { MAX_LINE_CHARS }

/**
 * T3 approval queue — the data model behind the cockpit's approval card.
 *
 * The queue lives in the brain repo as one markdown file per request
 * (`policies/t3-queue.md`): pending in `queue/`, decided in `archive/queue/`.
 * This module is the pure half — path rules, parsing, expiry, and the
 * construction of a disposition patch. Nothing here touches the network.
 *
 * Three properties are worth stating up front, because they are the reason this
 * file exists rather than the panel just POSTing an edit through the note API:
 *
 * 1. **Z0 only.** The queue holds company decisions and their evidence, so a
 *    queue path in a client zone is a zone crossing. `isQueuePath` takes the
 *    repo ref and refuses anything that is not the brain repo.
 *
 * 2. **An expired request cannot be approved** (t3-queue.md rule 6). The wiki
 *    gate catches this at merge time; refusing it here means the cockpit never
 *    offers it, and never opens a PR that CI would have to reject.
 *
 * 3. **A disposition may not edit the request** (rule 8). The wiki gate cannot
 *    enforce that — it reads the tree, not the diff. The cockpit *can*, because
 *    it builds the diff itself: `buildDisposition` copies everything above the
 *    final `## Disposition` heading byte-for-byte and will throw if it cannot.
 *    This is the one place that rule is mechanical, so it is enforced here
 *    rather than documented as an aspiration.
 */

import type { OpsRepoRef } from '@/lib/ops-config'
import { parseNote, type OpsFrontmatter } from '@/lib/ops-notes'

export const QUEUE_DIR = 'queue'
export const QUEUE_ARCHIVE = 'archive/queue'
export const DISPOSITION_BRANCH_PREFIX = 'cockpit/disposition-'

/** `YYYY-MM-DD-<slug>.md`, matching QUEUE_NAME in the brain repo's ci/gates.py. */
const QUEUE_NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/

const DAY_MS = 86_400_000

export type Disposition = 'pending' | 'approved' | 'denied' | 'expired'

/** The dispositions a human can choose. `pending` is the absence of a choice. */
export const DECIDABLE: readonly Disposition[] = ['approved', 'denied', 'expired'] as const

export function isDecided(d: string): d is 'approved' | 'denied' | 'expired' {
  return (DECIDABLE as readonly string[]).includes(d)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * True for a well-formed queue path in the brain repo.
 *
 * The zone check is not a nicety: it is the difference between "the operator
 * mistyped a repo" and "a client zone grew an approval queue".
 */
export function isQueuePath(ref: OpsRepoRef, path: string): boolean {
  if (ref.zone !== 'z0') return false
  const p = String(path || '')
  if (!p || p.startsWith('/') || p.includes('..') || p.includes('\\')) return false
  const inQueue = p.startsWith(`${QUEUE_DIR}/`)
  const inArchive = p.startsWith(`${QUEUE_ARCHIVE}/`)
  if (!inQueue && !inArchive) return false
  const rest = inQueue ? p.slice(QUEUE_DIR.length + 1) : p.slice(QUEUE_ARCHIVE.length + 1)
  // One flat directory each. A nested queue/2026/… would sort and expire fine
  // but the gate's filename rule would never see it.
  if (rest.includes('/')) return false
  return QUEUE_NAME_RE.test(rest)
}

/** Where a decided request belongs, given where it is now. */
export function archivePathFor(path: string): string {
  if (path.startsWith(`${QUEUE_ARCHIVE}/`)) return path
  if (!path.startsWith(`${QUEUE_DIR}/`)) {
    throw new Error(`not a queue path: ${path}`)
  }
  return `${QUEUE_ARCHIVE}/${path.slice(QUEUE_DIR.length + 1)}`
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

export type ExpiryState = 'ok' | 'due-soon' | 'expired' | 'missing' | 'invalid'

export interface ExpiryStatus {
  state: ExpiryState
  /** Whole days until `expires_at`; negative once it has passed. */
  daysRemaining: number | null
  expiresAt: string | null
}

/** Inside this window the card warns and the watchdog nudges. */
export const DUE_SOON_DAYS = 3

/**
 * Expiry of a pending request. `expired` here means the wiki gate is *already*
 * failing on this file, so the card says so rather than implying it is a warning.
 */
export function expiryStatus(frontmatter: OpsFrontmatter, nowMs: number = Date.now()): ExpiryStatus {
  const raw = frontmatter.expires_at
  if (typeof raw !== 'string' || !raw.trim()) {
    return { state: 'missing', daysRemaining: null, expiresAt: null }
  }
  const value = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { state: 'invalid', daysRemaining: null, expiresAt: value }
  }
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed)) return { state: 'invalid', daysRemaining: null, expiresAt: value }

  const today = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  )
  const days = Math.round((parsed - today) / DAY_MS)
  if (days < 0) return { state: 'expired', daysRemaining: days, expiresAt: value }
  if (days <= DUE_SOON_DAYS) return { state: 'due-soon', daysRemaining: days, expiresAt: value }
  return { state: 'ok', daysRemaining: days, expiresAt: value }
}

// ---------------------------------------------------------------------------
// Parsing a request
// ---------------------------------------------------------------------------

/** The sections the card renders, in the order t3-queue.md defines them. */
export const CARD_SECTIONS = [
  'summary',
  'requested action',
  'evidence',
  'blast radius & reversibility',
  'recommendation',
] as const

export interface ApprovalSection {
  heading: string
  body: string
}

export interface ApprovalRequest {
  repo: string
  path: string
  /** Filename without the date prefix or extension. */
  slug: string
  title: string
  tier: string
  requestedBy: string
  /** Zone the *requested action* touches — not the zone of this file. */
  actionZone: string
  createdAt: string | null
  disposition: Disposition
  decidedBy: string | null
  decidedAt: string | null
  sources: string[]
  expiry: ExpiryStatus
  sections: ApprovalSection[]
  /** True when the file is in `archive/queue/`. */
  archived: boolean
  /**
   * Why this request may not be approved, or null when it may.
   *
   * Computed here rather than in the panel so the card can import types only
   * and stay free of server code, and so there is one implementation of the
   * rule rather than a UI copy that can drift from the one the API enforces.
   */
  approveRefusal: string | null
  /** Non-fatal complaints — a malformed request still renders, saying so. */
  warnings: string[]
  htmlUrl: string
}

function scalar(fm: OpsFrontmatter, key: string): string | null {
  const v = fm[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Split a body into `## ` sections, preserving their text verbatim. */
export function splitSections(body: string): ApprovalSection[] {
  const out: ApprovalSection[] = []
  let heading: string | null = null
  let buf: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (heading !== null) out.push({ heading, body: buf.join('\n').trim() })
      heading = m[1]
      buf = []
      continue
    }
    if (heading !== null) buf.push(line)
  }
  if (heading !== null) out.push({ heading, body: buf.join('\n').trim() })
  return out
}

export function parseApprovalRequest(
  input: { repo: string; path: string; raw: string; htmlUrl?: string },
  nowMs: number = Date.now(),
): ApprovalRequest {
  const parsed = parseNote(input.raw)
  const fm = parsed.frontmatter
  const warnings = [...parsed.warnings]

  const dispRaw = scalar(fm, 'disposition') ?? 'pending'
  const disposition: Disposition =
    dispRaw === 'pending' || isDecided(dispRaw) ? (dispRaw as Disposition) : 'pending'
  if (disposition !== dispRaw) warnings.push(`unrecognised disposition '${dispRaw}', treated as pending`)

  if (scalar(fm, 'type') !== 'approval') {
    warnings.push(`type is ${scalar(fm, 'type') ?? 'unset'}, expected 'approval'`)
  }
  const tier = scalar(fm, 'tier') ?? ''
  if (tier && tier !== 'T3') warnings.push(`tier is ${tier}; the queue holds T3 only`)

  const sources = Array.isArray(fm.sources)
    ? fm.sources.filter((s): s is string => typeof s === 'string')
    : []
  if (sources.length === 0) warnings.push('no sources: the request carries no evidence trail')

  const leaf = input.path.split('/').pop() ?? input.path
  const expiry = expiryStatus(fm, nowMs)
  const archived = input.path.startsWith(`${QUEUE_ARCHIVE}/`)
  return {
    repo: input.repo,
    path: input.path,
    slug: leaf.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}-/, ''),
    title: scalar(fm, 'title') ?? leaf,
    tier,
    requestedBy: scalar(fm, 'requested_by') ?? 'unknown',
    actionZone: scalar(fm, 'action_zone') ?? 'unknown',
    createdAt: scalar(fm, 'created_at'),
    disposition,
    decidedBy: scalar(fm, 'decided_by'),
    decidedAt: scalar(fm, 'decided_at'),
    sources,
    expiry,
    sections: splitSections(parsed.body),
    archived,
    approveRefusal: dispositionRefusal({ disposition, expiry, archived }, 'approved'),
    warnings,
    htmlUrl: String(input.htmlUrl ?? ''),
  }
}

/**
 * Whether a disposition is legal for this request, and why not when it is not.
 *
 * The card asks this before it offers a control, and the API asks it again
 * before it opens a PR — a disabled button is a hint, not a rule.
 */
export function dispositionRefusal(
  request: Pick<ApprovalRequest, 'disposition' | 'expiry' | 'archived'>,
  next: Disposition,
): string | null {
  if (!isDecided(next)) {
    return `${next} is not a decision — the queue is dispositioned to approved, denied or expired`
  }
  if (request.archived || isDecided(request.disposition)) {
    return `already ${request.disposition}: a decided request is terminal and is re-raised as a new file, not edited`
  }
  if (next === 'approved' && request.expiry.state === 'expired') {
    return (
      `this request expired ${Math.abs(request.expiry.daysRemaining ?? 0)}d ago ` +
      `(${request.expiry.expiresAt}) and cannot be approved. Silence is denial: ` +
      `archive it as expired, then raise it again if it still matters ` +
      `(policies/t3-queue.md rule 6)`
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Building the disposition patch
// ---------------------------------------------------------------------------

const DISPOSITION_HEADING = '## Disposition'

/** Frontmatter keys a disposition is allowed to write. Nothing else moves. */
export const DISPOSITION_KEYS = [
  'disposition',
  'status',
  'decided_by',
  'decided_at',
  'updated_at',
] as const

/**
 * Rewrite frontmatter line-by-line rather than reserialising it.
 *
 * Reserialising would reformat lines nobody asked to change, and a disposition
 * diff that also rewrites quoting is exactly the diff rule 8 forbids.
 */
function patchFrontmatter(raw: string, updates: Record<string, string>): string {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') throw new Error('request has no frontmatter block')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) throw new Error('request frontmatter is unterminated')

  const remaining = new Map(Object.entries(updates))
  const out = lines.slice(0, end).map(line => {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!m) return line
    const key = m[1]
    if (!remaining.has(key)) return line
    const value = remaining.get(key) as string
    remaining.delete(key)
    return `${key}: ${value}`
  })
  // Anything not already present is appended just above the closing ---, so a
  // request that never carried decided_by gains it rather than failing.
  for (const [key, value] of remaining) out.push(`${key}: ${value}`)
  return [...out, ...lines.slice(end)].join('\n')
}

export interface BuildDispositionInput {
  /** The file exactly as fetched. */
  raw: string
  path: string
  disposition: Disposition
  /** Who decided. The cockpit passes the authenticated identity, not a form field. */
  decidedBy: string
  /** `YYYY-MM-DD`, the decision date. */
  decidedAt: string
  /** Optional prose recorded under `## Disposition`. */
  note?: string
}

export interface BuiltDisposition {
  content: string
  archivePath: string
  /** The bytes above `## Disposition`, asserted unchanged. */
  preservedPrefix: string
}

/**
 * Produce the decided version of a request.
 *
 * Everything above the final `## Disposition` heading is copied verbatim; only
 * the frontmatter keys in DISPOSITION_KEYS and that one section change. If the
 * prefix cannot be reproduced byte-for-byte the function throws instead of
 * emitting a diff that would quietly edit the request it is deciding.
 */
export function buildDisposition(input: BuildDispositionInput): BuiltDisposition {
  const { raw, disposition, decidedBy, decidedAt } = input
  if (!isDecided(disposition)) throw new Error(`not a decision: ${disposition}`)
  if (!decidedBy.trim()) throw new Error('a decision needs a decider')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decidedAt)) {
    throw new Error(`decided_at must be YYYY-MM-DD, got ${decidedAt}`)
  }

  const withFrontmatter = patchFrontmatter(raw, {
    disposition,
    status: 'archived',
    decided_by: decidedBy.trim(),
    decided_at: decidedAt,
    updated_at: decidedAt,
  })

  const idx = withFrontmatter.lastIndexOf(`\n${DISPOSITION_HEADING}`)
  const word = disposition === 'expired' ? 'Expired' : disposition[0].toUpperCase() + disposition.slice(1)
  const section = [
    DISPOSITION_HEADING,
    '',
    `${word} by ${decidedBy.trim()} on ${decidedAt}, recorded from the Mission Control cockpit.`,
    ...(input.note?.trim() ? ['', input.note.trim()] : []),
    '',
  ].join('\n')

  let content: string
  let preservedPrefix: string
  if (idx === -1) {
    // No section to replace: append one. The request body is untouched.
    preservedPrefix = withFrontmatter.replace(/\s*$/, '')
    content = `${preservedPrefix}\n\n${section}`
  } else {
    preservedPrefix = withFrontmatter.slice(0, idx)
    content = `${preservedPrefix}\n${section}`
  }

  // Rule 8, mechanically. The prefix is the request; a disposition must not
  // touch it. Frontmatter is excluded from the comparison because the decision
  // fields live there by design.
  const bodyOf = (s: string) => s.split(/\n---\n/).slice(1).join('\n---\n')
  const originalBody = bodyOf(raw)
  const originalPrefix = (() => {
    const i = originalBody.lastIndexOf(`\n${DISPOSITION_HEADING}`)
    return i === -1 ? originalBody.replace(/\s*$/, '') : originalBody.slice(0, i)
  })()
  const newBody = bodyOf(content)
  const newPrefix = (() => {
    const i = newBody.lastIndexOf(`\n${DISPOSITION_HEADING}`)
    return i === -1 ? newBody.replace(/\s*$/, '') : newBody.slice(0, i)
  })()
  if (originalPrefix.replace(/\s*$/, '') !== newPrefix.replace(/\s*$/, '')) {
    throw new Error(
      'refusing to propose a disposition that also edits the request body ' +
        '(policies/t3-queue.md rule 8)',
    )
  }

  return { content, archivePath: archivePathFor(input.path), preservedPrefix }
}

/** Branch name for a disposition PR. Never a default branch, by construction. */
export function dispositionBranchName(path: string, nowMs: number = Date.now()): string {
  const slug =
    (path.split('/').pop() ?? path)
      .replace(/\.md$/i, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'request'
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${DISPOSITION_BRANCH_PREFIX}${slug}-${stamp}`
}

/** Pending first, soonest expiry first; decided requests sort after, newest first. */
export function sortRequests(requests: ApprovalRequest[]): ApprovalRequest[] {
  return [...requests].sort((a, b) => {
    const aPending = a.disposition === 'pending' ? 0 : 1
    const bPending = b.disposition === 'pending' ? 0 : 1
    if (aPending !== bPending) return aPending - bPending
    if (aPending === 0) {
      const ax = a.expiry.daysRemaining ?? Number.POSITIVE_INFINITY
      const bx = b.expiry.daysRemaining ?? Number.POSITIVE_INFINITY
      if (ax !== bx) return ax - bx
    }
    return (b.decidedAt ?? b.createdAt ?? '').localeCompare(a.decidedAt ?? a.createdAt ?? '')
  })
}

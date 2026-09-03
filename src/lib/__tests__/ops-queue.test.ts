/**
 * Tests for the T3 approval queue.
 *
 * These are written against the refusals rather than the happy path, because
 * the refusals are the reason this module exists and they are the paths nobody
 * exercises by accident. A check that cannot fail proves nothing, so each one
 * here is paired with the case that must still succeed.
 */
import { describe, expect, it } from 'vitest'
import type { OpsRepoRef } from '@/lib/ops-config'
import {
  DISPOSITION_BRANCH_PREFIX,
  archivePathFor,
  buildDisposition,
  dispositionBranchName,
  dispositionRefusal,
  expiryStatus,
  isQueuePath,
  parseApprovalRequest,
  sortRequests,
  splitSections,
  type ApprovalRequest,
} from '@/lib/ops-queue'

const brain: OpsRepoRef = {
  repo: 'luismetzger/metzger-creative-brain',
  zone: 'z0',
  slug: null,
  vault: null,
}
const client: OpsRepoRef = {
  repo: 'luismetzger/clients-kevin-anan',
  zone: 'z1-kevin-anan',
  slug: 'kevin-anan',
  vault: null,
}

const NOW = Date.parse('2026-09-02T18:00:00Z')

const REQUEST = `---
type: approval
title: Move the ops token out of terraform state
owner_role: ops
client: company
tier: T3
requested_by: computer
action_zone: z0
created_at: 2026-09-02
updated_at: 2026-09-02
expires_at: 2026-09-16
disposition: pending
status: active
confidence: high
sources:
  - https://github.com/luismetzger/metzger-creative-brain/pull/20
review_after: 2026-12-01
---

## Summary

The cockpit's GitHub token is written into terraform state.

## Requested action

Move it to SSM and read it at boot.

## Evidence

State is local and KMS-backed, but a token in state is a token in a backup.

## Blast radius & reversibility

One instance; reversible by rolling back the compose file.

## Recommendation

Approve.
`

function parse(raw = REQUEST, path = 'queue/2026-09-02-ops-token.md') {
  return parseApprovalRequest({ repo: brain.repo, path, raw }, NOW)
}

describe('queue paths', () => {
  it('accepts a well-formed queue path in the brain repo', () => {
    expect(isQueuePath(brain, 'queue/2026-09-02-ops-token.md')).toBe(true)
    expect(isQueuePath(brain, 'archive/queue/2026-08-01-a-decision.md')).toBe(true)
  })

  it('refuses a queue path in a client repo', () => {
    // The zone crossing, not the filename, is what is being refused: the same
    // path is valid in z0 and invalid here.
    expect(isQueuePath(client, 'queue/2026-09-02-ops-token.md')).toBe(false)
  })

  it('refuses traversal, nesting and malformed filenames', () => {
    expect(isQueuePath(brain, 'queue/../policies/budgets.md')).toBe(false)
    expect(isQueuePath(brain, 'queue/2026/09/02-ops-token.md')).toBe(false)
    expect(isQueuePath(brain, 'queue/ops-token.md')).toBe(false)
    expect(isQueuePath(brain, 'queue/2026-09-02-Ops_Token.md')).toBe(false)
    expect(isQueuePath(brain, 'wiki/projects/tax-prep-ai.md')).toBe(false)
    expect(isQueuePath(brain, '/queue/2026-09-02-ops-token.md')).toBe(false)
  })

  it('maps a pending path to its archive path and leaves an archived one alone', () => {
    expect(archivePathFor('queue/2026-09-02-x.md')).toBe('archive/queue/2026-09-02-x.md')
    expect(archivePathFor('archive/queue/2026-09-02-x.md')).toBe('archive/queue/2026-09-02-x.md')
    expect(() => archivePathFor('wiki/x.md')).toThrow(/not a queue path/)
  })
})

describe('expiry', () => {
  it('classifies ok, due-soon and expired against a fixed now', () => {
    expect(expiryStatus({ expires_at: '2026-09-30' }, NOW).state).toBe('ok')
    expect(expiryStatus({ expires_at: '2026-09-04' }, NOW)).toMatchObject({
      state: 'due-soon',
      daysRemaining: 2,
    })
    expect(expiryStatus({ expires_at: '2026-09-02' }, NOW)).toMatchObject({
      state: 'due-soon',
      daysRemaining: 0,
    })
    expect(expiryStatus({ expires_at: '2026-08-30' }, NOW)).toMatchObject({
      state: 'expired',
      daysRemaining: -3,
    })
  })

  it('reports a missing or unparseable expires_at rather than defaulting it', () => {
    // Defaulting would be the dangerous choice: an unreadable date must not
    // silently become "plenty of time left".
    expect(expiryStatus({}, NOW).state).toBe('missing')
    expect(expiryStatus({ expires_at: 'soon' }, NOW).state).toBe('invalid')
    expect(expiryStatus({ expires_at: '2026-13-45' }, NOW).state).toBe('invalid')
  })
})

describe('parsing', () => {
  it('reads the fields the card needs', () => {
    const r = parse()
    expect(r).toMatchObject({
      title: 'Move the ops token out of terraform state',
      tier: 'T3',
      requestedBy: 'computer',
      actionZone: 'z0',
      disposition: 'pending',
      archived: false,
      slug: 'ops-token',
    })
    expect(r.expiry.state).toBe('ok')
    expect(r.approveRefusal).toBeNull()
    expect(r.sources).toHaveLength(1)
    expect(r.warnings).toEqual([])
    expect(r.sections.map(s => s.heading.toLowerCase())).toEqual([
      'summary',
      'requested action',
      'evidence',
      'blast radius & reversibility',
      'recommendation',
    ])
  })

  it('renders a malformed request with warnings rather than dropping it', () => {
    const r = parse(
      REQUEST.replace('tier: T3', 'tier: T1')
        .replace('type: approval', 'type: note')
        .replace('disposition: pending', 'disposition: maybe')
        .replace(/sources:\n  - .*\n/, 'sources: []\n'),
    )
    // A request that disappears is a request that never gets decided.
    expect(r.disposition).toBe('pending')
    expect(r.warnings.join(' ')).toMatch(/tier is T1/)
    expect(r.warnings.join(' ')).toMatch(/expected 'approval'/)
    expect(r.warnings.join(' ')).toMatch(/unrecognised disposition/)
    expect(r.warnings.join(' ')).toMatch(/no sources/)
  })

  it('keeps section bodies verbatim, including blank lines', () => {
    const sections = splitSections('## A\n\nline one\n\nline two\n\n## B\n\nb\n')
    expect(sections).toHaveLength(2)
    expect(sections[0].body).toBe('line one\n\nline two')
  })
})

describe('disposition refusals', () => {
  const pending = parse()

  it('allows approving a live request', () => {
    expect(dispositionRefusal(pending, 'approved')).toBeNull()
    expect(dispositionRefusal(pending, 'denied')).toBeNull()
    expect(dispositionRefusal(pending, 'expired')).toBeNull()
  })

  it('refuses to approve an expired request, and says why', () => {
    const stale = parse(REQUEST.replace('expires_at: 2026-09-16', 'expires_at: 2026-08-20'))
    expect(stale.expiry.state).toBe('expired')
    // The card reads this off the request rather than recomputing it, so it
    // must be populated at parse time, not just available from the helper.
    expect(stale.approveRefusal).toMatch(/rule 6/)
    const refusal = dispositionRefusal(stale, 'approved')
    expect(refusal).toMatch(/cannot be approved/)
    expect(refusal).toMatch(/rule 6/)
    // Recording it as expired is still allowed — that is how it leaves the queue.
    expect(dispositionRefusal(stale, 'expired')).toBeNull()
    expect(dispositionRefusal(stale, 'denied')).toBeNull()
  })

  it('refuses to re-decide a decided request', () => {
    const decided = parse(
      REQUEST.replace('disposition: pending', 'disposition: approved'),
      'archive/queue/2026-09-02-ops-token.md',
    )
    expect(dispositionRefusal(decided, 'denied')).toMatch(/already approved/)
    expect(dispositionRefusal(decided, 'approved')).toMatch(/terminal/)
  })

  it('refuses "pending" as a decision', () => {
    expect(dispositionRefusal(pending, 'pending')).toMatch(/not a decision/)
  })
})

describe('buildDisposition', () => {
  it('writes only the decision fields and the Disposition section', () => {
    const built = buildDisposition({
      raw: REQUEST,
      path: 'queue/2026-09-02-ops-token.md',
      disposition: 'approved',
      decidedBy: 'luis',
      decidedAt: '2026-09-03',
      note: 'Do it before the next AMI refresh.',
    })

    expect(built.archivePath).toBe('archive/queue/2026-09-02-ops-token.md')
    expect(built.content).toMatch(/^disposition: approved$/m)
    expect(built.content).toMatch(/^status: archived$/m)
    expect(built.content).toMatch(/^decided_by: luis$/m)
    expect(built.content).toMatch(/^decided_at: 2026-09-03$/m)
    expect(built.content).toMatch(/^updated_at: 2026-09-03$/m)
    expect(built.content).toMatch(/## Disposition/)
    expect(built.content).toMatch(/Do it before the next AMI refresh\./)

    // created_at, expires_at, tier, requested_by and sources are untouched.
    expect(built.content).toMatch(/^created_at: 2026-09-02$/m)
    expect(built.content).toMatch(/^expires_at: 2026-09-16$/m)
    expect(built.content).toMatch(/^tier: T3$/m)
  })

  it('preserves the request body byte-for-byte', () => {
    const built = buildDisposition({
      raw: REQUEST,
      path: 'queue/2026-09-02-ops-token.md',
      disposition: 'denied',
      decidedBy: 'luis',
      decidedAt: '2026-09-03',
    })
    const body = (s: string) => s.split(/\n---\n/).slice(1).join('\n---\n')
    // Everything from the first heading to the end of the original body must
    // appear unchanged in the output. This is rule 8, and it is the one rule
    // the wiki gate cannot check — it reads the tree, not the diff.
    expect(body(built.content)).toContain(body(REQUEST).trimEnd())
  })

  it('replaces an existing Disposition section instead of stacking them', () => {
    const withSection = `${REQUEST}\n## Disposition\n\nPending.\n`
    const built = buildDisposition({
      raw: withSection,
      path: 'queue/2026-09-02-ops-token.md',
      disposition: 'approved',
      decidedBy: 'luis',
      decidedAt: '2026-09-03',
    })
    expect(built.content.match(/## Disposition/g)).toHaveLength(1)
    expect(built.content).not.toMatch(/\nPending\.\n/)
    expect(built.content).toMatch(/## Recommendation/)
  })

  it('refuses a request with no frontmatter, a bad date or no decider', () => {
    const base = {
      path: 'queue/2026-09-02-ops-token.md',
      disposition: 'approved' as const,
      decidedBy: 'luis',
      decidedAt: '2026-09-03',
    }
    expect(() => buildDisposition({ ...base, raw: '## Summary\n\nno frontmatter\n' })).toThrow(
      /no frontmatter/,
    )
    expect(() => buildDisposition({ ...base, raw: '---\ntype: approval\n\nunterminated\n' })).toThrow(
      /unterminated/,
    )
    expect(() => buildDisposition({ ...base, raw: REQUEST, decidedAt: '3 Sept' })).toThrow(
      /YYYY-MM-DD/,
    )
    expect(() => buildDisposition({ ...base, raw: REQUEST, decidedBy: '  ' })).toThrow(
      /needs a decider/,
    )
    expect(() =>
      buildDisposition({ ...base, raw: REQUEST, disposition: 'pending' as never }),
    ).toThrow(/not a decision/)
  })

  it('adds missing decision keys rather than failing on a minimal request', () => {
    const minimal = `---
type: approval
title: Minimal
tier: T3
requested_by: computer
action_zone: z0
expires_at: 2026-12-01
disposition: pending
---

## Summary

Short.
`
    const built = buildDisposition({
      raw: minimal,
      path: 'queue/2026-09-02-minimal.md',
      disposition: 'approved',
      decidedBy: 'luis',
      decidedAt: '2026-09-03',
    })
    expect(built.content).toMatch(/^decided_by: luis$/m)
    expect(built.content).toMatch(/^status: archived$/m)
  })
})

describe('branch names', () => {
  it('is always a cockpit/disposition-* branch and never a default branch', () => {
    const branch = dispositionBranchName('queue/2026-09-02-ops-token.md', NOW)
    expect(branch.startsWith(DISPOSITION_BRANCH_PREFIX)).toBe(true)
    expect(branch).not.toBe('main')
    expect(branch).not.toBe('master')
    expect(branch).toMatch(/^cockpit\/disposition-2026-09-02-ops-token-\d{8}T\d{6}Z$/)
  })

  it('survives a filename that sanitises to nothing', () => {
    expect(dispositionBranchName('queue/___.md', NOW)).toMatch(
      /^cockpit\/disposition-request-\d{8}T\d{6}Z$/,
    )
  })
})

describe('sorting', () => {
  it('puts pending first by soonest expiry, then decided by newest decision', () => {
    const make = (over: Partial<ApprovalRequest>): ApprovalRequest =>
      ({ ...parse(), ...over }) as ApprovalRequest
    const sorted = sortRequests([
      make({ path: 'a', disposition: 'approved', decidedAt: '2026-08-01', archived: true }),
      make({ path: 'b', expiry: { state: 'ok', daysRemaining: 20, expiresAt: '2026-09-22' } }),
      make({ path: 'c', disposition: 'denied', decidedAt: '2026-08-20', archived: true }),
      make({ path: 'd', expiry: { state: 'expired', daysRemaining: -3, expiresAt: '2026-08-30' } }),
    ])
    expect(sorted.map(r => r.path)).toEqual(['d', 'b', 'c', 'a'])
  })
})

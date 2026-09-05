/**
 * Tests for the run timeline: log.md parsing, automation branch detection, and
 * assembly across repos including a failed run, a >7-day-old PR, and a source
 * that errors without blanking the rest of the view.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_BRANCH_PREFIXES,
  MIN_REFRESH_MS,
  STALE_PR_DAYS,
  ageInDays,
  isAutomationBranch,
  parseLogEntries,
} from '../ops-timeline'
import { assembleTimeline, fetchAutomationPulls, fetchRuns } from '../ops-timeline-sources'
import type { OpsRepoRef } from '../ops-config'

const brain: OpsRepoRef = { repo: 'luismetzger/metzger-creative-brain', zone: 'z0', slug: null, vault: null }
const client: OpsRepoRef = {
  repo: 'luismetzger/clients-example-client',
  zone: 'z1-example-client',
  slug: 'example-client',
  vault: null,
}

const NOW = Date.parse('2026-08-30T00:00:00Z')

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const LOG_MD = `# Change log

Newest first.

- 2026-08-30 — Computer + Luis (apply) — step 2.2: cockpit verifies the OIDC email claim — why: the ALB proves a login happened, not whose — source: https://github.com/luismetzger/mission-control/pull/1
- 2026-08-29 — Computer — step 2.1: ops box applied — checklists/setup-steps.md
- 2026-08-28 — Luis — single segment entry
not a log line
`

describe('parseLogEntries', () => {
  it('parses date — who — what — why — source and stamps the zone', () => {
    const entries = parseLogEntries(LOG_MD, { repo: brain.repo, zone: brain.zone })
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      repo: brain.repo,
      zone: 'z0',
      date: '2026-08-30',
      who: 'Computer + Luis (apply)',
      what: 'step 2.2: cockpit verifies the OIDC email claim',
      why: 'the ALB proves a login happened, not whose',
      source: 'https://github.com/luismetzger/mission-control/pull/1',
    })
  })

  it('treats a trailing unlabelled segment as the source', () => {
    const entries = parseLogEntries(LOG_MD, { repo: brain.repo, zone: brain.zone })
    expect(entries[1]).toMatchObject({
      who: 'Computer',
      what: 'step 2.1: ops box applied',
      why: null,
      source: 'checklists/setup-steps.md',
    })
  })

  it('leaves a single-segment entry as the what, with no invented source', () => {
    const entries = parseLogEntries(LOG_MD, { repo: brain.repo, zone: brain.zone })
    expect(entries[2]).toMatchObject({ what: 'single segment entry', source: null })
  })

  it('honours the limit and ignores non-bullet lines', () => {
    expect(parseLogEntries(LOG_MD, { repo: brain.repo, zone: brain.zone, limit: 2 })).toHaveLength(2)
    expect(parseLogEntries('nothing here', { repo: brain.repo, zone: brain.zone })).toEqual([])
  })
})

describe('automation branches', () => {
  it('recognises every documented prefix', () => {
    for (const prefix of AUTOMATION_BRANCH_PREFIXES) {
      expect(isAutomationBranch(`${prefix}something`)).toBe(true)
    }
  })

  it('ignores human branches', () => {
    expect(isAutomationBranch('main')).toBe(false)
    expect(isAutomationBranch('luis/experiment')).toBe(false)
  })
})

describe('ageInDays', () => {
  it('counts whole days and tolerates garbage', () => {
    expect(ageInDays('2026-08-20T00:00:00Z', NOW)).toBe(10)
    expect(ageInDays('not-a-date', NOW)).toBe(0)
  })
})

describe('fetchRuns', () => {
  it('marks any completed non-success run as failed', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        workflow_runs: [
          { id: 1, name: 'ci', head_branch: 'main', status: 'completed', conclusion: 'failure', created_at: '2026-08-29T00:00:00Z', html_url: 'u1' },
          { id: 2, name: 'ci', head_branch: 'main', status: 'completed', conclusion: 'success', created_at: '2026-08-28T00:00:00Z', html_url: 'u2' },
          { id: 3, name: 'ci', head_branch: 'main', status: 'in_progress', conclusion: null, created_at: '2026-08-30T00:00:00Z', html_url: 'u3' },
        ],
      }),
    )
    const runs = await fetchRuns(brain, { token: 't', fetchImpl })
    expect(runs.map(r => r.failed)).toEqual([true, false, false])
    expect(runs.every(r => r.zone === 'z0')).toBe(true)
  })
})

describe('fetchAutomationPulls', () => {
  it('keeps only automation branches and flags anything older than the SLA', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { number: 10, title: 'compile', head: { ref: 'compile/2026-08-01' }, user: { login: 'bot' }, created_at: '2026-08-10T00:00:00Z', html_url: 'p10' },
        { number: 11, title: 'fresh', head: { ref: 'cockpit/edit-x' }, user: { login: 'bot' }, created_at: '2026-08-29T00:00:00Z', html_url: 'p11' },
        { number: 12, title: 'human', head: { ref: 'luis/wip' }, user: { login: 'luis' }, created_at: '2026-01-01T00:00:00Z', html_url: 'p12' },
      ]),
    )
    const pulls = await fetchAutomationPulls(client, { token: 't', fetchImpl, nowMs: NOW })
    expect(pulls.map(p => p.number)).toEqual([10, 11])
    expect(pulls[0]).toMatchObject({ ageDays: 20, stalled: true, zone: 'z1-example-client' })
    expect(pulls[1]).toMatchObject({ ageDays: 1, stalled: false })
    expect(STALE_PR_DAYS).toBe(7)
  })
})

describe('assembleTimeline', () => {
  function fetchImplFor(opts: { logFails?: boolean } = {}) {
    return vi.fn(async (url: string) => {
      if (url.includes('/actions/runs')) {
        const failing = url.includes('clients-example-client')
        return jsonResponse({
          workflow_runs: [
            {
              id: failing ? 99 : 1,
              name: failing ? 'client compile' : 'brain ci',
              head_branch: 'main',
              status: 'completed',
              conclusion: failing ? 'failure' : 'success',
              created_at: failing ? '2026-08-30T00:00:00Z' : '2026-08-29T00:00:00Z',
              html_url: 'u',
            },
          ],
        })
      }
      if (url.includes('/pulls?state=open')) {
        return jsonResponse([
          {
            number: 7,
            title: 'compile: weekly',
            head: { ref: 'compile/2026-08-15' },
            user: { login: 'bot' },
            created_at: '2026-08-15T00:00:00Z',
            html_url: 'p7',
          },
        ])
      }
      if (url.includes('/contents/log.md')) {
        if (opts.logFails && url.includes('clients-example-client')) {
          return jsonResponse({ message: 'Not Found' }, 404)
        }
        return jsonResponse({
          content: Buffer.from(LOG_MD, 'utf8').toString('base64'),
          encoding: 'base64',
        })
      }
      throw new Error(`unexpected call ${url}`)
    })
  }

  it('merges runs, stalled PRs and log entries across zones, newest first', async () => {
    const timeline = await assembleTimeline([brain, client], {
      token: 't',
      fetchImpl: fetchImplFor(),
      nowMs: NOW,
    })

    expect(timeline.errors).toEqual([])
    expect(timeline.repos.map(r => r.zone)).toEqual(['z0', 'z1-example-client'])

    // Failed client run sorts first (newest) and is flagged.
    expect(timeline.runs[0]).toMatchObject({ name: 'client compile', failed: true, zone: 'z1-example-client' })
    expect(timeline.runs.filter(r => r.failed)).toHaveLength(1)

    // Both repos contribute one 15-day-old compile PR, over the 7-day SLA.
    expect(timeline.pulls).toHaveLength(2)
    expect(timeline.pulls.every(p => p.stalled && p.ageDays === 15)).toBe(true)

    expect(timeline.logEntries).toHaveLength(6)
    expect(timeline.logEntries[0].date).toBe('2026-08-30')
    expect(new Set(timeline.logEntries.map(e => e.zone))).toEqual(new Set(['z0', 'z1-example-client']))
    expect(timeline.generatedAt).toBe('2026-08-30T00:00:00.000Z')
  })

  it('records a per-source failure instead of blanking the view', async () => {
    const timeline = await assembleTimeline([brain, client], {
      token: 't',
      fetchImpl: fetchImplFor({ logFails: true }),
      nowMs: NOW,
    })
    expect(timeline.errors).toEqual(['luismetzger/clients-example-client log.md: GitHub API 404'])
    expect(timeline.runs).toHaveLength(2)
    expect(timeline.logEntries).toHaveLength(3)
  })

  it('never polls tighter than 60s', () => {
    expect(MIN_REFRESH_MS).toBe(60_000)
  })
})

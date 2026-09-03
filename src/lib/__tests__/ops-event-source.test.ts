import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The poller, tested against a stubbed source layer.
 *
 * The behaviour that matters here is not "does it fetch" — it is what it does
 * when the fetch goes wrong, because those are the paths that produce false
 * alarms and nobody exercises them by accident. Specifically: a source that
 * failed must not be read as a source that returned nothing, or a transient 500
 * announces that every approval was decided at once.
 */

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const fetchQueue = vi.fn()
const fetchRuns = vi.fn()

vi.mock('@/lib/ops-queue-sources', () => ({ fetchQueue: (...a: unknown[]) => fetchQueue(...a) }))
vi.mock('@/lib/ops-timeline-sources', () => ({ fetchRuns: (...a: unknown[]) => fetchRuns(...a) }))

import {
  pollOnce,
  takeSnapshot,
  resetWatcher,
  watcherStatus,
  opsEventBus,
  MIN_POLL_MS,
  REPLAY_BUFFER,
} from '@/lib/ops-event-source'
import type { OpsConfig } from '@/lib/ops-config'
import type { OpsEvent } from '@/lib/ops-events'

const config: OpsConfig = {
  brainRepo: { slug: 'company', repo: 'owner/brain', zone: 'z0', vaultPath: null },
  clientRepos: [],
  repos: [{ slug: 'company', repo: 'owner/brain', zone: 'z0', vaultPath: null }],
  token: 'token',
  missing: [],
  invalid: [],
} as unknown as OpsConfig

function queueResult(titles: string[]) {
  return {
    repo: 'owner/brain',
    pending: titles.map((title, i) => ({
      path: `queue/2026-09-0${i + 1}-${title}.md`,
      title,
      expiry: { state: 'ok', daysRemaining: 10, expiresAt: '2026-09-30' },
    })),
    decided: [],
    errors: [],
  }
}

function runResult(conclusion: string) {
  return [
    {
      repo: 'owner/brain',
      zone: 'z0' as const,
      id: 1,
      name: 'Wiki gates',
      branch: 'main',
      status: 'completed',
      conclusion,
      failed: conclusion !== 'success',
      createdAt: '2026-09-02T00:00:00Z',
      htmlUrl: 'https://github.com/owner/brain/actions/runs/1',
    },
  ]
}

beforeEach(() => {
  resetWatcher()
  fetchQueue.mockReset()
  fetchRuns.mockReset()
})

describe('takeSnapshot', () => {
  it('refuses to snapshot without a token rather than reporting an empty world', () => {
    fetchQueue.mockResolvedValue(queueResult([]))
    fetchRuns.mockResolvedValue([])
    return takeSnapshot({ ...config, token: null } as OpsConfig, 1).then((result) => {
      expect(result.snapshot).toBeNull()
      expect(result.errors[0]).toMatch(/OPS_GITHUB_TOKEN/)
    })
  })

  it('returns no snapshot at all when every source fails', async () => {
    fetchQueue.mockRejectedValue(new Error('rate limited'))
    fetchRuns.mockRejectedValue(new Error('rate limited'))
    const result = await takeSnapshot(config, 1)
    expect(result.snapshot).toBeNull()
    expect(result.errors).toHaveLength(2)
  })

  it('keeps the last known value for a source that failed, not an empty list', async () => {
    // Otherwise a transient failure on the queue read looks like every pending
    // approval was decided simultaneously — a burst of false good news.
    fetchQueue.mockResolvedValueOnce(queueResult(['a', 'b']))
    fetchRuns.mockResolvedValue(runResult('success'))
    await pollOnce(config, 1) // seeds

    fetchQueue.mockRejectedValueOnce(new Error('502'))
    const events = await pollOnce(config, 2)
    expect(events).toEqual([])
    expect(watcherStatus().lastError).toMatch(/queue/)
  })

  it('keeps only the newest completed run per workflow and branch', async () => {
    fetchQueue.mockResolvedValue(queueResult([]))
    fetchRuns.mockResolvedValue([
      ...runResult('failure'),
      { ...runResult('success')[0], id: 2 },
      { ...runResult('success')[0], id: 3, name: 'Other', branch: 'main' },
    ])
    const { snapshot } = await takeSnapshot(config, 1)
    expect(snapshot?.runs).toHaveLength(2)
    // The first entry wins, matching GitHub's newest-first ordering.
    expect(snapshot?.runs[0].conclusion).toBe('failure')
  })

  it('ignores in-flight runs, which have no conclusion to transition to', async () => {
    fetchQueue.mockResolvedValue(queueResult([]))
    fetchRuns.mockResolvedValue([{ ...runResult('success')[0], conclusion: null, status: 'in_progress' }])
    const { snapshot } = await takeSnapshot(config, 1)
    expect(snapshot?.runs).toEqual([])
  })

  it('leaves budgetFraction null rather than guessing a number it does not own', async () => {
    fetchQueue.mockResolvedValue(queueResult([]))
    fetchRuns.mockResolvedValue([])
    const { snapshot } = await takeSnapshot(config, 1)
    expect(snapshot?.budgetFraction).toBeNull()
  })
})

describe('pollOnce', () => {
  it('seeds silently on the first poll, however much is pending', async () => {
    fetchQueue.mockResolvedValue(queueResult(['a', 'b', 'c']))
    fetchRuns.mockResolvedValue(runResult('failure'))
    const events = await pollOnce(config, 1)
    expect(events).toEqual([])
    expect(watcherStatus().seeded).toBe(true)
  })

  it('emits on the second poll once there is a baseline to diff against', async () => {
    fetchQueue.mockResolvedValueOnce(queueResult(['a']))
    fetchRuns.mockResolvedValue(runResult('success'))
    await pollOnce(config, 1)

    fetchQueue.mockResolvedValueOnce(queueResult(['a', 'b']))
    const events = await pollOnce(config, 2)
    expect(events.map((e) => e.type)).toEqual(['ops.approval.requested'])
  })

  it('publishes emitted events on the bus for connected streams', async () => {
    const seen: OpsEvent[] = []
    const handler = (event: OpsEvent) => seen.push(event)
    opsEventBus.on('ops-event', handler)

    fetchQueue.mockResolvedValueOnce(queueResult([]))
    fetchRuns.mockResolvedValueOnce(runResult('success'))
    await pollOnce(config, 1)
    fetchQueue.mockResolvedValueOnce(queueResult([]))
    fetchRuns.mockResolvedValueOnce(runResult('failure'))
    await pollOnce(config, 2)

    opsEventBus.off('ops-event', handler)
    expect(seen.map((e) => e.type)).toEqual(['ops.ci.failed'])
  })

  it('keeps a bounded replay buffer so a late client is not permanently ignorant', async () => {
    fetchRuns.mockResolvedValue([])
    fetchQueue.mockResolvedValueOnce(queueResult([]))
    await pollOnce(config, 1)

    // Churn many distinct approvals through the queue.
    for (let i = 0; i < REPLAY_BUFFER + 20; i += 1) {
      fetchQueue.mockResolvedValueOnce(queueResult([`item${i}`]))
      await pollOnce(config, 2 + i)
    }
    expect(watcherStatus().recent.length).toBeLessThanOrEqual(REPLAY_BUFFER)
  })

  it('does not seed twice — a later poll never resets the baseline', async () => {
    fetchQueue.mockResolvedValue(queueResult(['a']))
    fetchRuns.mockResolvedValue([])
    await pollOnce(config, 1)
    await pollOnce(config, 2)
    await pollOnce(config, 3)
    expect(watcherStatus().polls).toBe(3)
    expect(watcherStatus().seeded).toBe(true)
  })

  it('records a poll even when it produced nothing, so "last checked" is honest', async () => {
    fetchQueue.mockResolvedValue(queueResult([]))
    fetchRuns.mockResolvedValue([])
    await pollOnce(config, 4242)
    expect(watcherStatus().lastPollAt).toBe(4242)
  })

  it('holds a floor under the poll interval to protect a shared rate limit', () => {
    expect(MIN_POLL_MS).toBeGreaterThanOrEqual(60_000)
  })
})

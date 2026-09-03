/**
 * The thing that watches git so the cockpit can make a noise about it.
 *
 * Server-side singleton. Polls the ops sources, diffs each snapshot against
 * the last, and pushes the resulting transitions to connected SSE clients.
 *
 * ## Why this is not on the workspace event bus
 *
 * `event-bus.ts` is workspace-scoped and fails closed: an event without a
 * `workspace_id` is dropped rather than delivered. That is a good rule and the
 * isolation tests depend on it. Ops events have no workspace — they are Z0
 * company state, read from git, orthogonal to the cockpit's own multi-tenancy.
 * Stamping them with `workspace_id: 1` to get them through would be telling
 * that invariant a lie in order to reuse a pipe. So they get their own
 * emitter and their own endpoint, and the workspace bus keeps meaning what it
 * says.
 *
 * ## Why polling
 *
 * GitHub webhooks would be lower latency, but they need a public ingress with
 * a shared secret, and the ops box deliberately has no unauthenticated public
 * surface — everything sits behind the OIDC ALB. Polling keeps the box's
 * attack surface exactly where it is. The cost is latency measured in minutes,
 * which for "an approval is waiting" is fine.
 */

import { logger } from '@/lib/logger'
import { loadOpsConfig, isOpsConfigured, type OpsConfig } from '@/lib/ops-config'
import { fetchQueue } from '@/lib/ops-queue-sources'
import { fetchRuns } from '@/lib/ops-timeline-sources'
import {
  diffSnapshots,
  type OpsEvent,
  type OpsSnapshot,
  type SnapshotApproval,
  type SnapshotRun,
} from '@/lib/ops-events'
import { EventEmitter } from 'events'

/** Floor on the poll interval. GitHub's API is rate limited and shared. */
export const MIN_POLL_MS = 60_000
export const DEFAULT_POLL_MS = 120_000

/** How many events to keep for clients that connect mid-stream. */
export const REPLAY_BUFFER = 50

class OpsEventBus extends EventEmitter {
  private static instance: OpsEventBus | null = null
  static get(): OpsEventBus {
    if (!OpsEventBus.instance) {
      OpsEventBus.instance = new OpsEventBus()
      OpsEventBus.instance.setMaxListeners(50)
    }
    return OpsEventBus.instance
  }
}

export const opsEventBus = OpsEventBus.get()

interface WatcherState {
  previous: OpsSnapshot | null
  recent: OpsEvent[]
  timer: NodeJS.Timeout | null
  running: boolean
  lastPollAt: number | null
  lastError: string | null
  polls: number
}

const state: WatcherState = {
  previous: null,
  recent: [],
  timer: null,
  running: false,
  lastPollAt: null,
  lastError: null,
  polls: 0,
}

/** Exposed so the panel can say "watching, last checked 40s ago" honestly. */
export function watcherStatus() {
  return {
    running: state.running,
    seeded: state.previous !== null,
    lastPollAt: state.lastPollAt,
    lastError: state.lastError,
    polls: state.polls,
    recent: [...state.recent],
  }
}

/** Test seam: drop all accumulated state. */
export function resetWatcher(): void {
  if (state.timer) clearInterval(state.timer)
  state.previous = null
  state.recent = []
  state.timer = null
  state.running = false
  state.lastPollAt = null
  state.lastError = null
  state.polls = 0
}

/**
 * Read one snapshot of the world.
 *
 * Partial failure is normal — a rate limit on the runs call should not stop
 * approvals from being watched. Each source is caught independently, and a
 * source that failed contributes *nothing* rather than an empty list, because
 * an empty list is a claim ("there are no approvals") and a failed read is
 * not entitled to make it. That distinction is what `null` means below.
 */
export async function takeSnapshot(
  config: OpsConfig,
  nowMs: number = Date.now(),
): Promise<{ snapshot: OpsSnapshot | null; errors: string[] }> {
  const errors: string[] = []
  const token = config.token
  if (!token) return { snapshot: null, errors: ['OPS_GITHUB_TOKEN is unset'] }

  let approvals: SnapshotApproval[] | null = null
  try {
    const queue = await fetchQueue(config, { token, nowMs, archiveLimit: 0 })
    approvals = queue.pending.map((r) => ({
      path: r.path,
      title: r.title,
      expiryState: r.expiry.state,
      daysLeft: r.expiry.daysRemaining,
    }))
  } catch (error) {
    errors.push(`queue: ${error instanceof Error ? error.message : String(error)}`)
  }

  let runs: SnapshotRun[] | null = null
  try {
    const collected: SnapshotRun[] = []
    for (const ref of config.repos) {
      const fetched = await fetchRuns(ref, { token, limit: 20 })
      // Keep only the newest completed run per workflow+branch. Older runs in
      // the same series are history, and history does not transition.
      const seen = new Set<string>()
      for (const run of fetched) {
        if (!run.conclusion) continue
        const key = `${ref.repo}#${run.name}#${run.branch}`
        if (seen.has(key)) continue
        seen.add(key)
        collected.push({
          key,
          repo: ref.repo,
          workflow: run.name,
          conclusion: run.conclusion,
          htmlUrl: run.htmlUrl,
          zone: ref.zone,
        })
      }
    }
    runs = collected
  } catch (error) {
    errors.push(`runs: ${error instanceof Error ? error.message : String(error)}`)
  }

  // If everything failed there is no snapshot. Returning a snapshot of empties
  // would make the *next* poll look like a mass recovery.
  if (approvals === null && runs === null) return { snapshot: null, errors }

  return {
    snapshot: {
      // A source that failed reuses what was last known, so a transient 500
      // does not read as "every approval was decided at once".
      approvals: approvals ?? state.previous?.approvals ?? [],
      runs: runs ?? state.previous?.runs ?? [],
      // Spend is not read here — the budget monitor owns that number and this
      // watcher has no business re-deriving it. Wired in when the cockpit
      // reads the ledger; until then no budget cue can fire, which is the
      // honest state rather than a guessed one.
      budgetFraction: null,
      takenAt: nowMs,
    },
    errors,
  }
}

/** One poll: snapshot, diff, emit. Exported for tests and for a manual kick. */
export async function pollOnce(
  config: OpsConfig = loadOpsConfig(),
  nowMs: number = Date.now(),
): Promise<OpsEvent[]> {
  state.polls += 1
  const { snapshot, errors } = await takeSnapshot(config, nowMs)
  state.lastPollAt = nowMs
  state.lastError = errors.length > 0 ? errors.join('; ') : null

  if (errors.length > 0) logger.warn({ errors }, 'ops event source: partial read')
  if (!snapshot) return []

  const wasCold = state.previous === null
  const events = diffSnapshots(state.previous, snapshot)
  state.previous = snapshot

  if (wasCold) {
    // Seeded silently. See the note in ops-events.ts — the first poll after a
    // restart would otherwise announce the entire standing backlog.
    logger.info(
      { approvals: snapshot.approvals.length, runs: snapshot.runs.length },
      'ops event source: seeded, emitting nothing',
    )
    return []
  }

  for (const event of events) {
    state.recent.push(event)
    opsEventBus.emit('ops-event', event)
  }
  if (state.recent.length > REPLAY_BUFFER) {
    state.recent.splice(0, state.recent.length - REPLAY_BUFFER)
  }

  if (events.length > 0) {
    logger.info({ count: events.length, types: events.map((e) => e.type) }, 'ops events emitted')
  }
  return events
}

/**
 * Start the watcher. Idempotent — Next.js may evaluate a module more than
 * once, and two pollers would double every cue.
 */
export function startWatcher(pollMs: number = DEFAULT_POLL_MS): boolean {
  if (state.running) return false

  const config = loadOpsConfig()
  if (!isOpsConfigured(config)) {
    logger.info('ops event source: not configured, watcher not started')
    return false
  }

  const interval = Math.max(MIN_POLL_MS, pollMs)
  state.running = true
  void pollOnce(config).catch((error) => {
    logger.error({ error }, 'ops event source: initial poll failed')
  })
  state.timer = setInterval(() => {
    void pollOnce(loadOpsConfig()).catch((error) => {
      logger.error({ error }, 'ops event source: poll failed')
    })
  }, interval)
  // Do not hold the process open for a poller.
  state.timer.unref?.()
  logger.info({ interval }, 'ops event source: watching')
  return true
}

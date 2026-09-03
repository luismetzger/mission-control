import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { loadOpsConfig, isOpsConfigured, REQUIRED_OPS_ENV } from '@/lib/ops-config'
import {
  opsEventBus,
  startWatcher,
  watcherStatus,
  DEFAULT_POLL_MS,
} from '@/lib/ops-event-source'
import type { OpsEvent } from '@/lib/ops-events'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/ops/events — Server-Sent Events stream of ops state transitions.
 *
 * Separate from `/api/events`, which is the workspace-scoped bus for database
 * mutations. Ops events are Z0 company state read from git and have no
 * workspace; see the note at the top of `ops-event-source.ts` for why they are
 * not squeezed through the workspace bus.
 *
 * Read-only, `viewer` role. The stream carries no action bindings — hearing
 * that an approval is waiting is not the same as being able to grant it, and
 * anything that changes state still goes through `/api/ops/queue`.
 *
 * Connecting starts the watcher if it is not already running. That is
 * deliberate: a poller that runs when nobody is looking spends GitHub rate
 * limit for an empty room.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const config = loadOpsConfig()
  if (!isOpsConfigured(config)) {
    return NextResponse.json(
      {
        error: 'ops_not_configured',
        missing: config.missing,
        required: REQUIRED_OPS_ENV,
      },
      { status: 503 },
    )
  }

  startWatcher(DEFAULT_POLL_MS)

  const encoder = new TextEncoder()
  let cleanup: (() => void) | null = null

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, payload: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          )
        } catch {
          // Client went away between the check and the write.
        }
      }

      const status = watcherStatus()

      // The client is told plainly whether the watcher has a baseline yet.
      // Before it seeds, "no events" means "not watching yet", not "all quiet",
      // and a status panel that cannot tell those apart is lying by omission.
      send('ops.hello', {
        seeded: status.seeded,
        lastPollAt: status.lastPollAt,
        pollMs: DEFAULT_POLL_MS,
      })

      // Replay recent events so a client that connects after a transition is
      // not permanently ignorant of it. Marked so the client can show them
      // without playing a cue for something that happened ten minutes ago.
      for (const event of status.recent) {
        send('ops.replay', event)
      }

      const handler = (event: OpsEvent) => send('ops.event', event)
      opsEventBus.on('ops-event', handler)

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, 30_000)

      cleanup = () => {
        opsEventBus.off('ops-event', handler)
        clearInterval(heartbeat)
      }
    },

    cancel() {
      cleanup?.()
      cleanup = null
    },
  })

  request.signal.addEventListener('abort', () => {
    cleanup?.()
    cleanup = null
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

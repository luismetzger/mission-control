import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { loadOpsConfig, isOpsConfigured, REQUIRED_OPS_ENV } from '@/lib/ops-config'
import { watcherStatus, DEFAULT_POLL_MS } from '@/lib/ops-event-source'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/ops/events/status — is the watcher configured, and does it have a baseline?
 *
 * The stream endpoint cannot answer this, which is the whole reason this route
 * exists. An `EventSource` pointed at a 503 reconnects forever without ever
 * surfacing the status code to the page, so a client that only had the stream
 * would sit on "connecting" while quietly retrying a misconfiguration in a loop.
 * A plain JSON probe lets the panel distinguish "not configured", "configured but
 * not yet seeded", and "watching" — three states that look identical from an
 * empty feed and mean very different things.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const config = loadOpsConfig()
  const configured = isOpsConfigured(config)
  const status = watcherStatus()

  return NextResponse.json({
    configured,
    missing: config.missing,
    required: REQUIRED_OPS_ENV,
    running: status.running,
    // False means no baseline yet, so an empty feed means "not watching yet"
    // rather than "nothing has changed".
    seeded: status.seeded,
    lastPollAt: status.lastPollAt,
    lastError: status.lastError,
    polls: status.polls,
    pollMs: DEFAULT_POLL_MS,
    bufferedEvents: status.recent.length,
  })
}

/**
 * Tests for /api/ops/events and /api/ops/events/status.
 *
 * The stream is read-only, so the interesting assertions are the boring ones:
 * it is gated, it refuses cleanly when unconfigured instead of streaming an
 * empty forever, and its status route can distinguish "not configured" from
 * "configured but no baseline yet" — three states that look identical from an
 * empty feed and mean entirely different things to whoever is relying on the
 * silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRoleMock = vi.fn()
const watcherStatusMock = vi.fn()
const startWatcherMock = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/ops-event-source', () => ({
  opsEventBus: { on: vi.fn(), off: vi.fn() },
  startWatcher: startWatcherMock,
  watcherStatus: watcherStatusMock,
  DEFAULT_POLL_MS: 120_000,
}))

const viewer = { user: { id: 7, username: 'luis', role: 'viewer', workspace_id: 1 } }

const CONFIGURED_ENV = {
  OPS_BRAIN_REPO: 'luismetzger/metzger-creative-brain',
  OPS_CLIENT_REPOS: 'example-client=luismetzger/clients-example-client',
  OPS_GITHUB_TOKEN: 'ghp_test',
}

function setEnv(env: Record<string, string | undefined>) {
  for (const key of ['OPS_BRAIN_REPO', 'OPS_CLIENT_REPOS', 'OPS_GITHUB_TOKEN']) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
}

const originalEnv = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  requireRoleMock.mockReturnValue(viewer)
  watcherStatusMock.mockReturnValue({
    running: true,
    seeded: true,
    lastPollAt: 1,
    lastError: null,
    polls: 3,
    recent: [],
  })
  startWatcherMock.mockReturnValue(true)
  setEnv(CONFIGURED_ENV)
})

afterEach(() => {
  process.env = { ...originalEnv }
})

function request(path: string) {
  return new NextRequest(`http://localhost${path}`)
}

/**
 * Read the frames already queued on an SSE stream without waiting for it to
 * end. The stream is deliberately long-lived — reading it to completion hangs
 * until the 30s heartbeat timeout, which is what a naive `.text()` does.
 */
async function readOpeningFrames(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  // Each read races a short timer, because the number of frames enqueued up
  // front varies (hello alone, or hello plus replays) and a read that waits for
  // a frame that is never coming hangs until the heartbeat.
  for (;;) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ])
    if (!chunk || chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel()
  return text
}

describe('GET /api/ops/events', () => {
  it('requires at least the viewer role', async () => {
    requireRoleMock.mockReturnValue({ error: 'unauthenticated', status: 401 })
    const { GET } = await import('@/app/api/ops/events/route')
    const response = await GET(request('/api/ops/events'))
    expect(response.status).toBe(401)
    expect(startWatcherMock).not.toHaveBeenCalled()
  })

  it('refuses with 503 and names the missing variables when unconfigured', async () => {
    setEnv({})
    const { GET } = await import('@/app/api/ops/events/route')
    const response = await GET(request('/api/ops/events'))
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error).toBe('ops_not_configured')
    expect(body.missing).toContain('OPS_GITHUB_TOKEN')
    // Streaming an empty forever would look like a quiet system.
    expect(startWatcherMock).not.toHaveBeenCalled()
  })

  it('starts the watcher only once a client is actually listening', async () => {
    const { GET } = await import('@/app/api/ops/events/route')
    const response = await GET(request('/api/ops/events'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(startWatcherMock).toHaveBeenCalledTimes(1)
  })

  it('sets the headers a proxied SSE stream needs to not be buffered', async () => {
    const { GET } = await import('@/app/api/ops/events/route')
    const response = await GET(request('/api/ops/events'))
    expect(response.headers.get('Cache-Control')).toContain('no-cache')
    // Without this the ALB/nginx in front can hold the stream in a buffer and
    // deliver cues in batches minutes late, which is worse than not at all.
    expect(response.headers.get('X-Accel-Buffering')).toBe('no')
  })

  it('opens with a hello frame that states whether a baseline exists', async () => {
    watcherStatusMock.mockReturnValue({
      running: true,
      seeded: false,
      lastPollAt: null,
      lastError: null,
      polls: 0,
      recent: [],
    })
    const { GET } = await import('@/app/api/ops/events/route')
    const response = await GET(request('/api/ops/events'))
    const text = await readOpeningFrames(response.body)
    expect(text).toContain('event: ops.hello')
    expect(text).toContain('"seeded":false')
  })

  it('replays buffered events under a distinct event name so they are not sounded', async () => {
    watcherStatusMock.mockReturnValue({
      running: true,
      seeded: true,
      lastPollAt: 1,
      lastError: null,
      polls: 2,
      recent: [
        {
          id: 'approval-new:queue/x.md',
          type: 'ops.approval.requested',
          cue: 'approval',
          severity: 'alert',
          line: 'Approval requested: X.',
          zone: 'z0',
          timestamp: 1,
        },
      ],
    })
    const { GET } = await import('@/app/api/ops/events/route')
    const response = await GET(request('/api/ops/events'))
    const text = await readOpeningFrames(response.body)
    // A cue for something that happened before you connected is a false alarm,
    // so the client has to be able to tell replay from live.
    expect(text).toContain('event: ops.replay')
    expect(text).not.toContain('event: ops.event')
  })
})

describe('GET /api/ops/events/status', () => {
  it('requires the viewer role', async () => {
    requireRoleMock.mockReturnValue({ error: 'unauthenticated', status: 401 })
    const { GET } = await import('@/app/api/ops/events/status/route')
    const response = await GET(request('/api/ops/events/status'))
    expect(response.status).toBe(401)
  })

  it('reports unconfigured as a 200 with configured:false, not an error', async () => {
    setEnv({})
    const { GET } = await import('@/app/api/ops/events/status/route')
    const response = await GET(request('/api/ops/events/status'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.configured).toBe(false)
    expect(body.missing).toContain('OPS_GITHUB_TOKEN')
  })

  it('distinguishes configured-but-unseeded from watching', async () => {
    watcherStatusMock.mockReturnValue({
      running: true,
      seeded: false,
      lastPollAt: null,
      lastError: null,
      polls: 0,
      recent: [],
    })
    const { GET } = await import('@/app/api/ops/events/status/route')
    const body = await (await GET(request('/api/ops/events/status'))).json()
    expect(body.configured).toBe(true)
    expect(body.seeded).toBe(false)
  })

  it('surfaces a partial-read error rather than hiding it behind a green light', async () => {
    watcherStatusMock.mockReturnValue({
      running: true,
      seeded: true,
      lastPollAt: 5,
      lastError: 'queue: 502',
      polls: 9,
      recent: [],
    })
    const { GET } = await import('@/app/api/ops/events/status/route')
    const body = await (await GET(request('/api/ops/events/status'))).json()
    expect(body.lastError).toBe('queue: 502')
  })

  it('does not start the watcher — a status read is not a subscription', async () => {
    const { GET } = await import('@/app/api/ops/events/status/route')
    await GET(request('/api/ops/events/status'))
    expect(startWatcherMock).not.toHaveBeenCalled()
  })
})

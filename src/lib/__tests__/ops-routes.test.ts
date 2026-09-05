/**
 * Tests for /api/ops/notes, /api/ops/timeline and /api/ops/queue — auth, the
 * repo allowlist, and the "not configured" contract (explicit missing variable
 * names, never an empty list and never a crash).
 *
 * The queue cases go further, because it is the only route that reaches a T3
 * decision: they assert that the decider is the session and not the body, that
 * a policy refusal happens before any write, and that the route cannot be
 * pointed at a client zone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const requireRoleMock = vi.fn()
const mutationLimiterMock = vi.fn<(request: unknown) => NextResponse | null>(() => null)
const logAuditEventMock = vi.fn()
const listPagesMock = vi.fn()
const fetchPageMock = vi.fn()
const proposeEditMock = vi.fn()
const assembleTimelineMock = vi.fn()
const fetchQueueMock = vi.fn()
const fetchRequestMock = vi.fn()
const proposeDispositionMock = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mutationLimiterMock }))
vi.mock('@/lib/db', () => ({ logAuditEvent: logAuditEventMock }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/ops-notes', () => ({
  listPages: listPagesMock,
  fetchPage: fetchPageMock,
  proposeEdit: proposeEditMock,
}))
vi.mock('@/lib/ops-timeline-sources', () => ({ assembleTimeline: assembleTimelineMock }))
vi.mock('@/lib/ops-queue-sources', () => ({
  fetchQueue: fetchQueueMock,
  fetchRequest: fetchRequestMock,
  proposeDisposition: proposeDispositionMock,
}))

const operator = { user: { id: 7, username: 'luis', role: 'operator', workspace_id: 1 } }

const CONFIGURED_ENV = {
  OPS_BRAIN_REPO: 'luismetzger/metzger-creative-brain',
  OPS_CLIENT_REPOS: 'example-client=luismetzger/clients-example-client',
  OPS_GITHUB_TOKEN: 'ghp_test',
}

function setEnv(env: Record<string, string | undefined>) {
  for (const key of ['OPS_BRAIN_REPO', 'OPS_CLIENT_REPOS', 'OPS_GITHUB_TOKEN', 'OPS_OBSIDIAN_VAULTS']) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
}

async function notesRoute() {
  return await import('@/app/api/ops/notes/route')
}
async function timelineRoute() {
  return await import('@/app/api/ops/timeline/route')
}
async function queueRoute() {
  return await import('@/app/api/ops/queue/route')
}

/** A live, decidable request as ops-queue-sources would return it. */
function liveRequest(over: Record<string, unknown> = {}) {
  return {
    repo: 'luismetzger/metzger-creative-brain',
    path: 'queue/2026-09-02-ops-token.md',
    title: 'Move the ops token out of terraform state',
    tier: 'T3',
    requestedBy: 'computer',
    actionZone: 'z0',
    disposition: 'pending',
    decidedBy: null,
    decidedAt: null,
    createdAt: '2026-09-02',
    archived: false,
    sources: ['https://github.com/luismetzger/metzger-creative-brain/pull/20'],
    expiry: { state: 'ok', daysRemaining: 14, expiresAt: '2026-09-16' },
    sections: [],
    warnings: [],
    approveRefusal: null,
    htmlUrl: '',
    ...over,
  }
}

function queuePost(body: unknown) {
  return new NextRequest('http://localhost/api/ops/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('ops API routes', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRoleMock.mockReturnValue(operator)
    mutationLimiterMock.mockReturnValue(null)
    setEnv(CONFIGURED_ENV)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('rejects an unauthenticated read', async () => {
    requireRoleMock.mockReturnValue({ error: 'Unauthorized', status: 401 })
    const { GET } = await notesRoute()
    const res = await GET(new NextRequest('http://localhost/api/ops/notes'))
    expect(res.status).toBe(401)
    expect(listPagesMock).not.toHaveBeenCalled()
  })

  it('returns a not-configured payload naming the missing variables', async () => {
    setEnv({})
    const { GET } = await notesRoute()
    const res = await GET(new NextRequest('http://localhost/api/ops/notes'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      configured: false,
      missing: ['OPS_CLIENT_REPOS', 'OPS_GITHUB_TOKEN'],
      pages: [],
    })
    expect(listPagesMock).not.toHaveBeenCalled()
  })

  it('lists pages across the configured repos', async () => {
    listPagesMock.mockImplementation(async (ref: { repo: string; zone: string }) => [
      { repo: ref.repo, zone: ref.zone, path: 'wiki/x.md', name: 'x', section: 'wiki' },
    ])
    const { GET } = await notesRoute()
    const res = await GET(new NextRequest('http://localhost/api/ops/notes'))
    const body = await res.json()
    expect(body.configured).toBe(true)
    expect(body.pages.map((p: { zone: string }) => p.zone)).toEqual(['z0', 'z1-example-client'])
    expect(body.repos).toEqual([
      { repo: 'luismetzger/metzger-creative-brain', zone: 'z0', slug: null, hasVault: false },
      { repo: 'luismetzger/clients-example-client', zone: 'z1-example-client', slug: 'example-client', hasVault: false },
    ])
  })

  it('refuses a repo that is not in the configured set', async () => {
    const { GET } = await notesRoute()
    const res = await GET(
      new NextRequest('http://localhost/api/ops/notes?repo=someone/else&path=wiki/x.md'),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not in the configured ops repo set/)
    expect(fetchPageMock).not.toHaveBeenCalled()
  })

  it('attaches an obsidian link only when a vault is configured', async () => {
    fetchPageMock.mockResolvedValue({
      repo: 'luismetzger/metzger-creative-brain',
      zone: 'z0',
      path: 'wiki/x.md',
      raw: '# x',
      sha: 'blob',
    })
    setEnv({ ...CONFIGURED_ENV, OPS_OBSIDIAN_VAULTS: 'luismetzger/metzger-creative-brain=Brain' })
    const { GET } = await notesRoute()
    const res = await GET(
      new NextRequest(
        'http://localhost/api/ops/notes?repo=luismetzger/metzger-creative-brain&path=wiki/x.md',
      ),
    )
    const body = await res.json()
    expect(body.page.obsidianUri).toBe('obsidian://open?vault=Brain&file=wiki%2Fx')
  })

  it('proposes an edit as a PR and audits it', async () => {
    proposeEditMock.mockResolvedValue({
      prUrl: 'https://github.com/o/r/pull/9',
      prNumber: 9,
      branch: 'cockpit/edit-wiki-x-20260830T000000Z',
      base: 'main',
    })
    const { POST } = await notesRoute()
    const res = await POST(
      new NextRequest('http://localhost/api/ops/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: 'luismetzger/clients-example-client',
          path: 'wiki/x.md',
          content: 'edited',
          sha: 'blob',
        }),
      }),
    )
    const body = await res.json()
    expect(body.prUrl).toBe('https://github.com/o/r/pull/9')
    expect(proposeEditMock.mock.calls[0][0]).toMatchObject({
      path: 'wiki/x.md',
      content: 'edited',
      sha: 'blob',
      actor: 'luis',
    })
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ops_note_edit_proposed' }),
    )
  })

  it('requires path, content and sha before proposing', async () => {
    const { POST } = await notesRoute()
    const res = await POST(
      new NextRequest('http://localhost/api/ops/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'luismetzger/clients-example-client', path: 'wiki/x.md' }),
      }),
    )
    expect(res.status).toBe(400)
    expect(proposeEditMock).not.toHaveBeenCalled()
  })

  it('honours the mutation rate limiter', async () => {
    mutationLimiterMock.mockReturnValue(NextResponse.json({ error: 'rate limited' }, { status: 429 }))
    const { POST } = await notesRoute()
    const res = await POST(
      new NextRequest('http://localhost/api/ops/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'luismetzger/clients-example-client', path: 'wiki/x.md', content: 'a', sha: 'b' }),
      }),
    )
    expect(res.status).toBe(429)
    expect(proposeEditMock).not.toHaveBeenCalled()
  })

  it('serves the timeline with the polling floor, and a not-configured state without it', async () => {
    assembleTimelineMock.mockResolvedValue({
      repos: [],
      runs: [],
      pulls: [],
      logEntries: [],
      errors: [],
      generatedAt: '2026-08-30T00:00:00.000Z',
    })
    const { GET } = await timelineRoute()
    const ok = await (await GET(new NextRequest('http://localhost/api/ops/timeline'))).json()
    expect(ok).toMatchObject({ configured: true, minRefreshMs: 60_000 })

    vi.resetModules()
    setEnv({ OPS_CLIENT_REPOS: 'example-client=luismetzger/clients-example-client' })
    const { GET: GET2 } = await timelineRoute()
    const missing = await (await GET2(new NextRequest('http://localhost/api/ops/timeline'))).json()
    expect(missing).toMatchObject({ configured: false, missing: ['OPS_GITHUB_TOKEN'], runs: [] })
  })
})

describe('/api/ops/queue', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRoleMock.mockReturnValue(operator)
    mutationLimiterMock.mockReturnValue(null)
    setEnv(CONFIGURED_ENV)
    fetchQueueMock.mockResolvedValue({
      repo: 'luismetzger/metzger-creative-brain',
      pending: [liveRequest()],
      decided: [],
      errors: [],
    })
    fetchRequestMock.mockResolvedValue({ request: liveRequest(), raw: '', sha: 'blob' })
    proposeDispositionMock.mockResolvedValue({
      prUrl: 'https://github.com/luismetzger/metzger-creative-brain/pull/21',
      prNumber: 21,
      branch: 'cockpit/disposition-2026-09-02-ops-token-20260903T000000Z',
      base: 'main',
      archivePath: 'archive/queue/2026-09-02-ops-token.md',
      disposition: 'approved',
    })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('rejects an unauthenticated read', async () => {
    requireRoleMock.mockReturnValue({ error: 'Unauthorized', status: 401 })
    const { GET } = await queueRoute()
    const res = await GET(new NextRequest('http://localhost/api/ops/queue'))
    expect(res.status).toBe(401)
    expect(fetchQueueMock).not.toHaveBeenCalled()
  })

  it('returns a not-configured payload naming the missing variables', async () => {
    setEnv({ OPS_CLIENT_REPOS: 'example-client=luismetzger/clients-example-client' })
    const { GET } = await queueRoute()
    const body = await (await GET(new NextRequest('http://localhost/api/ops/queue'))).json()
    expect(body).toMatchObject({ configured: false, missing: ['OPS_GITHUB_TOKEN'], pending: [] })
    expect(fetchQueueMock).not.toHaveBeenCalled()
  })

  it('serves the queue, and one request with the sha needed to decide it', async () => {
    const { GET } = await queueRoute()
    const list = await (await GET(new NextRequest('http://localhost/api/ops/queue'))).json()
    expect(list).toMatchObject({ configured: true, repo: 'luismetzger/metzger-creative-brain' })
    expect(list.pending).toHaveLength(1)

    const one = await (
      await GET(new NextRequest('http://localhost/api/ops/queue?path=queue/2026-09-02-ops-token.md'))
    ).json()
    expect(one).toMatchObject({ configured: true, sha: 'blob' })
    expect(fetchRequestMock).toHaveBeenCalledWith(
      expect.anything(),
      'queue/2026-09-02-ops-token.md',
      expect.anything(),
    )
  })

  it('requires the operator role to decide', async () => {
    requireRoleMock.mockReturnValue({ error: 'Forbidden', status: 403 })
    const { POST } = await queueRoute()
    const res = await POST(queuePost({ path: 'queue/2026-09-02-ops-token.md', disposition: 'approved', sha: 'blob' }))
    expect(res.status).toBe(403)
    expect(proposeDispositionMock).not.toHaveBeenCalled()
  })

  it('honours the mutation rate limiter', async () => {
    mutationLimiterMock.mockReturnValue(NextResponse.json({ error: 'rate limited' }, { status: 429 }))
    const { POST } = await queueRoute()
    const res = await POST(queuePost({ path: 'queue/2026-09-02-ops-token.md', disposition: 'approved', sha: 'blob' }))
    expect(res.status).toBe(429)
    expect(proposeDispositionMock).not.toHaveBeenCalled()
  })

  it('requires path and sha, and rejects a disposition outside the enum', async () => {
    const { POST } = await queueRoute()
    expect((await POST(queuePost({ disposition: 'approved', sha: 'blob' }))).status).toBe(400)
    expect((await POST(queuePost({ path: 'queue/2026-09-02-ops-token.md', disposition: 'approved' }))).status).toBe(400)
    const bad = await POST(
      queuePost({ path: 'queue/2026-09-02-ops-token.md', disposition: 'pending', sha: 'blob' }),
    )
    expect(bad.status).toBe(400)
    // 'pending' is the absence of a decision, so it must not reach the write path.
    expect(proposeDispositionMock).not.toHaveBeenCalled()
  })

  it('opens a PR and records who decided from the session, not the body', async () => {
    const { POST } = await queueRoute()
    const res = await POST(
      queuePost({
        path: 'queue/2026-09-02-ops-token.md',
        disposition: 'approved',
        sha: 'blob',
        note: 'ok',
        // A caller-supplied decider must be ignored entirely.
        decidedBy: 'someone-else',
      }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).prNumber).toBe(21)
    expect(proposeDispositionMock.mock.calls[0][1]).toMatchObject({
      path: 'queue/2026-09-02-ops-token.md',
      disposition: 'approved',
      decidedBy: 'luis',
      sha: 'blob',
    })
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ops_t3_disposition_proposed', actor: 'luis' }),
    )
  })

  it('refuses to approve an expired request before writing anything', async () => {
    fetchRequestMock.mockResolvedValue({
      request: liveRequest({
        expiry: { state: 'expired', daysRemaining: -4, expiresAt: '2026-08-29' },
      }),
      raw: '',
      sha: 'blob',
    })
    const { POST } = await queueRoute()
    const res = await POST(
      queuePost({ path: 'queue/2026-09-02-ops-token.md', disposition: 'approved', sha: 'blob' }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/rule 6/)
    // Nothing was opened: silence is denial, so an expired request leaves the
    // queue as expired or not at all.
    expect(proposeDispositionMock).not.toHaveBeenCalled()
  })

  it('still lets an expired request be recorded as expired', async () => {
    fetchRequestMock.mockResolvedValue({
      request: liveRequest({
        expiry: { state: 'expired', daysRemaining: -4, expiresAt: '2026-08-29' },
      }),
      raw: '',
      sha: 'blob',
    })
    const { POST } = await queueRoute()
    const res = await POST(
      queuePost({ path: 'queue/2026-09-02-ops-token.md', disposition: 'expired', sha: 'blob' }),
    )
    expect(res.status).toBe(200)
    expect(proposeDispositionMock).toHaveBeenCalled()
  })

  it('refuses to re-decide a decided request', async () => {
    fetchRequestMock.mockResolvedValue({
      request: liveRequest({
        disposition: 'approved',
        archived: true,
        path: 'archive/queue/2026-09-02-ops-token.md',
      }),
      raw: '',
      sha: 'blob',
    })
    const { POST } = await queueRoute()
    const res = await POST(
      queuePost({ path: 'archive/queue/2026-09-02-ops-token.md', disposition: 'denied', sha: 'blob' }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already approved/)
    expect(proposeDispositionMock).not.toHaveBeenCalled()
  })

  it('takes no repo parameter, so the queue is always read from the brain repo', async () => {
    const { GET, POST } = await queueRoute()
    await GET(
      new NextRequest(
        'http://localhost/api/ops/queue?repo=luismetzger/clients-example-client&path=queue/2026-09-02-x.md',
      ),
    )
    // The repo query param is simply not read; the config's brain repo is.
    expect(fetchRequestMock.mock.calls[0][1]).toBe('queue/2026-09-02-x.md')
    expect(fetchRequestMock.mock.calls[0][0]).toMatchObject({
      brainRepo: expect.objectContaining({ repo: 'luismetzger/metzger-creative-brain', zone: 'z0' }),
    })

    await POST(
      queuePost({
        repo: 'luismetzger/clients-example-client',
        path: 'queue/2026-09-02-ops-token.md',
        disposition: 'denied',
        sha: 'blob',
      }),
    )
    expect(proposeDispositionMock.mock.calls[0][0]).toMatchObject({
      brainRepo: expect.objectContaining({ zone: 'z0' }),
    })
  })

  it('reports a read failure as 502 rather than an empty queue', async () => {
    fetchQueueMock.mockRejectedValue(new Error('GitHub 503'))
    const { GET } = await queueRoute()
    const res = await GET(new NextRequest('http://localhost/api/ops/queue'))
    expect(res.status).toBe(502)
    // An empty queue and an unreadable queue mean opposite things to an
    // operator, so they must never render the same.
    expect((await res.json()).error).toMatch(/GitHub 503/)
  })
})

/**
 * Tests for /api/ops/notes and /api/ops/timeline — auth, the repo allowlist,
 * and the "not configured" contract (explicit missing variable names, never an
 * empty list and never a crash).
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

const operator = { user: { id: 7, username: 'luis', role: 'operator', workspace_id: 1 } }

const CONFIGURED_ENV = {
  OPS_BRAIN_REPO: 'luismetzger/metzger-creative-brain',
  OPS_CLIENT_REPOS: 'kevin-anan=luismetzger/clients-kevin-anan',
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
    expect(body.pages.map((p: { zone: string }) => p.zone)).toEqual(['z0', 'z1-kevin-anan'])
    expect(body.repos).toEqual([
      { repo: 'luismetzger/metzger-creative-brain', zone: 'z0', slug: null, hasVault: false },
      { repo: 'luismetzger/clients-kevin-anan', zone: 'z1-kevin-anan', slug: 'kevin-anan', hasVault: false },
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
          repo: 'luismetzger/clients-kevin-anan',
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
        body: JSON.stringify({ repo: 'luismetzger/clients-kevin-anan', path: 'wiki/x.md' }),
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
        body: JSON.stringify({ repo: 'luismetzger/clients-kevin-anan', path: 'wiki/x.md', content: 'a', sha: 'b' }),
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
    setEnv({ OPS_CLIENT_REPOS: 'kevin-anan=luismetzger/clients-kevin-anan' })
    const { GET: GET2 } = await timelineRoute()
    const missing = await (await GET2(new NextRequest('http://localhost/api/ops/timeline'))).json()
    expect(missing).toMatchObject({ configured: false, missing: ['OPS_GITHUB_TOKEN'], runs: [] })
  })
})

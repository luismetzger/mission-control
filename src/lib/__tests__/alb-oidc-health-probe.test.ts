/**
 * End-to-end check through the middleware: with ALB OIDC enforcement on, the
 * container's own HEALTHCHECK (`/api/status?action=health`, no ALB header)
 * must not be denied, while `/api/status` itself still is.
 *
 * The Dockerfile HEALTHCHECK runs `node /app/healthcheck.js`, which requests
 * `/api/status?action=health` from inside the container and treats any non-200
 * as unhealthy — so a 403 here marks a perfectly healthy container unhealthy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function makeRequest(pathname: string, search: string) {
  return {
    headers: new Headers({ host: 'localhost' }),
    nextUrl: {
      host: 'localhost',
      hostname: 'localhost',
      pathname,
      search,
      searchParams: new URLSearchParams(search),
      clone: () => ({ pathname }),
    },
    method: 'GET',
    cookies: { get: () => undefined },
  } as never
}

describe('container health probe under ALB OIDC enforcement', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env.OPS_ALB_OIDC = 'true'
    process.env.OPS_ALLOWED_EMAILS = 'luis@example.com'
    process.env.MC_ALLOW_ANY_HOST = 'true'
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('lets /api/status?action=health through without an OIDC header', async () => {
    const { proxy } = await import('@/proxy')
    const response = await proxy(makeRequest('/api/status', '?action=health'))
    expect(response.status).not.toBe(403)
  })

  it('still denies /api/status with no query', async () => {
    const { proxy } = await import('@/proxy')
    const response = await proxy(makeRequest('/api/status', ''))
    expect(response.status).toBe(403)
  })

  it('still denies /api/status with any other action', async () => {
    const { proxy } = await import('@/proxy')
    for (const search of ['?action=', '?action=system', '?action=full', '?action=health&action=system']) {
      const response = await proxy(makeRequest('/api/status', search))
      expect(response.status, `expected 403 for ${search}`).toBe(403)
    }
  })
})

/**
 * Tests for src/lib/alb-oidc.ts — ALB OIDC identity verification.
 *
 * Generates a real ES256 keypair, mints ALB-style JWTs, and mocks the key
 * fetch so no network access is required.
 */
import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ALB_OIDC_DATA_HEADER,
  isAlbOidcEnabled,
  isAlbOidcExemptPath,
  getAllowedEmails,
  verifyAlbOidcToken,
  verifyAlbOidcRequest,
  type VerifyAlbOidcOptions,
} from '../alb-oidc'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const otherKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })

const KID = '00000000-1111-2222-3333-444444444444'
const NOW_MS = 1_700_000_000_000
const FUTURE_EXP = Math.floor(NOW_MS / 1000) + 120
const ALB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:975050000909:loadbalancer/app/cockpit/abc123'

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function mintToken(opts: {
  header?: Record<string, unknown>
  payload?: Record<string, unknown>
  signWith?: crypto.KeyObject
  tamperPayload?: boolean
} = {}): string {
  const header = { alg: 'ES256', kid: KID, signer: ALB_ARN, ...opts.header }
  const payload = { email: 'ops@metzgercreative.com', exp: FUTURE_EXP, ...opts.payload }
  const headerB64 = b64url(JSON.stringify(header))
  let payloadB64 = b64url(JSON.stringify(payload))
  const signature = crypto.sign(
    'sha256',
    Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8'),
    { key: opts.signWith ?? privateKey, dsaEncoding: 'ieee-p1363' },
  )
  if (opts.tamperPayload) {
    payloadB64 = b64url(JSON.stringify({ ...payload, email: 'attacker@evil.example' }))
  }
  return `${headerB64}.${payloadB64}.${b64url(signature)}`
}

function baseOpts(overrides: Partial<VerifyAlbOidcOptions> = {}): VerifyAlbOidcOptions {
  return {
    allowedEmails: ['ops@metzgercreative.com'],
    nowMs: NOW_MS,
    fetchPublicKeyPem: vi.fn(async () => publicKeyPem),
    keyCache: new Map(),
    ...overrides,
  }
}

describe('verifyAlbOidcToken', () => {
  it('accepts a valid token with an allowlisted email', async () => {
    const result = await verifyAlbOidcToken(mintToken(), baseOpts())
    expect(result).toEqual({ ok: true, email: 'ops@metzgercreative.com' })
  })

  it('compares emails case-insensitively', async () => {
    const token = mintToken({ payload: { email: 'OPS@MetzgerCreative.COM' } })
    const result = await verifyAlbOidcToken(token, baseOpts())
    expect(result.ok).toBe(true)
  })

  it('rejects an expired token', async () => {
    const token = mintToken({ payload: { exp: Math.floor(NOW_MS / 1000) - 10 } })
    const result = await verifyAlbOidcToken(token, baseOpts())
    expect(result).toMatchObject({ ok: false, reason: 'JWT expired' })
  })

  it('rejects a token without an exp claim', async () => {
    const token = mintToken({ payload: { exp: undefined } })
    const result = await verifyAlbOidcToken(token, baseOpts())
    expect(result).toMatchObject({ ok: false, reason: 'missing exp claim' })
  })

  it('rejects an email that is not on the allowlist', async () => {
    const token = mintToken({ payload: { email: 'stranger@example.net' } })
    const result = await verifyAlbOidcToken(token, baseOpts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not in allowlist')
  })

  it('rejects everything when the allowlist is empty (fail closed)', async () => {
    const result = await verifyAlbOidcToken(mintToken(), baseOpts({ allowedEmails: [] }))
    expect(result.ok).toBe(false)
  })

  it('rejects a token with a tampered payload (bad signature)', async () => {
    const token = mintToken({ tamperPayload: true })
    const result = await verifyAlbOidcToken(token, baseOpts())
    expect(result).toMatchObject({ ok: false, reason: 'invalid JWT signature' })
  })

  it('rejects a token signed by the wrong key', async () => {
    const token = mintToken({ signWith: otherKeyPair.privateKey })
    const result = await verifyAlbOidcToken(token, baseOpts())
    expect(result).toMatchObject({ ok: false, reason: 'invalid JWT signature' })
  })

  it('rejects non-ES256 algorithms', async () => {
    for (const alg of ['none', 'HS256', 'RS256']) {
      const result = await verifyAlbOidcToken(mintToken({ header: { alg } }), baseOpts())
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('unexpected alg')
    }
  })

  it('rejects a signer ARN from the wrong AWS account', async () => {
    const token = mintToken({
      header: { signer: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/evil/xyz' },
    })
    const result = await verifyAlbOidcToken(token, baseOpts())
    expect(result).toMatchObject({ ok: false, reason: 'JWT signer is not an ALB in the expected AWS account' })
  })

  it('accepts a token without a signer field (field optional)', async () => {
    const token = mintToken({ header: { signer: undefined } })
    const result = await verifyAlbOidcToken(token, baseOpts())
    expect(result.ok).toBe(true)
  })

  it('rejects malformed tokens without fetching keys', async () => {
    const fetchPublicKeyPem = vi.fn(async () => publicKeyPem)
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', `${b64url('{"alg":"ES256"}')}.x.y`]) {
      const result = await verifyAlbOidcToken(bad, baseOpts({ fetchPublicKeyPem }))
      expect(result.ok).toBe(false)
    }
    expect(fetchPublicKeyPem).not.toHaveBeenCalled()
  })

  it('rejects a kid with unsafe characters without fetching', async () => {
    const fetchPublicKeyPem = vi.fn(async () => publicKeyPem)
    const token = mintToken({ header: { kid: '../etc/passwd' } })
    const result = await verifyAlbOidcToken(token, baseOpts({ fetchPublicKeyPem }))
    expect(result.ok).toBe(false)
    expect(fetchPublicKeyPem).not.toHaveBeenCalled()
  })

  it('fails closed when the key fetch fails', async () => {
    const result = await verifyAlbOidcToken(
      mintToken(),
      baseOpts({ fetchPublicKeyPem: vi.fn(async () => { throw new Error('boom') }) }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('failed to fetch ALB public key')
  })

  it('caches the public key and refetches after the TTL expires', async () => {
    const fetchPublicKeyPem = vi.fn(async () => publicKeyPem)
    const keyCache = new Map()
    const opts = baseOpts({ fetchPublicKeyPem, keyCache, keyTtlMs: 60_000 })

    await verifyAlbOidcToken(mintToken(), opts)
    await verifyAlbOidcToken(mintToken(), opts)
    expect(fetchPublicKeyPem).toHaveBeenCalledTimes(1)

    // Advance past the TTL (keep exp valid).
    const later = { ...opts, nowMs: NOW_MS + 61_000 }
    await verifyAlbOidcToken(mintToken(), later)
    expect(fetchPublicKeyPem).toHaveBeenCalledTimes(2)
  })

  it('passes the kid and region to the key fetcher', async () => {
    const fetchPublicKeyPem = vi.fn(async () => publicKeyPem)
    await verifyAlbOidcToken(mintToken(), baseOpts({ fetchPublicKeyPem, region: 'eu-west-1' }))
    expect(fetchPublicKeyPem).toHaveBeenCalledWith(KID, 'eu-west-1')
  })
})

describe('verifyAlbOidcRequest', () => {
  it('reads the x-amzn-oidc-data header', async () => {
    const headers = new Headers({ [ALB_OIDC_DATA_HEADER]: mintToken() })
    const result = await verifyAlbOidcRequest(headers, baseOpts())
    expect(result.ok).toBe(true)
  })

  it('denies when the header is missing', async () => {
    const result = await verifyAlbOidcRequest(new Headers(), baseOpts())
    expect(result).toMatchObject({ ok: false, reason: 'missing x-amzn-oidc-data header' })
  })
})

describe('env parsing', () => {
  it('isAlbOidcEnabled defaults to off and honors OPS_ALB_OIDC', () => {
    vi.stubEnv('OPS_ALB_OIDC', '')
    expect(isAlbOidcEnabled()).toBe(false)
    vi.stubEnv('OPS_ALB_OIDC', 'true')
    expect(isAlbOidcEnabled()).toBe(true)
    vi.stubEnv('OPS_ALB_OIDC', 'false')
    expect(isAlbOidcEnabled()).toBe(false)
    vi.unstubAllEnvs()
  })

  it('getAllowedEmails parses, trims, and lowercases OPS_ALLOWED_EMAILS', () => {
    vi.stubEnv('OPS_ALLOWED_EMAILS', ' Luis@MetzgerCreative.com , ops@example.com ,, ')
    expect(getAllowedEmails()).toEqual(['luis@metzgercreative.com', 'ops@example.com'])
    vi.unstubAllEnvs()
  })
})

describe('isAlbOidcExemptPath', () => {
  it('exempts health probes and static assets only', () => {
    expect(isAlbOidcExemptPath('/api/health')).toBe(true)
    expect(isAlbOidcExemptPath('/health')).toBe(true)
    expect(isAlbOidcExemptPath('/_next/static/chunks/main.js')).toBe(true)
    expect(isAlbOidcExemptPath('/favicon.ico')).toBe(true)
    expect(isAlbOidcExemptPath('/icon.png')).toBe(true)
    expect(isAlbOidcExemptPath('/apple-icon.png')).toBe(true)

    expect(isAlbOidcExemptPath('/')).toBe(false)
    expect(isAlbOidcExemptPath('/api/agents')).toBe(false)
    expect(isAlbOidcExemptPath('/api/healthz')).toBe(false)
    expect(isAlbOidcExemptPath('/login')).toBe(false)
  })

  it('exempts the container health probe /api/status?action=health', () => {
    expect(isAlbOidcExemptPath('/api/status?action=health')).toBe(true)
  })

  it('keeps /api/status behind auth for every other query shape', () => {
    expect(isAlbOidcExemptPath('/api/status')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?action=')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?action=full')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?action=system')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?action=HEALTH')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?action=health%20')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?actions=health')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?foo=bar')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status/detail?action=health')).toBe(false)
    expect(isAlbOidcExemptPath('/api/statuses?action=health')).toBe(false)
  })

  it('does not let a second action parameter smuggle another status action through', () => {
    expect(isAlbOidcExemptPath('/api/status?action=health&action=system')).toBe(false)
    expect(isAlbOidcExemptPath('/api/status?action=system&action=health')).toBe(false)
  })

  it('tolerates a query string on the paths that were already exempt', () => {
    expect(isAlbOidcExemptPath('/api/health?probe=1')).toBe(true)
    expect(isAlbOidcExemptPath('/_next/static/chunks/main.js?v=2')).toBe(true)
    expect(isAlbOidcExemptPath('/api/agents?action=health')).toBe(false)
  })
})

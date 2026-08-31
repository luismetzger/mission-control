/**
 * AWS ALB OIDC identity verification (defense in depth).
 *
 * When Mission Control runs behind an AWS Application Load Balancer with an
 * `authenticate-oidc` action, the ALB forwards the authenticated identity in
 * the `x-amzn-oidc-data` header: a JWT signed by the ALB with ES256. The ALB
 * public key is fetched from the regional endpoint
 * `https://public-keys.auth.elb.<region>.amazonaws.com/<kid>` (served as PEM).
 *
 * By default the ALB lets ANY account from the IdP through. This module
 * verifies the ALB signature and enforces an operator email allowlist so the
 * app fails closed even if the ALB listener rules are misconfigured. It layers
 * IN FRONT of the app's own login/session system — it never replaces it.
 *
 * Environment variables:
 * - OPS_ALB_OIDC=true         enables enforcement (default: off)
 * - OPS_ALLOWED_EMAILS        comma-separated allowlist, case-insensitive
 * - AWS_REGION                region for the key endpoint (default us-east-1)
 *
 * No external dependencies: verification uses node:crypto only.
 */

import crypto from 'node:crypto'

export const ALB_OIDC_DATA_HEADER = 'x-amzn-oidc-data'

/** AWS account that owns the ALB; the JWT header `signer` ARN must match. */
export const EXPECTED_ALB_ACCOUNT = '975050000909'

/** How long a fetched ALB public key stays in the in-memory cache. */
export const DEFAULT_KEY_TTL_MS = 60 * 60 * 1000 // 1 hour

const KID_RE = /^[A-Za-z0-9_-]{1,128}$/
const REGION_RE = /^[a-z0-9-]{1,32}$/

export type AlbOidcResult =
  | { ok: true; email: string }
  | { ok: false; reason: string }

interface CachedKey {
  key: crypto.KeyObject
  fetchedAtMs: number
}

export interface VerifyAlbOidcOptions {
  /** Override AWS region (default: env AWS_REGION or us-east-1). */
  region?: string
  /** Override allowlist (default: parsed from env OPS_ALLOWED_EMAILS). */
  allowedEmails?: string[]
  /** Expected AWS account in the JWT header `signer` ARN (checked only when the field is present). */
  expectedSignerAccount?: string
  /** Override "now" in milliseconds (for tests). */
  nowMs?: number
  /** Key cache TTL in milliseconds. */
  keyTtlMs?: number
  /** Injectable key fetcher (for tests). Must return the PEM public key. */
  fetchPublicKeyPem?: (kid: string, region: string) => Promise<string>
  /** Injectable cache (for test isolation). */
  keyCache?: Map<string, CachedKey>
}

const globalKeyCache = new Map<string, CachedKey>()

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined) return false
  const v = String(raw).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** Whether ALB OIDC enforcement is enabled (env OPS_ALB_OIDC). Default: off. */
export function isAlbOidcEnabled(): boolean {
  return envFlag('OPS_ALB_OIDC')
}

/** Parse OPS_ALLOWED_EMAILS into a normalized (lowercased, trimmed) list. */
export function getAllowedEmails(): string[] {
  return String(process.env.OPS_ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * The container HEALTHCHECK (see Dockerfile) runs `node /app/healthcheck.js`,
 * which requests `/api/status?action=health` from inside the container with no
 * ALB in front of it and therefore no `x-amzn-oidc-data` header. Only that one
 * query shape is exempt: `/api/status` otherwise returns system information and
 * stays behind auth.
 */
function isContainerHealthProbe(pathname: string, query: string): boolean {
  if (pathname !== '/api/status') return false
  const actions = new URLSearchParams(query).getAll('action')
  return actions.length === 1 && actions[0] === 'health'
}

/**
 * Paths exempt from ALB OIDC enforcement: health probes (ALB target health
 * checks do not pass through listener auth rules, and the container's own
 * HEALTHCHECK never traverses the ALB) and Next static assets.
 *
 * Accepts either a bare pathname or a pathname with its query string
 * (`/api/status?action=health`), so callers may pass `pathname + search`.
 */
export function isAlbOidcExemptPath(pathnameWithQuery: string): boolean {
  const queryStart = pathnameWithQuery.indexOf('?')
  const pathname = queryStart === -1 ? pathnameWithQuery : pathnameWithQuery.slice(0, queryStart)
  const query = queryStart === -1 ? '' : pathnameWithQuery.slice(queryStart + 1)
  if (pathname === '/api/health' || pathname === '/health') return true
  if (isContainerHealthProbe(pathname, query)) return true
  if (pathname.startsWith('/_next/static/') || pathname.startsWith('/_next/image')) return true
  if (pathname === '/favicon.ico' || pathname === '/icon.png' || pathname === '/apple-icon.png') return true
  return false
}

/** Decode a base64url (or padded base64) JWT segment. ALB pads its segments. */
function base64UrlDecode(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(normalized)) {
    throw new Error('invalid base64url segment')
  }
  return Buffer.from(normalized, 'base64')
}

function parseJsonSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(base64UrlDecode(segment).toString('utf-8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('segment is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Extract the AWS account id from an ELB ARN (arn:aws:elasticloadbalancing:region:account:...). */
function arnAccount(arn: string): string {
  const parts = arn.split(':')
  return parts.length >= 5 ? parts[4] : ''
}

async function defaultFetchPublicKeyPem(kid: string, region: string): Promise<string> {
  const res = await fetch(`https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`)
  if (!res.ok) {
    throw new Error(`ALB public key endpoint returned ${res.status}`)
  }
  return await res.text()
}

async function getAlbPublicKey(
  kid: string,
  region: string,
  opts: VerifyAlbOidcOptions,
): Promise<crypto.KeyObject> {
  const cache = opts.keyCache ?? globalKeyCache
  const ttlMs = opts.keyTtlMs ?? DEFAULT_KEY_TTL_MS
  const nowMs = opts.nowMs ?? Date.now()
  const cacheKey = `${region}/${kid}`

  const cached = cache.get(cacheKey)
  if (cached && nowMs - cached.fetchedAtMs < ttlMs) {
    return cached.key
  }

  const fetcher = opts.fetchPublicKeyPem ?? defaultFetchPublicKeyPem
  const pem = await fetcher(kid, region)
  const key = crypto.createPublicKey(pem)
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`unexpected key type: ${key.asymmetricKeyType}`)
  }
  cache.set(cacheKey, { key, fetchedAtMs: nowMs })
  return key
}

/**
 * Verify an `x-amzn-oidc-data` JWT (ES256, ALB-signed) and enforce the email
 * allowlist. Fails closed: any parse/fetch/signature error yields a denial.
 */
export async function verifyAlbOidcToken(
  token: string,
  opts: VerifyAlbOidcOptions = {},
): Promise<AlbOidcResult> {
  const deny = (reason: string): AlbOidcResult => ({ ok: false, reason })

  if (!token || typeof token !== 'string') return deny('missing x-amzn-oidc-data header')

  const parts = token.trim().split('.')
  if (parts.length !== 3) return deny('malformed JWT: expected 3 segments')
  const [headerB64, payloadB64, signatureB64] = parts

  // --- Header ---
  let header: Record<string, unknown>
  try {
    header = parseJsonSegment(headerB64)
  } catch {
    return deny('malformed JWT header')
  }

  if (header.alg !== 'ES256') return deny(`unexpected alg: ${String(header.alg)}`)

  const kid = typeof header.kid === 'string' ? header.kid : ''
  if (!KID_RE.test(kid)) return deny('missing or invalid kid in JWT header')

  // ALB sets `signer` to the load balancer ARN. When present, require it to
  // belong to the expected AWS account.
  const expectedAccount = opts.expectedSignerAccount ?? EXPECTED_ALB_ACCOUNT
  if (header.signer !== undefined) {
    if (typeof header.signer !== 'string' || arnAccount(header.signer) !== expectedAccount) {
      return deny('JWT signer is not an ALB in the expected AWS account')
    }
  }

  // --- Signature ---
  const region = (opts.region ?? process.env.AWS_REGION ?? 'us-east-1').trim() || 'us-east-1'
  if (!REGION_RE.test(region)) return deny('invalid AWS region')

  let publicKey: crypto.KeyObject
  try {
    publicKey = await getAlbPublicKey(kid, region, opts)
  } catch (err) {
    return deny(`failed to fetch ALB public key: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  let signature: Buffer
  try {
    signature = base64UrlDecode(signatureB64)
  } catch {
    return deny('malformed JWT signature encoding')
  }

  const signedData = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8')
  let signatureValid = false
  try {
    // JOSE ES256 signatures are raw r||s (IEEE P1363), not ASN.1/DER.
    signatureValid = crypto.verify(
      'sha256',
      signedData,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    )
  } catch {
    signatureValid = false
  }
  if (!signatureValid) return deny('invalid JWT signature')

  // --- Payload (only trusted after signature verification) ---
  let payload: Record<string, unknown>
  try {
    payload = parseJsonSegment(payloadB64)
  } catch {
    return deny('malformed JWT payload')
  }

  const nowMs = opts.nowMs ?? Date.now()
  const exp = payload.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return deny('missing exp claim')
  if (exp * 1000 <= nowMs) return deny('JWT expired')

  const email = typeof payload.email === 'string' ? payload.email.trim() : ''
  if (!email) return deny('missing email claim')

  const allowed = opts.allowedEmails ?? getAllowedEmails()
  if (allowed.length === 0) return deny('OPS_ALLOWED_EMAILS is empty; denying all')
  if (!allowed.includes(email.toLowerCase())) return deny(`email not in allowlist: ${email}`)

  return { ok: true, email }
}

/**
 * Verify the ALB OIDC identity for a request's headers.
 * Accepts any Headers-like object with a `get(name)` method.
 */
export async function verifyAlbOidcRequest(
  headers: { get(name: string): string | null },
  opts: VerifyAlbOidcOptions = {},
): Promise<AlbOidcResult> {
  const token = headers.get(ALB_OIDC_DATA_HEADER) || ''
  return verifyAlbOidcToken(token, opts)
}

/** Clear the module-level key cache (for tests). */
export function clearAlbKeyCacheForTests(): void {
  globalKeyCache.clear()
}

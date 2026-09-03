/**
 * Minimal GitHub client for the cockpit ops panels.
 *
 * Separate from `src/lib/github.ts` on purpose: that client is the issue-sync
 * client and resolves `GITHUB_TOKEN`, while these panels read the brain and
 * client repos with `OPS_GITHUB_TOKEN`. Path validation, the request timeout
 * and the header set follow `githubFetch` in that file.
 *
 * Never caches: nothing from a client-zone repo may be written to disk in this
 * PR (no server-side caching of client-zone page content).
 */

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface OpsGitHubRequest {
  path: string
  token: string
  // DELETE is here for the contents API, which is how a decided approval
  // request leaves queue/ (see proposeDisposition). It is only ever issued
  // against a cockpit/* branch, never a default branch.
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  fetchImpl?: FetchImpl
  timeoutMs?: number
}

const SAFE_PATH_RE = /^\/(?!\/)[^\u0000-\u001F\u007F\\]*$/

export class OpsGitHubError extends Error {
  readonly status: number
  readonly path: string

  constructor(status: number, path: string, message: string) {
    super(message)
    this.name = 'OpsGitHubError'
    this.status = status
    this.path = path
  }
}

export async function opsGithubFetch(req: OpsGitHubRequest): Promise<Response> {
  if (!req.token) throw new Error('OPS_GITHUB_TOKEN not configured')
  if (!SAFE_PATH_RE.test(req.path)) {
    throw new Error('GitHub API requests must use a safe relative path')
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${req.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'MissionControl-Cockpit/1.0',
  }
  if (req.body !== undefined) headers['Content-Type'] = 'application/json'

  const doFetch: FetchImpl = req.fetchImpl ?? ((input, init) => fetch(input, init))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 15000)
  try {
    return await doFetch(`https://api.github.com${req.path}`, {
      method: req.method ?? 'GET',
      headers,
      cache: 'no-store',
      signal: controller.signal,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function opsGithubJson<T>(req: OpsGitHubRequest): Promise<T> {
  const res = await opsGithubFetch(req)
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      // response body unavailable; status alone is enough
    }
    throw new OpsGitHubError(res.status, req.path, `GitHub API ${res.status} for ${req.path}: ${detail}`)
  }
  return (await res.json()) as T
}

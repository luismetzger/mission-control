/**
 * Cockpit ops configuration — which repos the panels read, and with what token.
 *
 * Everything comes from env, because the repo set and the Obsidian vault names
 * are deployment facts, not code:
 *
 * - `OPS_BRAIN_REPO`      owner/repo of the company brain (zone z0).
 *                         Default: luismetzger/metzger-creative-brain
 * - `OPS_CLIENT_REPOS`    comma-separated `slug=owner/repo` (zone z1-<slug>).
 * - `OPS_GITHUB_TOKEN`    token used for repo reads and PR creation.
 * - `OPS_OBSIDIAN_VAULTS` optional comma-separated `owner/repo=VaultName`.
 *
 * A missing variable is reported by name (`missing`) so panels can render an
 * explicit "not configured" state instead of an empty list or a crash.
 *
 * The zone of a page is derived here, from which repo it came from — never from
 * a hand-typed prop (architecture/04 §3).
 */

import { ZONE_UNKNOWN, type Zone } from '@/lib/ops-registry'

export const DEFAULT_BRAIN_REPO = 'luismetzger/metzger-creative-brain'

/** Env vars that must be set before any panel can show data. */
export const REQUIRED_OPS_ENV = ['OPS_GITHUB_TOKEN', 'OPS_CLIENT_REPOS'] as const

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export interface OpsRepoRef {
  /** `owner/repo` */
  repo: string
  zone: Zone
  /** Client slug for z1 repos, null for the brain repo. */
  slug: string | null
  /** Obsidian vault name, or null when unset (link is hidden, not broken). */
  vault: string | null
}

export interface OpsConfig {
  brainRepo: OpsRepoRef
  clientRepos: OpsRepoRef[]
  /** Brain repo first, then client repos. The complete allowlist. */
  repos: OpsRepoRef[]
  token: string | null
  /** Names of unset required env vars. Empty means configured. */
  missing: string[]
  /** Human-readable complaints about malformed values (still non-fatal). */
  invalid: string[]
}

export type OpsEnv = Record<string, string | undefined>

function envValue(env: OpsEnv, name: string): string {
  return String(env[name] ?? '').trim()
}

/** Parse `a=b,c=d` into ordered pairs, skipping empty segments. */
function parsePairs(raw: string): Array<[string, string]> {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const idx = entry.indexOf('=')
      if (idx <= 0) return null
      const key = entry.slice(0, idx).trim()
      const value = entry.slice(idx + 1).trim()
      if (!key || !value) return null
      return [key, value] as [string, string]
    })
    .filter((p): p is [string, string] => p !== null)
}

export function loadOpsConfig(env: OpsEnv = process.env): OpsConfig {
  const missing: string[] = []
  const invalid: string[] = []

  const rawBrain = envValue(env, 'OPS_BRAIN_REPO')
  let brain = rawBrain || DEFAULT_BRAIN_REPO
  if (!REPO_RE.test(brain)) {
    invalid.push(`OPS_BRAIN_REPO is not owner/repo: ${brain}`)
    brain = DEFAULT_BRAIN_REPO
  }

  const rawVaults = envValue(env, 'OPS_OBSIDIAN_VAULTS')
  const vaults = new Map<string, string>()
  for (const [repo, vault] of parsePairs(rawVaults)) {
    if (!REPO_RE.test(repo)) {
      invalid.push(`OPS_OBSIDIAN_VAULTS entry is not owner/repo: ${repo}`)
      continue
    }
    vaults.set(repo.toLowerCase(), vault)
  }

  const rawClients = envValue(env, 'OPS_CLIENT_REPOS')
  if (!rawClients) missing.push('OPS_CLIENT_REPOS')
  const clientRepos: OpsRepoRef[] = []
  const seenSlugs = new Set<string>()
  for (const [slug, repo] of parsePairs(rawClients)) {
    if (!REPO_RE.test(repo)) {
      invalid.push(`OPS_CLIENT_REPOS entry is not owner/repo: ${slug}=${repo}`)
      continue
    }
    const normalizedSlug = slug.toLowerCase()
    if (seenSlugs.has(normalizedSlug)) {
      invalid.push(`OPS_CLIENT_REPOS has a duplicate slug: ${slug}`)
      continue
    }
    if (repo.toLowerCase() === brain.toLowerCase()) {
      invalid.push(`OPS_CLIENT_REPOS points a client slug at the brain repo: ${slug}`)
      continue
    }
    seenSlugs.add(normalizedSlug)
    clientRepos.push({
      repo,
      zone: `z1-${normalizedSlug}`,
      slug: normalizedSlug,
      vault: vaults.get(repo.toLowerCase()) ?? null,
    })
  }

  const token = envValue(env, 'OPS_GITHUB_TOKEN') || null
  if (!token) missing.push('OPS_GITHUB_TOKEN')

  const brainRepo: OpsRepoRef = {
    repo: brain,
    zone: 'z0',
    slug: null,
    vault: vaults.get(brain.toLowerCase()) ?? null,
  }

  return {
    brainRepo,
    clientRepos,
    repos: [brainRepo, ...clientRepos],
    token,
    missing,
    invalid,
  }
}

/** True when every required env var is present. */
export function isOpsConfigured(config: OpsConfig): boolean {
  return config.missing.length === 0
}

/**
 * Look up a repo in the configured allowlist. Returns null for anything not
 * configured — callers must refuse rather than fetch an arbitrary repo.
 */
export function findRepoRef(config: OpsConfig, repo: string): OpsRepoRef | null {
  const needle = String(repo || '').trim().toLowerCase()
  if (!needle) return null
  return config.repos.find(r => r.repo.toLowerCase() === needle) ?? null
}

/**
 * Zone of a repo, derived from the configured set. Unrecognised repos are
 * `unknown` — visibly wrong beats silently company-private.
 */
export function deriveZone(config: OpsConfig, repo: string): Zone {
  return findRepoRef(config, repo)?.zone ?? ZONE_UNKNOWN
}

/**
 * `obsidian://open?vault=<vault>&file=<path>` for a page, or null when no vault
 * is configured for that repo (hide the link rather than emit a broken URI).
 */
export function obsidianUri(ref: OpsRepoRef | null, path: string): string | null {
  if (!ref?.vault || !path) return null
  const file = path.replace(/\.md$/i, '')
  return `obsidian://open?vault=${encodeURIComponent(ref.vault)}&file=${encodeURIComponent(file)}`
}

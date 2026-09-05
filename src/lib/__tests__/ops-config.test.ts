/**
 * Tests for src/lib/ops-config.ts — env parsing, zone derivation from the data
 * source, Obsidian links, and the "not configured" contract.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BRAIN_REPO,
  deriveZone,
  findRepoRef,
  isOpsConfigured,
  loadOpsConfig,
  obsidianUri,
} from '../ops-config'
import { zoneClientSlug, zoneLabel } from '../ops-registry'

const fullEnv = {
  OPS_BRAIN_REPO: 'luismetzger/metzger-creative-brain',
  OPS_CLIENT_REPOS: 'example-client=luismetzger/clients-example-client',
  OPS_GITHUB_TOKEN: 'ghp_test',
  OPS_OBSIDIAN_VAULTS: 'luismetzger/metzger-creative-brain=Brain,luismetzger/clients-example-client=ExampleClient',
}

describe('loadOpsConfig', () => {
  it('parses the full configuration', () => {
    const config = loadOpsConfig(fullEnv)
    expect(isOpsConfigured(config)).toBe(true)
    expect(config.invalid).toEqual([])
    expect(config.brainRepo).toEqual({
      repo: 'luismetzger/metzger-creative-brain',
      zone: 'z0',
      slug: null,
      vault: 'Brain',
    })
    expect(config.clientRepos).toEqual([
      {
        repo: 'luismetzger/clients-example-client',
        zone: 'z1-example-client',
        slug: 'example-client',
        vault: 'ExampleClient',
      },
    ])
    expect(config.repos.map(r => r.repo)).toEqual([
      'luismetzger/metzger-creative-brain',
      'luismetzger/clients-example-client',
    ])
  })

  it('defaults the brain repo but never the token or client repos', () => {
    const config = loadOpsConfig({})
    expect(config.brainRepo.repo).toBe(DEFAULT_BRAIN_REPO)
    expect(config.brainRepo.zone).toBe('z0')
    expect(config.missing).toEqual(['OPS_CLIENT_REPOS', 'OPS_GITHUB_TOKEN'])
    expect(isOpsConfigured(config)).toBe(false)
  })

  it('names the single missing variable when only the token is absent', () => {
    const config = loadOpsConfig({ ...fullEnv, OPS_GITHUB_TOKEN: '' })
    expect(config.missing).toEqual(['OPS_GITHUB_TOKEN'])
    expect(config.token).toBeNull()
  })

  it('reports malformed entries without dropping the rest of the config', () => {
    const config = loadOpsConfig({
      OPS_BRAIN_REPO: 'not-a-repo',
      OPS_CLIENT_REPOS: 'good=owner/repo,bad=nope,dup=owner/other,dup=owner/again',
      OPS_GITHUB_TOKEN: 't',
      OPS_OBSIDIAN_VAULTS: 'owner/repo=Vault,bogus=Vault2',
    })
    expect(config.brainRepo.repo).toBe(DEFAULT_BRAIN_REPO)
    expect(config.clientRepos.map(r => r.slug)).toEqual(['good', 'dup'])
    expect(config.clientRepos[0].vault).toBe('Vault')
    expect(config.invalid).toEqual([
      'OPS_BRAIN_REPO is not owner/repo: not-a-repo',
      'OPS_OBSIDIAN_VAULTS entry is not owner/repo: bogus',
      'OPS_CLIENT_REPOS entry is not owner/repo: bad=nope',
      'OPS_CLIENT_REPOS has a duplicate slug: dup',
    ])
  })

  it('refuses to let a client slug alias the brain repo', () => {
    const config = loadOpsConfig({
      OPS_CLIENT_REPOS: `sneaky=${DEFAULT_BRAIN_REPO}`,
      OPS_GITHUB_TOKEN: 't',
    })
    expect(config.clientRepos).toEqual([])
    expect(config.invalid[0]).toContain('points a client slug at the brain repo')
  })
})

describe('zone derivation', () => {
  const config = loadOpsConfig(fullEnv)

  it('derives z0 for the brain repo and z1-<slug> for a client repo', () => {
    expect(deriveZone(config, 'luismetzger/metzger-creative-brain')).toBe('z0')
    expect(deriveZone(config, 'luismetzger/clients-example-client')).toBe('z1-example-client')
  })

  it('is case-insensitive on the repo name', () => {
    expect(deriveZone(config, 'LuisMetzger/Clients-Example-Client')).toBe('z1-example-client')
  })

  it('returns unknown — never z0 — for a repo outside the configured set', () => {
    expect(deriveZone(config, 'someone/else')).toBe('unknown')
    expect(deriveZone(config, '')).toBe('unknown')
    expect(findRepoRef(config, 'someone/else')).toBeNull()
  })

  it('labels zones for the badge', () => {
    expect(zoneLabel('z0')).toBe('Z0 · company')
    expect(zoneLabel('z1-example-client')).toBe('Z1 · example-client')
    expect(zoneLabel('p')).toBe('P · public')
    expect(zoneLabel('unknown')).toBe('zone unknown')
    expect(zoneClientSlug('z1-example-client')).toBe('example-client')
    expect(zoneClientSlug('z0')).toBeNull()
  })
})

describe('obsidianUri', () => {
  const config = loadOpsConfig(fullEnv)

  it('builds an obsidian:// deep link without the .md extension', () => {
    const ref = findRepoRef(config, 'luismetzger/metzger-creative-brain')
    expect(obsidianUri(ref, 'wiki/brand/voice.md')).toBe(
      'obsidian://open?vault=Brain&file=wiki%2Fbrand%2Fvoice',
    )
  })

  it('returns null when no vault is configured, so the link can be hidden', () => {
    const noVault = loadOpsConfig({ ...fullEnv, OPS_OBSIDIAN_VAULTS: '' })
    const ref = findRepoRef(noVault, 'luismetzger/clients-example-client')
    expect(ref?.vault).toBeNull()
    expect(obsidianUri(ref, 'wiki/page.md')).toBeNull()
    expect(obsidianUri(null, 'wiki/page.md')).toBeNull()
  })
})

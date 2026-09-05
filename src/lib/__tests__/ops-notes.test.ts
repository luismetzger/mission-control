/**
 * Tests for src/lib/ops-notes.ts — frontmatter parsing (including a malformed
 * page), stale review_after detection, the page path allowlist, and the exact
 * GitHub call shape of edit → PR: a new cockpit/edit-* branch, never main.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  COCKPIT_BRANCH_PREFIX,
  editBranchName,
  fetchPage,
  isAllowedPagePath,
  listPages,
  parseNote,
  proposeEdit,
  reviewStatus,
} from '../ops-notes'
import type { OpsRepoRef } from '../ops-config'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const brain: OpsRepoRef = {
  repo: 'luismetzger/metzger-creative-brain',
  zone: 'z0',
  slug: null,
  vault: 'Brain',
}
const client: OpsRepoRef = {
  repo: 'luismetzger/clients-example-client',
  zone: 'z1-example-client',
  slug: 'example-client',
  vault: null,
}

const GOOD_PAGE = `---
type: policy
title: Run ledger & async watchdog
owner_role: human
client: company
updated_at: 2026-08-30
sources:
  - architecture/04-v4-autonomy-security.md
  - "https://example.com/x"
confidence: high
review_after: 2026-11-28
status: active
---
# Run Ledger

Body text.
`

const NOW = Date.parse('2026-08-30T00:00:00Z')

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('parseNote', () => {
  it('parses scalars and sequences and splits the body', () => {
    const parsed = parseNote(GOOD_PAGE)
    expect(parsed.malformed).toBe(false)
    expect(parsed.warnings).toEqual([])
    expect(parsed.frontmatter.type).toBe('policy')
    expect(parsed.frontmatter.title).toBe('Run ledger & async watchdog')
    expect(parsed.frontmatter.owner_role).toBe('human')
    expect(parsed.frontmatter.review_after).toBe('2026-11-28')
    expect(parsed.frontmatter.sources).toEqual([
      'architecture/04-v4-autonomy-security.md',
      'https://example.com/x',
    ])
    expect(parsed.body.startsWith('# Run Ledger')).toBe(true)
  })

  it('flags a page with no frontmatter block but still returns the body', () => {
    const parsed = parseNote('# Just markdown\n\nno frontmatter here')
    expect(parsed.malformed).toBe(true)
    expect(parsed.warnings[0]).toContain('no frontmatter block')
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.body).toContain('no frontmatter here')
  })

  it('flags an unterminated frontmatter block', () => {
    const parsed = parseNote('---\ntype: policy\ntitle: broken\n\n# Body\n')
    expect(parsed.malformed).toBe(true)
    expect(parsed.warnings[0]).toContain('unterminated frontmatter block')
  })

  it('flags unparseable lines inside an otherwise valid block', () => {
    const parsed = parseNote('---\ntype: policy\nthis line is not yaml\n---\nbody\n')
    expect(parsed.malformed).toBe(true)
    expect(parsed.frontmatter.type).toBe('policy')
    expect(parsed.warnings[0]).toContain('unparsed frontmatter line')
  })

  it('flags a list item that has no key above it', () => {
    const parsed = parseNote('---\n- orphan\n---\nbody\n')
    expect(parsed.malformed).toBe(true)
    expect(parsed.warnings[0]).toContain('list item with no key')
  })
})

describe('reviewStatus', () => {
  it('marks a past review_after as overdue with a day count', () => {
    const status = reviewStatus({ review_after: '2026-08-20' }, NOW)
    expect(status.state).toBe('overdue')
    expect(status.daysOverdue).toBe(10)
  })

  it('marks a review_after inside two weeks as due soon', () => {
    expect(reviewStatus({ review_after: '2026-09-05' }, NOW).state).toBe('due-soon')
  })

  it('marks a distant review_after as ok', () => {
    expect(reviewStatus({ review_after: '2026-11-28' }, NOW).state).toBe('ok')
  })

  it('distinguishes missing from unparseable dates', () => {
    expect(reviewStatus({}, NOW).state).toBe('missing')
    expect(reviewStatus({ review_after: 'someday' }, NOW).state).toBe('invalid')
  })
})

describe('isAllowedPagePath', () => {
  it('accepts markdown under the allowed prefixes per zone', () => {
    expect(isAllowedPagePath(brain, 'wiki/brand/voice.md')).toBe(true)
    expect(isAllowedPagePath(brain, 'policies/run-ledger.md')).toBe(true)
    expect(isAllowedPagePath(client, 'wiki/page.md')).toBe(true)
  })

  it('rejects other directories, traversal, and non-markdown', () => {
    expect(isAllowedPagePath(brain, 'raw/secret.md')).toBe(false)
    expect(isAllowedPagePath(client, 'policies/run-ledger.md')).toBe(false)
    expect(isAllowedPagePath(brain, 'wiki/../../etc/passwd.md')).toBe(false)
    expect(isAllowedPagePath(brain, '/wiki/page.md')).toBe(false)
    expect(isAllowedPagePath(brain, 'wiki/page.txt')).toBe(false)
    expect(isAllowedPagePath(brain, '')).toBe(false)
  })
})

describe('listPages', () => {
  it('keeps only allowed markdown and stamps the zone from the repo', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        tree: [
          { path: 'wiki/brand/voice.md', type: 'blob' },
          { path: 'policies/run-ledger.md', type: 'blob' },
          { path: 'raw/dump.md', type: 'blob' },
          { path: 'wiki/brand', type: 'tree' },
          { path: 'README.md', type: 'blob' },
        ],
      }),
    )
    const pages = await listPages(brain, { token: 't', fetchImpl })
    expect(pages.map(p => p.path)).toEqual(['policies/run-ledger.md', 'wiki/brand/voice.md'])
    expect(pages.every(p => p.zone === 'z0')).toBe(true)
    expect(pages[1]).toMatchObject({ name: 'voice', section: 'wiki' })
  })
})

describe('fetchPage', () => {
  it('decodes base64 content and derives review status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        content: Buffer.from(GOOD_PAGE, 'utf8').toString('base64'),
        encoding: 'base64',
        sha: 'blob123',
        html_url: 'https://github.com/x/y/blob/main/policies/run-ledger.md',
      }),
    )
    const page = await fetchPage(brain, 'policies/run-ledger.md', {
      token: 't',
      fetchImpl,
      nowMs: Date.parse('2027-01-01T00:00:00Z'),
    })
    expect(page.zone).toBe('z0')
    expect(page.sha).toBe('blob123')
    expect(page.frontmatter.status).toBe('active')
    expect(page.review.state).toBe('overdue')
  })

  it('refuses a path outside the allowlist before making a request', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchPage(brain, 'raw/secret.md', { token: 't', fetchImpl })).rejects.toThrow(
      /not a readable page/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('editBranchName', () => {
  it('builds cockpit/edit-<slug>-<timestamp>', () => {
    expect(editBranchName('wiki/brand/voice.md', Date.parse('2026-08-30T12:34:56Z'))).toBe(
      'cockpit/edit-wiki-brand-voice-20260830T123456Z',
    )
    expect(editBranchName('wiki/brand/voice.md').startsWith(COCKPIT_BRANCH_PREFIX)).toBe(true)
  })
})

describe('proposeEdit', () => {
  function mockGitHub() {
    const calls: Array<{ url: string; method: string; body: any }> = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (url.endsWith('/repos/luismetzger/clients-example-client')) {
        return jsonResponse({ default_branch: 'main' })
      }
      if (url.includes('/git/ref/heads/')) return jsonResponse({ object: { sha: 'basesha' } })
      if (url.includes('/git/refs')) return jsonResponse({ ref: 'refs/heads/created' }, 201)
      if (url.includes('/contents/')) return jsonResponse({ commit: { sha: 'commitsha' } }, 201)
      if (url.endsWith('/pulls')) {
        return jsonResponse({ html_url: 'https://github.com/o/r/pull/42', number: 42 }, 201)
      }
      throw new Error(`unexpected call: ${url}`)
    })
    return { calls, fetchImpl }
  }

  it('creates a branch, commits there, and opens a PR against the default branch', async () => {
    const { calls, fetchImpl } = mockGitHub()
    const result = await proposeEdit(
      { ref: client, path: 'wiki/page.md', content: 'new body', sha: 'blob123', actor: 'luis' },
      { token: 't', fetchImpl, nowMs: Date.parse('2026-08-30T12:34:56Z') },
    )

    expect(result).toMatchObject({
      prUrl: 'https://github.com/o/r/pull/42',
      prNumber: 42,
      branch: 'cockpit/edit-wiki-page-20260830T123456Z',
      base: 'main',
    })

    // Branch creation targets a fresh cockpit/edit-* ref off the base head.
    const refCall = calls.find(c => c.url.endsWith('/git/refs'))
    expect(refCall).toMatchObject({
      method: 'POST',
      body: { ref: 'refs/heads/cockpit/edit-wiki-page-20260830T123456Z', sha: 'basesha' },
    })

    // The content write is scoped to that branch and carries the base blob sha.
    const contentCall = calls.find(c => c.url.includes('/contents/wiki/page.md'))
    expect(contentCall?.method).toBe('PUT')
    expect(contentCall?.body).toMatchObject({
      branch: 'cockpit/edit-wiki-page-20260830T123456Z',
      sha: 'blob123',
    })
    expect(Buffer.from(contentCall?.body.content, 'base64').toString('utf8')).toBe('new body')
    // Never main: no write call may target the default branch.
    expect(contentCall?.body.branch).not.toBe('main')

    const prCall = calls.find(c => c.url.endsWith('/pulls'))
    expect(prCall?.body).toMatchObject({
      head: 'cockpit/edit-wiki-page-20260830T123456Z',
      base: 'main',
      title: 'cockpit: edit wiki/page.md',
    })
    expect(prCall?.body.body).toContain('cockpit')
    expect(prCall?.body.body).toContain('z1-example-client')

    // Exactly one PUT, and it is the content write — nothing else mutates.
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1)
  })

  it('refuses an empty page, a missing sha, or a disallowed path', async () => {
    const { fetchImpl } = mockGitHub()
    const deps = { token: 't', fetchImpl }
    await expect(
      proposeEdit({ ref: client, path: 'wiki/page.md', content: '   ', sha: 'x' }, deps),
    ).rejects.toThrow(/empty page/)
    await expect(
      proposeEdit({ ref: client, path: 'wiki/page.md', content: 'body', sha: '' }, deps),
    ).rejects.toThrow(/base blob sha/)
    await expect(
      proposeEdit({ ref: client, path: 'raw/x.md', content: 'body', sha: 'x' }, deps),
    ).rejects.toThrow(/not an editable page/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails loudly when the base head cannot be resolved', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/repos/luismetzger/clients-example-client')) {
        return jsonResponse({ default_branch: 'main' })
      }
      return jsonResponse({ object: {} })
    })
    await expect(
      proposeEdit({ ref: client, path: 'wiki/page.md', content: 'body', sha: 'x' }, { token: 't', fetchImpl }),
    ).rejects.toThrow(/could not resolve head/)
  })
})

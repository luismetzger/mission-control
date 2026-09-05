/**
 * Tests for `fetchRetroProposalsSnapshot`: which PRs it keeps, which it
 * drops, and what shape it hands back when GitHub answers with something
 * other than a happy list.
 *
 * The value here is the filter: a diff panel that quietly stops showing
 * retro PRs (because a filter regressed) or quietly shows unrelated PRs
 * (because the path filter loosened) fails silently in a UI nobody
 * reloads. The tests exercise both directions and the truncation flags
 * so a regression trips on obvious signals.
 */

import { describe, expect, it, vi } from 'vitest'
import { fetchDiffSnapshot, MAX_FILES, MAX_PRS } from '../ops-diff-sources'
import type { OpsConfig, OpsRepoRef } from '../ops-config'

const brain: OpsRepoRef = {
  repo: 'luismetzger/metzger-creative-brain',
  zone: 'z0',
  slug: null,
  vault: null,
}

const config: OpsConfig = {
  brainRepo: brain,
  clientRepos: [],
  repos: [brain],
  token: 't',
  missing: [],
  invalid: [],
}

const NOW = new Date('2026-09-05T12:00:00Z')

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function fetchImplFrom(routes: Record<string, unknown>, misses?: (url: string) => Response) {
  return vi.fn(async (url: string) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) return jsonResponse(body)
    }
    if (misses) return misses(url)
    throw new Error(`unexpected call ${url}`)
  })
}

describe('fetchDiffSnapshot(retro-proposals)', () => {
  it('keeps only PRs whose branch matches AND whose files sit inside retro scope', async () => {
    const pulls = [
      // Kept: retro/ branch, files inside skills/.
      {
        number: 101,
        title: 'retro: strengthen note skill',
        html_url: 'https://github.com/x/y/pull/101',
        user: { login: 'perplexity-computer' },
        head: { ref: 'retro/2026-09-05-note-skill' },
        created_at: '2026-09-05T00:00:00Z',
      },
      // Dropped: retro/ branch but the PR also touches ci/, which the retro
      // job is not allowed to rewrite.
      {
        number: 102,
        title: 'retro: also touches CI',
        html_url: 'https://github.com/x/y/pull/102',
        user: { login: 'perplexity-computer' },
        head: { ref: 'retro/2026-09-05-mixed' },
        created_at: '2026-09-05T00:00:00Z',
      },
      // Dropped: correct scope but branch is a compile job, not a retro
      // proposal. Compile PRs have their own review path — they don't
      // belong on the diff panel.
      {
        number: 103,
        title: 'compile: refresh spend',
        html_url: 'https://github.com/x/y/pull/103',
        user: { login: 'perplexity-computer' },
        head: { ref: 'compile/2026-09-04' },
        created_at: '2026-09-04T00:00:00Z',
      },
      // Dropped: draft PR, even on a retro branch. A draft is not a
      // proposal — it is a work-in-progress. Rendering it as reviewable
      // would let a half-written change into the review surface.
      {
        number: 104,
        title: 'retro: WIP',
        html_url: 'https://github.com/x/y/pull/104',
        user: { login: 'perplexity-computer' },
        head: { ref: 'retro/2026-09-05-wip' },
        created_at: '2026-09-05T00:00:00Z',
        draft: true,
      },
    ]

    const filesByPr: Record<number, unknown[]> = {
      101: [
        { filename: 'skills/note/SKILL.md', status: 'modified', additions: 8, deletions: 3, patch: '@@ -1 +1 @@\n-a\n+b' },
      ],
      102: [
        { filename: 'skills/foo/SKILL.md', status: 'modified', additions: 1, deletions: 0, patch: '' },
        { filename: 'ci/gates.py', status: 'modified', additions: 4, deletions: 0, patch: '' },
      ],
    }

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/pulls?state=open')) return jsonResponse(pulls)
      const m = url.match(/\/pulls\/(\d+)\/files/)
      if (m) return jsonResponse(filesByPr[Number(m[1])] ?? [])
      throw new Error(`unexpected call ${url}`)
    })

    const snapshot = await fetchDiffSnapshot('retro-proposals', config, {
      token: 't',
      fetchImpl,
      now: () => NOW,
    })

    expect(snapshot.state).toBe('configured')
    expect(snapshot.prs.map(p => p.number)).toEqual([101])
    expect(snapshot.prs[0].files).toHaveLength(1)
    expect(snapshot.prs[0].files[0].patch).toContain('+b')
    expect(snapshot.zone).toBe('z0')
    expect(snapshot.asOf).toBe(NOW.toISOString())
    // The files endpoint should never have been called for the compile
    // branch or the draft PR — the branch filter runs first specifically
    // so the panel doesn't cost one API call per PR on a large repo.
    const fileCalls = fetchImpl.mock.calls
      .map(c => String(c[0]))
      .filter(u => u.includes('/files'))
    expect(fileCalls.some(u => u.includes('/pulls/103/'))).toBe(false)
    expect(fileCalls.some(u => u.includes('/pulls/104/'))).toBe(false)
  })

  it('reports empty (not unavailable) when nothing matches the filter', async () => {
    // Steady-state before build-plan 3.2 ships: the list call succeeds and
    // returns unrelated PRs. "Empty" is a valid answer — the panel says
    // "nothing to review" instead of pretending the read failed.
    const fetchImpl = fetchImplFrom({
      '/pulls?state=open': [
        {
          number: 200,
          title: 'human PR',
          html_url: 'u',
          user: { login: 'luis' },
          head: { ref: 'luis/feature' },
          created_at: '2026-09-05T00:00:00Z',
        },
      ],
    })
    const snapshot = await fetchDiffSnapshot('retro-proposals', config, {
      token: 't',
      fetchImpl,
      now: () => NOW,
    })
    expect(snapshot.state).toBe('empty')
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.prs).toEqual([])
  })

  it('reports unavailable (not empty) when the list read itself fails', async () => {
    // A broken read is not "clean." An `unavailable` snapshot renders a
    // destructive banner; conflating it with `empty` would silently hide a
    // 5xx or a credential error.
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'unauth' }, 401))
    const snapshot = await fetchDiffSnapshot('retro-proposals', config, {
      token: 't',
      fetchImpl,
      now: () => NOW,
    })
    expect(snapshot.state).toBe('unavailable')
    expect(snapshot.error).toContain('401')
  })

  it("surfaces patchTruncated when GitHub omitted a file's patch", async () => {
    // GitHub omits `patch` on files above its size threshold. Rendering
    // the file as "no textual change" would be a lie; the panel needs
    // patchTruncated=true so the UI can say "open on GitHub for the
    // full diff."
    const pulls = [
      {
        number: 300,
        title: 'retro: policy rewrite',
        html_url: 'u',
        user: { login: 'perplexity-computer' },
        head: { ref: 'retro/2026-09-05-policy' },
        created_at: '2026-09-05T00:00:00Z',
      },
    ]
    const files = [
      // GitHub returns no `patch` key at all when the file is too large.
      { filename: 'policies/big.md', status: 'modified', additions: 500, deletions: 200 },
      // Contrast: a normal file with a patch string is not truncated.
      { filename: 'policies/small.md', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' },
    ]
    const fetchImpl = fetchImplFrom({ '/pulls?state=open': pulls, '/files': files })
    const snapshot = await fetchDiffSnapshot('retro-proposals', config, {
      token: 't',
      fetchImpl,
      now: () => NOW,
    })
    expect(snapshot.prs).toHaveLength(1)
    const [big, small] = snapshot.prs[0].files
    expect(big.patch).toBeNull()
    expect(big.patchTruncated).toBe(true)
    expect(small.patchTruncated).toBe(false)
    expect(small.patch).toContain('+b')
  })

  it('caps the PR list at MAX_PRS and calls it out in the caption', async () => {
    // Retro job that misfires and opens twenty PRs shouldn't drag the
    // panel to a crawl. Cap the list and TELL the reviewer we did — a
    // silent cap looks like "these are all the PRs," which is worse.
    const many = Array.from({ length: MAX_PRS + 3 }, (_, i) => ({
      number: 500 + i,
      title: `retro ${i}`,
      html_url: `u${i}`,
      user: { login: 'perplexity-computer' },
      head: { ref: `retro/2026-09-05-${i}` },
      created_at: '2026-09-05T00:00:00Z',
    }))
    const fetchImpl = fetchImplFrom({
      '/pulls?state=open': many,
      '/files': [
        { filename: 'skills/x/SKILL.md', status: 'modified', additions: 1, deletions: 0, patch: '' },
      ],
    })
    const snapshot = await fetchDiffSnapshot('retro-proposals', config, {
      token: 't',
      fetchImpl,
      now: () => NOW,
    })
    expect(snapshot.prs).toHaveLength(MAX_PRS)
    expect(snapshot.caption).toContain(`More than ${MAX_PRS}`)
  })

  it('sets filesTruncated when a PR hits the per-PR file cap', async () => {
    const pulls = [
      {
        number: 600,
        title: 'retro: broad change',
        html_url: 'u',
        user: { login: 'perplexity-computer' },
        head: { ref: 'retro/2026-09-05-broad' },
        created_at: '2026-09-05T00:00:00Z',
      },
    ]
    // Exactly MAX_FILES rows — the source can't tell if there are more
    // without another paged call, so it errs toward "there may be more"
    // and the UI links out to GitHub. An exact-match false positive here
    // is better than silently hiding files.
    const files = Array.from({ length: MAX_FILES }, (_, i) => ({
      filename: `skills/${i}/SKILL.md`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '',
    }))
    const fetchImpl = fetchImplFrom({ '/pulls?state=open': pulls, '/files': files })
    const snapshot = await fetchDiffSnapshot('retro-proposals', config, {
      token: 't',
      fetchImpl,
      now: () => NOW,
    })
    expect(snapshot.prs[0].filesTruncated).toBe(true)
    expect(snapshot.prs[0].files).toHaveLength(MAX_FILES)
  })

  it('keeps other PRs when one PR fails its files read', async () => {
    // A single bad `pulls/:n/files` shouldn't nuke the whole panel.
    // The bad PR renders as a stub with zero files so the reviewer
    // knows a proposal exists we couldn't read — silently dropping it
    // would look like "clean."
    const pulls = [
      {
        number: 700,
        title: 'retro: healthy',
        html_url: 'u1',
        user: { login: 'perplexity-computer' },
        head: { ref: 'retro/2026-09-05-a' },
        created_at: '2026-09-05T00:00:00Z',
      },
      {
        number: 701,
        title: 'retro: files 5xx',
        html_url: 'u2',
        user: { login: 'perplexity-computer' },
        head: { ref: 'retro/2026-09-05-b' },
        created_at: '2026-09-05T00:00:00Z',
      },
    ]
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/pulls?state=open')) return jsonResponse(pulls)
      if (url.includes('/pulls/700/files')) {
        return jsonResponse([
          { filename: 'skills/a/SKILL.md', status: 'modified', additions: 1, deletions: 0, patch: '' },
        ])
      }
      if (url.includes('/pulls/701/files')) {
        return jsonResponse({ message: 'boom' }, 502)
      }
      throw new Error(`unexpected ${url}`)
    })
    const snapshot = await fetchDiffSnapshot('retro-proposals', config, {
      token: 't',
      fetchImpl,
      now: () => NOW,
    })
    expect(snapshot.state).toBe('configured')
    expect(snapshot.prs.map(p => p.number)).toEqual([700, 701])
    expect(snapshot.prs[1].files).toEqual([])
  })
})

/**
 * Pure-helper tests for the diff panel (build-plan 2.2g).
 *
 * The diff panel has three properties that break silently if they drift:
 * which branch names count as retro proposals, which paths a retro job may
 * touch, and how the panel counts +/- across a PR when some files were
 * truncated for size. All three land in a UI nobody reloads: a bug reads as
 * "the retro PRs stopped showing up" (silent filter regression), "an
 * unrelated PR showed up in the review surface" (path filter regression),
 * or "the +/- summary is wrong" (stats regression looks like a data
 * problem, not a code problem).
 */
import { describe, expect, it } from 'vitest'
import {
  DIFF_IDS,
  RETRO_BRANCH_PREFIXES,
  RETRO_PATH_PREFIXES,
  allPathsInRetroScope,
  isDiffId,
  isRetroBranch,
  normaliseFileStatus,
  sumChangeStats,
} from '@/lib/ops-diff'

describe('closed sets', () => {
  it('isDiffId accepts every declared id and refuses others', () => {
    for (const id of DIFF_IDS) expect(isDiffId(id)).toBe(true)
    expect(isDiffId('compile-proposals')).toBe(false)
    expect(isDiffId('')).toBe(false)
    // Case-sensitive on purpose: diffIds are lowercase kebab, and matching
    // a typo like `Retro-Proposals` would let the router silently resolve
    // the wrong panel on some browsers' URL normalisations.
    expect(isDiffId('Retro-Proposals')).toBe(false)
  })

  it('normaliseFileStatus keeps the six documented statuses and coerces the rest', () => {
    expect(normaliseFileStatus('added')).toBe('added')
    expect(normaliseFileStatus('removed')).toBe('removed')
    expect(normaliseFileStatus('modified')).toBe('modified')
    expect(normaliseFileStatus('renamed')).toBe('renamed')
    expect(normaliseFileStatus('copied')).toBe('copied')
    expect(normaliseFileStatus('changed')).toBe('changed')
    // GitHub might add a status tomorrow; the panel colours the header by
    // status but keeps rendering. `changed` is the least-informative
    // choice, which is the honest fallback for an unknown value.
    expect(normaliseFileStatus('unmerged')).toBe('changed')
    expect(normaliseFileStatus('')).toBe('changed')
  })
})

describe('isRetroBranch', () => {
  it('accepts branches under each retro prefix', () => {
    for (const prefix of RETRO_BRANCH_PREFIXES) {
      expect(isRetroBranch(`${prefix}2026-09-05-refine-skill`)).toBe(true)
    }
  })

  it('rejects non-retro automation branches', () => {
    // These are all agent-authored branches the watchdog knows about, but
    // they are not retro proposals — they are compile jobs, log entries,
    // infra, or auth work, and each has its own review path. Sneaking
    // them into the diff panel would confuse the review surface with the
    // roll-up cadence.
    expect(isRetroBranch('compile/2026-09-05')).toBe(false)
    expect(isRetroBranch('log/2026-09-05')).toBe(false)
    expect(isRetroBranch('policy/rewrite')).toBe(false)
    expect(isRetroBranch('auth/rotate')).toBe(false)
    expect(isRetroBranch('infra/vpc')).toBe(false)
  })

  it('rejects unrelated and empty branches', () => {
    expect(isRetroBranch('main')).toBe(false)
    expect(isRetroBranch('feature/foo')).toBe(false)
    expect(isRetroBranch('')).toBe(false)
  })

  it('is case-sensitive on purpose', () => {
    // The retro job writes lowercase; matching `Retro/…` would let a
    // hand-authored uppercase variant sneak in without the evals having
    // approved it.
    expect(isRetroBranch('Retro/2026-09-05')).toBe(false)
  })
})

describe('allPathsInRetroScope', () => {
  it('accepts a PR that touches only skills/policies/templates', () => {
    for (const prefix of RETRO_PATH_PREFIXES) {
      expect(allPathsInRetroScope([`${prefix}foo/bar.md`])).toBe(true)
    }
    expect(
      allPathsInRetroScope([
        'skills/note-taking/SKILL.md',
        'policies/budgets.md',
        'templates/pr-body.md',
      ]),
    ).toBe(true)
  })

  it('rejects a PR that mixes retro paths with anything else', () => {
    // The whole point of the path filter: a retro job that also touches
    // wiki/ or ci/ is not a retro proposal, it is something else labelled
    // wrong. Letting a mixed PR into the diff viewer would erode the "the
    // diff viewer shows what the retro job proposed" invariant.
    expect(
      allPathsInRetroScope(['skills/foo/SKILL.md', 'wiki/finance/ai-spend.md']),
    ).toBe(false)
    expect(
      allPathsInRetroScope(['policies/budgets.md', 'ci/gates.py']),
    ).toBe(false)
  })

  it('rejects a PR with zero changed files', () => {
    // A PR with no files is not a proposal at all. Treating "no files"
    // as "all match" would silently accept an empty-change PR into the
    // review surface.
    expect(allPathsInRetroScope([])).toBe(false)
  })

  it('rejects a top-level file even if the name looks retro-ish', () => {
    // The filter is prefix-based on purpose. A file at repo root named
    // `skills-summary.md` is not in the skills/ directory and shouldn't
    // count — the retro job writes into directories, not at the root.
    expect(allPathsInRetroScope(['skills-summary.md'])).toBe(false)
    expect(allPathsInRetroScope(['README.md'])).toBe(false)
  })
})

describe('sumChangeStats', () => {
  it('sums additions and deletions across a PR', () => {
    const stats = sumChangeStats([
      { path: 'a', status: 'modified', additions: 10, deletions: 3, patch: '', patchTruncated: false },
      { path: 'b', status: 'added', additions: 40, deletions: 0, patch: '', patchTruncated: false },
    ])
    expect(stats).toEqual({ additions: 50, deletions: 3 })
  })

  it('honours truncated-patch files: statistics still come from GitHub, not from the omitted patch text', () => {
    // A file the panel could not render (patchTruncated: true) still
    // counted in the totals shown in the PR row header, because the
    // reviewer needs to know something changed even when the panel
    // cannot show what.
    const stats = sumChangeStats([
      { path: 'small', status: 'modified', additions: 1, deletions: 1, patch: '@@\n', patchTruncated: false },
      { path: 'huge', status: 'modified', additions: 900, deletions: 400, patch: null, patchTruncated: true },
    ])
    expect(stats).toEqual({ additions: 901, deletions: 401 })
  })

  it('ignores non-finite numbers (NaN, Infinity) rather than propagating them', () => {
    // A NaN in a header stat would poison the display forever;
    // skipping is the same "show what we know, don't lie" discipline as
    // the table panel's sumColumn.
    const stats = sumChangeStats([
      { path: 'a', status: 'modified', additions: NaN, deletions: 5, patch: '', patchTruncated: false },
      { path: 'b', status: 'modified', additions: 2, deletions: Infinity, patch: '', patchTruncated: false },
    ])
    expect(stats).toEqual({ additions: 2, deletions: 5 })
  })

  it('returns zero/zero on an empty files array', () => {
    // A stub PR (files could not be read) renders +0/-0 in the header.
    // Rendering nothing would look like "no changes"; rendering zero
    // with the "0 files" count next to it reads as "we could not read
    // this one", which is what happened.
    expect(sumChangeStats([])).toEqual({ additions: 0, deletions: 0 })
  })
})

/**
 * Tests for the KPI pure helpers.
 *
 * Written against the refusals and the honest-empty states, not the happy
 * path — the reason this module exists is that a fake number is worse than
 * "no reading", and the tests should defend the shape that guarantees that.
 * A helper that returns 0 instead of null on an empty series makes a card
 * silently render "you have spent $0 this month" on a bug, which is the exact
 * failure mode the daily budget monitor already produced once (2026-08-31).
 */
import { describe, expect, it } from 'vitest'
import {
  KPI_KINDS,
  dailySeries,
  parseAiEnvelope,
  parseAiSpendCsv,
  parseArAgingCsv,
  sumMonthCredits,
} from '@/lib/ops-kpi'

describe('sumMonthCredits', () => {
  it('sums entries in the requested month', () => {
    const rows = [
      { date: '2026-09-01', credits: 100 },
      { date: '2026-09-05', credits: 250 },
      { date: '2026-08-31', credits: 999 },
      { date: '2026-10-01', credits: 999 },
    ]
    expect(sumMonthCredits(rows, '2026-09-')).toBe(350)
  })

  it('returns null when the month has no rows — not 0', () => {
    // The distinction is the whole point: null means "no reading", 0 means
    // "we know it is zero". A 30-day analytics window that happens not to
    // cover this month returns the first; a real quiet month returns the
    // second. The card renders them differently on purpose.
    const rows = [{ date: '2026-08-30', credits: 100 }]
    expect(sumMonthCredits(rows, '2026-09-')).toBeNull()
  })

  it('handles an empty series', () => {
    expect(sumMonthCredits([], '2026-09-')).toBeNull()
  })
})

describe('dailySeries', () => {
  it('rolls (date, model, credits) into per-day totals sorted by date', () => {
    const points = dailySeries([
      { date: '2026-09-02', credits: 100 },
      { date: '2026-09-01', credits: 200 },
      { date: '2026-09-02', credits: 50 },
    ])
    expect(points).toEqual([
      { date: '2026-09-01', value: 200 },
      { date: '2026-09-02', value: 150 },
    ])
  })
})

describe('parseAiSpendCsv', () => {
  it('parses the current header shape', () => {
    const rows = parseAiSpendCsv('date,model,credits\n2026-09-02,Claude Opus 5,3839\n')
    expect(rows).toEqual([{ date: '2026-09-02', model: 'Claude Opus 5', credits: 3839 }])
  })

  it('refuses a header change loudly', () => {
    // A silent parse of a renamed column would drop rows or read the wrong
    // field. A header change is a schema change and needs a real error.
    expect(() => parseAiSpendCsv('date,provider,credits\n2026-09-02,Anthropic,100\n')).toThrow(
      /ai-spend\.csv header changed/,
    )
  })

  it('tolerates a missing trailing newline and blank lines', () => {
    const rows = parseAiSpendCsv('date,model,credits\n2026-09-02,X,1\n\n2026-09-03,Y,2')
    expect(rows.length).toBe(2)
  })

  it('skips a row whose credits column is not a number', () => {
    // A broken row should not throw — we still want the rest of the month.
    // But it should not sneak through as NaN either, since a NaN sum is a
    // silent lie.
    const rows = parseAiSpendCsv('date,model,credits\n2026-09-02,X,not-a-number\n2026-09-03,Y,2')
    expect(rows).toEqual([{ date: '2026-09-03', model: 'Y', credits: 2 }])
  })
})

describe('parseArAgingCsv', () => {
  it('parses the current header shape', () => {
    const rows = parseArAgingCsv(
      'date,current,past_1_30,past_31_60,past_61_90,past_over_90,total\n' +
        '2026-09-07,2700.00,0.00,0.00,0.00,0.00,2700.00\n',
    )
    expect(rows).toEqual([
      {
        date: '2026-09-07',
        current: 2700,
        past_1_30: 0,
        past_31_60: 0,
        past_61_90: 0,
        past_over_90: 0,
        total: 2700,
      },
    ])
  })

  it('refuses a header change loudly', () => {
    expect(() =>
      parseArAgingCsv('date,current,past_1_30,past_31_60,past_61_90,past_over_90\n2026-09-07,0,0,0,0,0\n'),
    ).toThrow(/ar-aging\.csv header changed/)
  })

  it('returns an empty series for a header-only file', () => {
    // Day one for the AR card. The card renders "no reading yet" — the parser
    // must not force it into an unavailable state.
    expect(parseArAgingCsv('date,current,past_1_30,past_31_60,past_61_90,past_over_90,total\n')).toEqual([])
  })
})

describe('parseAiEnvelope', () => {
  it('reads a whole-dollar envelope', () => {
    expect(parseAiEnvelope('# budgets\n\nMonthly AI envelope: $200 for the month\n')).toBe(200)
  })

  it('reads the "$N / month" shape', () => {
    expect(parseAiEnvelope('AI budget: $150 / month\n')).toBe(150)
  })

  it('returns null for the placeholder — an unset envelope is not a $0 envelope', () => {
    // The card shows "no monthly envelope set" in that case, not a 100% bar
    // against zero.
    expect(parseAiEnvelope('Monthly AI envelope: $___\n')).toBeNull()
  })

  it('returns null when there is no match, rather than throwing', () => {
    // A prose change on the budget page should not brick the cockpit.
    expect(parseAiEnvelope('The budget lives in Notion\n')).toBeNull()
  })
})

describe('KPI_KINDS', () => {
  it('has exactly the three kinds the registry declares', () => {
    // The card family is deliberately closed — every kind carries an action
    // tier and a drill-in target in the registry, so growing the set is a
    // registry change first, an adapter change second, and a UI change last.
    expect([...KPI_KINDS]).toEqual(['kpi-spend', 'kpi-ar', 'kpi-queue'])
  })
})

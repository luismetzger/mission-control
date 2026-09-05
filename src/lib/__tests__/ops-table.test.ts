/**
 * Pure-helper tests for the table panel (build-plan 2.2h).
 *
 * The table panel has three properties that break silently if they drift:
 * how `sumColumn` treats nulls, how `latestRow` picks the most recent
 * snapshot when a series is not strictly append-ordered, and how `rowDelta`
 * behaves on a first-ever row (nothing to compare against). All three land
 * in a UI nobody reloads, so a bug reads as "the totals row is wrong" or
 * "the delta says zero when it should say nothing" \u2014 both of which look
 * like data problems, not code problems.
 */
import { describe, expect, it } from 'vitest'
import {
  TABLE_IDS,
  isTableId,
  latestRow,
  rowDelta,
  sumColumn,
} from '@/lib/ops-table'

describe('closed sets', () => {
  it('isTableId accepts every declared id and refuses others', () => {
    for (const id of TABLE_IDS) expect(isTableId(id)).toBe(true)
    expect(isTableId('invoices')).toBe(false)
    expect(isTableId('')).toBe(false)
    // Case-sensitive on purpose: kinds are lowercase kebab, and matching a
    // typo like `AR-Aging` would let the router silently resolve the wrong
    // panel on some browsers' URL normalisations.
    expect(isTableId('AR-AGING')).toBe(false)
  })
})

describe('sumColumn', () => {
  it('sums numeric cells and skips nulls / non-numerics', () => {
    const rows = [
      { id: '1', cells: { amount: 100 } },
      { id: '2', cells: { amount: null } },
      { id: '3', cells: { amount: 50 } },
      { id: '4', cells: { amount: 'not a number' } },
    ]
    expect(sumColumn(rows, 'amount')).toBe(150)
  })

  it('returns null when the column has no numeric readings at all', () => {
    // A totals row on an empty column should render as a dash, not $0.
    // Rendering zero would suggest \"we added it up and got nothing\";
    // returning null says \"there was nothing to add\" \u2014 different signals.
    const rows = [
      { id: '1', cells: { amount: null } },
      { id: '2', cells: { amount: null } },
    ]
    expect(sumColumn(rows, 'amount')).toBeNull()
  })

  it('returns null on an empty rows array', () => {
    expect(sumColumn([], 'amount')).toBeNull()
  })

  it('ignores non-finite numbers (NaN, Infinity) rather than propagating them', () => {
    // A NaN in a sum would poison the display forever; skipping is the
    // conservative choice, and the underlying parser should already reject
    // these before they reach here.
    const rows = [
      { id: '1', cells: { amount: 100 } },
      { id: '2', cells: { amount: Number.NaN } },
      { id: '3', cells: { amount: Number.POSITIVE_INFINITY } },
    ]
    expect(sumColumn(rows, 'amount')).toBe(100)
  })
})

describe('latestRow', () => {
  it('returns the row with the greatest ISO date', () => {
    const rows = [
      { date: '2026-09-01', value: 1 },
      { date: '2026-09-15', value: 2 },
      { date: '2026-09-07', value: 3 },
    ]
    expect(latestRow(rows)?.date).toBe('2026-09-15')
  })

  it('does not mutate the input array', () => {
    // The panel sorts a copy, not the caller's data. A shared fetcher's
    // returned array is a real risk to alias.
    const rows = [
      { date: '2026-09-15', value: 1 },
      { date: '2026-09-01', value: 2 },
    ]
    const before = rows.map(r => r.date)
    latestRow(rows)
    expect(rows.map(r => r.date)).toEqual(before)
  })

  it('returns null on an empty array', () => {
    expect(latestRow<{ date: string }>([])).toBeNull()
  })
})

describe('rowDelta', () => {
  it('subtracts previous from latest per numeric key', () => {
    const latest = { current: 2700, past_1_30: 500, past_31_60: 0 }
    const previous = { current: 2000, past_1_30: 700, past_31_60: 0 }
    expect(rowDelta(latest, previous)).toEqual({
      current: 700,
      past_1_30: -200,
      past_31_60: 0,
    })
  })

  it('returns null for a key when either side is not numeric', () => {
    // The AR series has no non-numeric cells today, but the helper is used
    // more broadly and the null return is the honest signal for \"can't
    // compare\" \u2014 not a zero.
    const latest = { a: 10, b: null }
    const previous = { a: 5, b: 5 }
    expect(rowDelta(latest, previous)).toEqual({ a: 5, b: null })
  })

  it('returns an empty object when either side is missing', () => {
    // A table showing \"change since last week\" on its first-ever row has
    // nothing to compare against; rendering a false zero across every
    // column would look like the reading was unchanged.
    expect(rowDelta(undefined, { a: 1 })).toEqual({})
    expect(rowDelta({ a: 1 }, undefined)).toEqual({})
    expect(rowDelta(undefined, undefined)).toEqual({})
  })
})

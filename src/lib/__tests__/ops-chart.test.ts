/**
 * Pure-helper tests for the chart panel (build-plan 2.2e).
 *
 * The chart panel's rendered shape has two arithmetic properties nobody sees
 * until they break: how the change-window bounds are chosen, and how a daily
 * series turns into a cumulative one. Both are the shape of the plotted line;
 * if either drifts, the chart draws the wrong month and nobody notices in a
 * UI they don't reload.
 *
 * These tests never call `new Date()` — every case pins the "now" instant so
 * the assertions read the same shape on every machine and every day.
 */
import { describe, expect, it } from 'vitest'
import {
  CHART_SERIES_IDS,
  CHART_WINDOWS,
  cumulativeSeries,
  cumulativeSeriesStrict,
  isChartSeriesId,
  isChartWindow,
  percentOf,
  utcDateNDaysAgo,
  utcIsoDate,
  utcMonthStart,
  windowPoints,
} from '@/lib/ops-chart'

// Sat Sep 5 2026 12:00:00 UTC — well inside a month so mtd has a real span,
// and far enough from any DST edge that a naive local-time bug would miss.
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0)

describe('closed sets', () => {
  it('isChartWindow accepts every declared window and refuses others', () => {
    for (const w of CHART_WINDOWS) expect(isChartWindow(w)).toBe(true)
    expect(isChartWindow('90d')).toBe(false)
    expect(isChartWindow('')).toBe(false)
  })

  it('isChartSeriesId accepts every declared series and refuses others', () => {
    for (const s of CHART_SERIES_IDS) expect(isChartSeriesId(s)).toBe(true)
    expect(isChartSeriesId('ai-burn')).toBe(false)
    expect(isChartSeriesId('')).toBe(false)
  })
})

describe('UTC date arithmetic', () => {
  it('utcIsoDate formats the UTC calendar date, not the local one', () => {
    expect(utcIsoDate(NOW)).toBe('2026-09-05')
    // Just before UTC midnight on Aug 31 — a local-time bug would give Sep 1.
    expect(utcIsoDate(Date.UTC(2026, 7, 31, 23, 59, 59))).toBe('2026-08-31')
  })

  it('utcMonthStart returns the first of the current UTC month', () => {
    expect(utcMonthStart(NOW)).toBe('2026-09-01')
    // Same month even at the very end.
    expect(utcMonthStart(Date.UTC(2026, 8, 30, 23, 59, 59))).toBe('2026-09-01')
  })

  it('utcDateNDaysAgo counts whole UTC days', () => {
    expect(utcDateNDaysAgo(NOW, 0)).toBe('2026-09-05')
    expect(utcDateNDaysAgo(NOW, 6)).toBe('2026-08-30') // window bound for 7d
    expect(utcDateNDaysAgo(NOW, 29)).toBe('2026-08-07') // window bound for 30d
  })
})

describe('windowPoints', () => {
  // A dense series across an Aug/Sep boundary so every window has enough
  // data to make the difference visible.
  const dense = [
    { date: '2026-08-01', value: 1 },
    { date: '2026-08-06', value: 2 },
    { date: '2026-08-07', value: 3 },
    { date: '2026-08-30', value: 4 },
    { date: '2026-09-01', value: 5 },
    { date: '2026-09-03', value: 6 },
    { date: '2026-09-05', value: 7 },
    { date: '2026-09-06', value: 8 },
  ]

  it('7d covers today and the six days before, inclusive', () => {
    // 2026-08-30 through 2026-09-05 → dates 30, ..., 05 → six of the fixtures.
    const w = windowPoints(dense, '7d', NOW)
    expect(w.map(p => p.date)).toEqual(['2026-08-30', '2026-09-01', '2026-09-03', '2026-09-05'])
  })

  it('30d covers today and 29 days before, inclusive', () => {
    // 2026-08-07 through 2026-09-05 → excludes Aug 1 and Aug 6, includes Aug 7.
    const w = windowPoints(dense, '30d', NOW)
    expect(w.map(p => p.date)).toEqual(['2026-08-07', '2026-08-30', '2026-09-01', '2026-09-03', '2026-09-05'])
  })

  it('mtd starts at the first of the current UTC month', () => {
    const w = windowPoints(dense, 'mtd', NOW)
    expect(w.map(p => p.date)).toEqual(['2026-09-01', '2026-09-03', '2026-09-05'])
  })

  it('excludes points strictly after today', () => {
    // 2026-09-06 is a real fixture but strictly after `now`. All three windows
    // must exclude it; a future-day inclusion would suggest a `<=` where a
    // `<` should be, and would draw a line into tomorrow.
    for (const w of CHART_WINDOWS) {
      const filtered = windowPoints(dense, w, NOW)
      expect(filtered.map(p => p.date)).not.toContain('2026-09-06')
    }
  })

  it('returns an empty array when the series has no rows in the window', () => {
    // A series that only covers July should render as "empty" in any 2026-09
    // window — the caller renders a "no data in this window" state rather
    // than a false flat line at zero.
    const stale = [{ date: '2026-07-01', value: 100 }]
    for (const w of CHART_WINDOWS) {
      expect(windowPoints(stale, w, NOW)).toEqual([])
    }
  })
})

describe('cumulativeSeries', () => {
  it('runs a total forward, treating nulls as no addition (line stays flat)', () => {
    // The daily budget monitor treats a missing day as zero spent; the chart
    // must match. Nulls should leave the running total unchanged rather than
    // creating a break — see cumulativeSeriesStrict for the alternative.
    const daily = [
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-02', value: null },
      { date: '2026-09-03', value: 5 },
    ]
    expect(cumulativeSeries(daily)).toEqual([
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-02', value: 10 },
      { date: '2026-09-03', value: 15 },
    ])
  })

  it('handles an empty series without dividing by anything', () => {
    expect(cumulativeSeries([])).toEqual([])
  })
})

describe('cumulativeSeriesStrict', () => {
  it('preserves nulls as nulls to create real gaps', () => {
    // For a series that is dense-by-contract (a missing day IS a bug), a null
    // should break the line rather than plateau over the gap. This is the
    // opposite policy from cumulativeSeries — kept as a separate helper so the
    // choice is spelled out at every call site.
    const daily = [
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-02', value: null },
      { date: '2026-09-03', value: 5 },
    ]
    expect(cumulativeSeriesStrict(daily)).toEqual([
      { date: '2026-09-01', value: 10 },
      { date: '2026-09-02', value: null },
      { date: '2026-09-03', value: 15 },
    ])
  })
})

describe('percentOf', () => {
  it('computes a percent when both values are real', () => {
    expect(percentOf(75, 300)).toBe(25)
    expect(percentOf(600, 300)).toBe(200) // over-envelope is a real number
  })

  it('returns null when either input is missing or the threshold is zero', () => {
    expect(percentOf(null, 100)).toBeNull()
    expect(percentOf(50, undefined)).toBeNull()
    expect(percentOf(50, 0)).toBeNull()
    // Negative threshold is a broken input, not "zero spend allowed."
    expect(percentOf(50, -1)).toBeNull()
  })
})

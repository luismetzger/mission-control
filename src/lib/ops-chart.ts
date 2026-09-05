/**
 * Chart panel — types, series registry, and pure helpers.
 *
 * Registry kind: `chart-panel` (architecture/04 §2, build-plan 2.2e). A single
 * kind, not one-per-series like the KPI cards, because a chart is a *shape*:
 * the axes, the change window, the envelope line — they don't change between
 * series. What differs is what the series measures, and that lives in a
 * runtime prop pointing into a small server-side registry (`CHART_SERIES`),
 * not a hard-coded `chart-ai-burn` vs `chart-pipeline` kind.
 *
 * This is deliberately different from the KPI split:
 *   - KPI cards differ in *contract* (action tier, drill-in target), so
 *     baking those into the kind was right.
 *   - Chart panels differ in *series*, and every chart panel has the same
 *     contract: read-only, no drill-in write, one deep link out to the
 *     underlying source file in git. A single kind means adding a new chart
 *     is adding a `ChartSeriesDef` — not a new registration, a new route,
 *     and a new client wrapper.
 *
 * All types here are safe to import in both client and server code. The
 * fetch helpers live in `ops-chart-sources.ts` so the client bundle does not
 * pull the GitHub client with it.
 */

import type { Zone } from '@/lib/ops-registry'

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/** The set of change-windows the chart panel offers. Small on purpose: three
 * buttons the user can eyeball. MTD is not redundant with 30d — at the top
 * of a month MTD is a single point while 30d is a full trend. */
export const CHART_WINDOWS = ['7d', '30d', 'mtd'] as const
export type ChartWindow = typeof CHART_WINDOWS[number]

export function isChartWindow(s: string): s is ChartWindow {
  return (CHART_WINDOWS as readonly string[]).includes(s)
}

/** One point on the plotted line. `value` is null when the source had no
 * reading on that date. Nulls create gaps — a chart that smooths over a
 * missing day draws a trend the archive doesn't contain. */
export interface ChartPoint {
  date: string // ISO date, always UTC
  value: number | null
}

/**
 * A horizontal reference line rendered on top of the series (e.g. the monthly
 * envelope for AI burn). Optional; a series without an envelope just plots
 * the line and leaves the "am I safe" question unanswered — which is honest
 * when there is no threshold to compare against.
 */
export interface ChartThreshold {
  /** Value in the same units as the series. */
  value: number
  /** Rendered label on the reference line. */
  label: string
}

/**
 * The rendered shape the chart panel consumes.
 *
 * `state` mirrors the KPI card's tri-state (`configured`/`empty`/`unavailable`)
 * for the same reason: a series with no rows is a real day-one situation, and
 * a bad read is not the same as an empty result. Rendering all three as one
 * grey chart would hide the difference.
 */
export interface ChartSnapshot {
  seriesId: ChartSeriesId
  window: ChartWindow
  zone: Zone
  title: string
  /** Formatting hint for the axis and tooltips. Same rules as `KpiSnapshot.unit`. */
  unit: 'dollars' | 'count' | 'percent'
  /** Optional secondary label the panel renders under the title. */
  subtitle?: string
  /** The plotted series, oldest first. */
  points: ChartPoint[]
  /** Optional threshold line, e.g. the AI envelope. */
  threshold?: ChartThreshold
  /**
   * The "big number" the panel shows next to the chart — usually the latest
   * value (or cumulative-to-date for burn-down series). Null when the series
   * is empty; rendered as a dash, not a zero.
   */
  headline: {
    value: number | null
    label: string
  }
  /** Where the panel links out to for detail. Every series has one. */
  drillIn: {
    label: string
    href: string
  }
  state: 'configured' | 'empty' | 'unavailable'
  error?: string
  /** UTC ISO timestamp of the source read, for the "as of" line. */
  asOf?: string
}

// ---------------------------------------------------------------------------
// Series registry
// ---------------------------------------------------------------------------

/**
 * The set of series the chart panel knows how to render. Small and closed:
 * adding a series is a one-line change here plus a fetcher in
 * `ops-chart-sources.ts`. The panel component knows nothing about which
 * series exist — it just renders whatever `ChartSnapshot` the API returns.
 *
 * `ai-burn-vs-envelope` is first because it is the one series where a chart
 * earns its keep: the daily budget monitor can only alert *after* a threshold
 * is already crossed, and a burn line against the envelope tells you the
 * shape of the month before that happens.
 */
export const CHART_SERIES_IDS = ['ai-burn-vs-envelope'] as const
export type ChartSeriesId = typeof CHART_SERIES_IDS[number]

export function isChartSeriesId(s: string): s is ChartSeriesId {
  return (CHART_SERIES_IDS as readonly string[]).includes(s)
}

// ---------------------------------------------------------------------------
// Pure helpers (safe for client bundles)
// ---------------------------------------------------------------------------

/**
 * Return the UTC ISO date (YYYY-MM-DD) for a given instant.
 */
export function utcIsoDate(ms: number): string {
  const d = new Date(ms)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** UTC ISO date for the start of the current month. */
export function utcMonthStart(ms: number): string {
  const d = new Date(ms)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}-01`
}

/** Return date N whole UTC days before the reference instant, inclusive. */
export function utcDateNDaysAgo(ms: number, n: number): string {
  const d = new Date(ms)
  d.setUTCDate(d.getUTCDate() - n)
  return utcIsoDate(d.getTime())
}

/**
 * Filter a series to a window. `mtd` selects points from the first day of the
 * current UTC month through today; `7d` and `30d` select the last N days.
 *
 * The window is inclusive on both ends. Empty result is a real state and the
 * caller renders it as "empty," never as zero — a chart of zero-length filled
 * with `0`s would draw a false flat line.
 */
export function windowPoints(
  points: ChartPoint[],
  window: ChartWindow,
  nowMs: number,
): ChartPoint[] {
  const today = utcIsoDate(nowMs)
  const start =
    window === 'mtd'
      ? utcMonthStart(nowMs)
      : window === '7d'
        ? utcDateNDaysAgo(nowMs, 6)  // 6 whole days ago + today = 7 points
        : utcDateNDaysAgo(nowMs, 29) // 29 + today = 30 points
  return points.filter(p => p.date >= start && p.date <= today)
}

/**
 * Cumulate a daily series into a running total starting at 0. Nulls are
 * treated as "no addition" (the cumulative line stays flat over a missing
 * day) but the returned point still carries the null so the renderer can
 * choose to break the line rather than draw across the gap.
 *
 * Returned `value` is the running total *up to and including* that date.
 * A day whose original point was null has value = previous running total
 * (line flat) rather than null (which would be a break). The renderer
 * decides which of those it wants by using `cumulativeSeriesStrict` below
 * when it wants gaps at nulls instead of flat segments.
 */
export function cumulativeSeries(points: ChartPoint[]): ChartPoint[] {
  let running = 0
  return points.map(p => {
    if (p.value !== null) running += p.value
    return { date: p.date, value: running }
  })
}

/**
 * Same as `cumulativeSeries` but preserves nulls: a null on the input becomes
 * a null on the output, breaking the running total's line. Use this when the
 * series is dense-by-contract (a missing day *is* a bug) rather than
 * sparse-by-nature (some days simply have no readings).
 *
 * For AI spend, `cumulativeSeries` is the right choice: a zero-spend day is a
 * real reading (the CSV just doesn't emit a row for it), so the line should
 * plateau, not break.
 */
export function cumulativeSeriesStrict(points: ChartPoint[]): ChartPoint[] {
  let running = 0
  return points.map(p => {
    if (p.value === null) return { date: p.date, value: null }
    running += p.value
    return { date: p.date, value: running }
  })
}

/**
 * Percent-of-threshold for a value. Returns null when threshold is missing,
 * zero, or the value is null. Never returns Infinity — an over-envelope reading
 * still gets a real number the panel can render (200%, 300%, etc).
 */
export function percentOf(value: number | null, threshold: number | undefined): number | null {
  if (value === null || threshold === undefined || threshold <= 0) return null
  return (value / threshold) * 100
}

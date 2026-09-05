/**
 * KPI card kinds and their pure helpers.
 *
 * The three cards (spend / AR / queue) share a rendered shape so one React
 * component can draw all three, but *what* each one measures is decided in the
 * kind, not in a runtime prop — see `src/lib/ops-registry.ts` for the reason.
 * This module owns the vocabulary that shape uses (`KpiCardKind`, `KpiSnapshot`)
 * plus the small pure helpers that operate on it. The GitHub / QuickBooks reads
 * live in `ops-kpi-sources.ts`, so a client bundle importing types here does not
 * pull a server-side GitHub client.
 */

import type { Zone } from '@/lib/ops-registry'

/** One point on a trend line. `value` is null when the source had no reading
 * that day — a gap is not a zero, and rendering it as one falsifies the trend. */
export interface TrendPoint {
  date: string // ISO date, always UTC
  value: number | null
}

/**
 * The rendered shape a KPI card consumes. Kept intentionally small.
 *
 * `unit` is a display hint, never used in arithmetic — the *stored* series is
 * always in a stable unit (credits for spend, dollars for AR, count for queue),
 * and the card converts at the edge. Storing "displayed" values would let a
 * unit change silently rewrite what the archive says.
 *
 * `state` distinguishes between "series has no rows yet" (a real not-configured
 * situation the card should announce plainly) and "series has rows but the most
 * recent one is null" (a trend still worth drawing).
 */
export interface KpiSnapshot {
  kind: KpiCardKind
  zone: Zone
  title: string
  /** Primary big number. Null when the series is empty or the latest row has
   * no reading — the card renders a dash, not a zero. */
  value: number | null
  /** Formatting hint. The card decides the actual glyph. */
  unit: 'dollars' | 'count' | 'percent'
  /** Optional secondary label the card renders under the big number, e.g.
   * "of $200 monthly envelope" or "across 4 buckets". Plain text, no markup. */
  subtitle?: string
  /** Trend series, oldest first. May be empty. */
  trend: TrendPoint[]
  /** Where the card links out to when the user asks for detail. Every kind has
   * one; nothing has a "no drill-in" state because the card always has *some*
   * source worth pointing at, even when it is only the source file in git. */
  drillIn: DrillIn
  /** `configured` = series exists and has at least one row.
   * `empty` = series exists but is header-only (a real state on day one).
   * `unavailable` = the underlying source could not be read; error is the reason. */
  state: 'configured' | 'empty' | 'unavailable'
  /** Human-readable reason when `state === 'unavailable'`. */
  error?: string
  /** Metadata about the source read, for the "as of" line the card renders.
   * Never invented: this is the actual timestamp of the underlying file/read. */
  asOf?: string
}

export type KpiCardKind = 'kpi-spend' | 'kpi-ar' | 'kpi-queue'

export const KPI_KINDS: readonly KpiCardKind[] = ['kpi-spend', 'kpi-ar', 'kpi-queue']

/** Drill-in target. `panelId` navigates within the cockpit; `href` links out. */
export interface DrillIn {
  label: string
  panelId?: string
  href?: string
}

/**
 * The kind → source-path map. Kept in one place so a reader can answer
 * "what does the spend card read" without opening three files.
 */
export const KPI_SOURCES = {
  'kpi-spend': {
    /** The daily spend series maintained by the weekly compile cron. */
    seriesPath: 'wiki/finance/ai-spend.csv',
    /** The envelope this MTD figure is measured against. */
    budgetPath: 'policies/budgets.md',
  },
  'kpi-ar': {
    seriesPath: 'wiki/finance/ar-aging.csv',
    /** No budget file — AR is not measured against an envelope. */
  },
  'kpi-queue': {
    /** The queue directory itself, listed at read time; no CSV. */
    queueDir: 'queue',
  },
} as const

// ---------------------------------------------------------------------------
// Pure helpers (safe to import in client and server code)
// ---------------------------------------------------------------------------

/**
 * Sum credits across a CSV series for entries whose date starts with `ymPrefix`
 * (e.g. `2026-09-`), matching the arithmetic the daily budget monitor uses.
 * Returns `null` when the series has no rows in the month — that's a real
 * "no reading yet" signal the card should render as a dash, not $0.
 */
export function sumMonthCredits(rows: Array<{ date: string; credits: number }>, ymPrefix: string): number | null {
  const inMonth = rows.filter(r => r.date.startsWith(ymPrefix))
  if (inMonth.length === 0) return null
  return inMonth.reduce((a, r) => a + r.credits, 0)
}

/** Roll the (date, model, credits) long format into a daily sparkline. */
export function dailySeries(rows: Array<{ date: string; credits: number }>): TrendPoint[] {
  const byDay = new Map<string, number>()
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.credits)
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }))
}

/**
 * Parse `ai-spend.csv`. Tolerant of a missing trailing newline and blank lines;
 * strict about the header, since a header change is a schema change and should
 * fail loudly rather than silently rewrite the last month.
 */
export function parseAiSpendCsv(text: string): Array<{ date: string; model: string; credits: number }> {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return []
  const header = lines[0].trim()
  if (header !== 'date,model,credits') {
    throw new Error(`ai-spend.csv header changed: got ${JSON.stringify(header)}`)
  }
  const out: Array<{ date: string; model: string; credits: number }> = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 3) continue
    const [date, model, credits] = [parts[0], parts.slice(1, -1).join(',') || parts[1], parts[parts.length - 1]]
    const n = Number(credits)
    if (!Number.isFinite(n)) continue
    out.push({ date: date.trim(), model: model.trim(), credits: n })
  }
  return out
}

/**
 * Parse `ar-aging.csv`. Header is strict for the same reason. Returns rows in
 * source order; the caller sorts if it needs to.
 */
export function parseArAgingCsv(text: string): Array<{
  date: string
  current: number
  past_1_30: number
  past_31_60: number
  past_61_90: number
  past_over_90: number
  total: number
}> {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return []
  const header = lines[0].trim()
  const expected = 'date,current,past_1_30,past_31_60,past_61_90,past_over_90,total'
  if (header !== expected) {
    throw new Error(`ar-aging.csv header changed: got ${JSON.stringify(header)}`)
  }
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',')
    if (p.length < 7) continue
    const nums = p.slice(1, 7).map(Number)
    if (nums.some(n => !Number.isFinite(n))) continue
    out.push({
      date: p[0].trim(),
      current: nums[0],
      past_1_30: nums[1],
      past_31_60: nums[2],
      past_61_90: nums[3],
      past_over_90: nums[4],
      total: nums[5],
    })
  }
  return out
}

/**
 * Read the monthly AI envelope from `policies/budgets.md`. Returns dollars, or
 * null when the file uses the placeholder `$___` — a real "unset" state the
 * card renders honestly rather than pretending is $0.
 *
 * Kept loose on purpose: the policy page is human-authored markdown, and a
 * change to its prose should not brick the cockpit. The regex matches the two
 * shapes that have appeared to date: `Monthly AI envelope: $200` and
 * `AI budget: $200 / month`.
 */
export function parseAiEnvelope(text: string): number | null {
  const placeholder = /monthly\s*ai\s*(envelope|budget|spend)[^\n]*\$_+/i
  if (placeholder.test(text)) return null
  const m = text.match(/(?:monthly\s*ai\s*(?:envelope|budget|spend)[^\n]*\$\s*([0-9][0-9,]*)|(?:ai\s*(?:envelope|budget|spend)[^\n]*\$\s*([0-9][0-9,]*)\s*(?:\/|per)\s*month))/i)
  if (!m) return null
  const raw = (m[1] ?? m[2] ?? '').replace(/,/g, '')
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Chart panel sources — the GitHub reads that produce a `ChartSnapshot`.
 *
 * Server-only. Same reason as `ops-kpi-sources.ts`: keep the fetch client out
 * of the client bundle so importing chart types doesn't drag a GitHub client
 * with it. Every fetcher here is read-only; the chart panel does not write.
 *
 * First and only series today: `ai-burn-vs-envelope`. Reads the same
 * `wiki/finance/ai-spend.csv` the KPI spend card reads (single source of
 * truth — a chart that disagreed with the KPI card would produce a "which
 * one is right?" question with no correct answer), plus `policies/budgets.md`
 * for the horizontal envelope reference line.
 */

import { logger } from '@/lib/logger'
import { opsGithubJson, OpsGitHubError, type FetchImpl } from '@/lib/ops-github'
import type { OpsConfig } from '@/lib/ops-config'
import {
  KPI_SOURCES,
  parseAiEnvelope,
  parseAiSpendCsv,
} from '@/lib/ops-kpi'
import {
  cumulativeSeries,
  utcIsoDate,
  utcMonthStart,
  utcDateNDaysAgo,
  type ChartPoint,
  type ChartSeriesId,
  type ChartSnapshot,
  type ChartWindow,
} from '@/lib/ops-chart'

// ---------------------------------------------------------------------------
// GitHub read helpers (mirror of the KPI sources' shape)
// ---------------------------------------------------------------------------

interface ContentsFile {
  content?: string
  encoding?: string
  sha?: string
  html_url?: string
}

function decode(file: ContentsFile): string {
  return file.encoding === 'base64' && file.content
    ? Buffer.from(file.content, 'base64').toString('utf8')
    : String(file.content ?? '')
}

async function readBrainFile(
  config: OpsConfig,
  path: string,
  deps: { token: string; fetchImpl?: FetchImpl },
): Promise<{ text: string; htmlUrl?: string } | null> {
  try {
    const file = await opsGithubJson<ContentsFile>({
      path: `/repos/${config.brainRepo.repo}/contents/${path}`,
      token: deps.token,
      fetchImpl: deps.fetchImpl,
    })
    return { text: decode(file), htmlUrl: file.html_url }
  } catch (err) {
    if (err instanceof OpsGitHubError && err.status === 404) return null
    throw err
  }
}

// ---------------------------------------------------------------------------
// ai-burn-vs-envelope
// ---------------------------------------------------------------------------

export interface ChartSnapshotDeps {
  token: string
  fetchImpl?: FetchImpl
  /** Injected for tests; defaults to Date.now(). */
  nowMs?: number
}

/**
 * Roll the (date, model, credits) long format into daily totals, filling in
 * zeroes for days inside the window that have no rows in the CSV.
 *
 * Zero-filling is correct here: the daily budget monitor treats a missing day
 * as $0 spent (there simply were no billable actions), so the chart should
 * match. The alternative — nulls-as-gaps — would draw a broken line for a
 * quiet day, which reads as "data missing" rather than "no spend."
 */
function dailyDollarsFilled(
  rows: Array<{ date: string; credits: number }>,
  startIsoDate: string,
  endIsoDate: string,
): ChartPoint[] {
  const byDay = new Map<string, number>()
  for (const r of rows) {
    if (r.date < startIsoDate || r.date > endIsoDate) continue
    // 1 credit == 1 cent; the chart is in dollars.
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.credits / 100)
  }
  const out: ChartPoint[] = []
  // Walk day-by-day so a quiet middle day appears as a zero point rather than
  // a missing one. Do this in UTC to match the archive.
  const cursor = new Date(`${startIsoDate}T00:00:00Z`)
  const end = new Date(`${endIsoDate}T00:00:00Z`)
  while (cursor.getTime() <= end.getTime()) {
    const date = utcIsoDate(cursor.getTime())
    out.push({ date, value: byDay.get(date) ?? 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/**
 * Choose the (startDate, endDate) window bounds for a `ChartWindow`. Same
 * arithmetic as `windowPoints` but expressed as absolute dates so the
 * zero-fill knows the boundary.
 */
function windowBounds(window: ChartWindow, nowMs: number): { start: string; end: string } {
  const end = utcIsoDate(nowMs)
  const start =
    window === 'mtd'
      ? utcMonthStart(nowMs)
      : window === '7d'
        ? utcDateNDaysAgo(nowMs, 6)
        : utcDateNDaysAgo(nowMs, 29)
  return { start, end }
}

export async function fetchAiBurnSnapshot(
  window: ChartWindow,
  config: OpsConfig,
  deps: ChartSnapshotDeps,
): Promise<ChartSnapshot> {
  const nowMs = deps.nowMs ?? Date.now()
  const { start, end } = windowBounds(window, nowMs)
  const base: ChartSnapshot = {
    seriesId: 'ai-burn-vs-envelope',
    window,
    zone: 'z0',
    title: 'AI burn',
    unit: 'dollars',
    points: [],
    headline: { value: null, label: 'burned in window' },
    drillIn: {
      label: 'Open the spend series in the brain repo',
      // We patch this to the actual html_url when the read succeeds below.
      href: `https://github.com/${config.brainRepo.repo}/blob/main/${KPI_SOURCES['kpi-spend'].seriesPath}`,
    },
    state: 'empty',
    asOf: new Date(nowMs).toISOString(),
  }
  try {
    const [spend, envelope] = await Promise.all([
      readBrainFile(config, KPI_SOURCES['kpi-spend'].seriesPath, { token: deps.token, fetchImpl: deps.fetchImpl }),
      readBrainFile(config, KPI_SOURCES['kpi-spend'].budgetPath, { token: deps.token, fetchImpl: deps.fetchImpl }),
    ])

    if (!spend) {
      // Header-only or missing file → real "empty" state on day one after a
      // fresh clone. Render the panel with the shell and say why.
      base.subtitle = 'no spend series yet — the weekly compile will start writing it'
      return base
    }

    const rows = parseAiSpendCsv(spend.text)
    const daily = dailyDollarsFilled(rows, start, end)
    const cumulative = cumulativeSeries(daily)
    const burned = cumulative.length > 0 ? cumulative[cumulative.length - 1].value : null

    const envelopeDollars = envelope ? parseAiEnvelope(envelope.text) : null

    return {
      ...base,
      subtitle:
        window === 'mtd'
          ? envelopeDollars
            ? `month to date against $${envelopeDollars} envelope`
            : 'month to date; envelope unset in policies/budgets.md'
          : window === '7d'
            ? 'last 7 days, cumulative'
            : 'last 30 days, cumulative',
      points: cumulative,
      threshold:
        envelopeDollars !== null && window === 'mtd'
          ? { value: envelopeDollars, label: `$${envelopeDollars} envelope` }
          : undefined,
      headline: {
        value: burned,
        label:
          window === 'mtd'
            ? envelopeDollars
              ? `of $${envelopeDollars} monthly envelope`
              : 'month to date'
            : window === '7d'
              ? 'over the last 7 days'
              : 'over the last 30 days',
      },
      drillIn: {
        label: 'Open the spend series in the brain repo',
        href: spend.htmlUrl ?? base.drillIn.href,
      },
      state: cumulative.length > 0 ? 'configured' : 'empty',
    }
  } catch (err) {
    logger.error({ err, seriesId: 'ai-burn-vs-envelope', window }, 'chart snapshot read failed')
    return {
      ...base,
      state: 'unavailable',
      error: err instanceof Error ? err.message : 'unknown read error',
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * The one entry point the API route calls. Series names are validated at the
 * route boundary; this function's exhaustive switch is what keeps the
 * "adding a new series" checklist small.
 */
export async function fetchChartSnapshot(
  seriesId: ChartSeriesId,
  window: ChartWindow,
  config: OpsConfig,
  deps: ChartSnapshotDeps,
): Promise<ChartSnapshot> {
  switch (seriesId) {
    case 'ai-burn-vs-envelope':
      return fetchAiBurnSnapshot(window, config, deps)
    default: {
      // The type system already made this unreachable, but if a new series is
      // added to the union and someone forgets a case, the panel gets an
      // honest "unavailable" instead of a broken render.
      const _exhaustive: never = seriesId
      throw new Error(`unhandled series: ${String(_exhaustive)}`)
    }
  }
}


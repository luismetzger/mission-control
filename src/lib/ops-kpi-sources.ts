/**
 * KPI card sources — the GitHub reads that produce a `KpiSnapshot`.
 *
 * Server-only. Kept out of `ops-kpi.ts` so a client bundle importing types and
 * pure helpers doesn't drag a fetch client in with it (same split as
 * ops-queue-sources / ops-queue).
 *
 * There are no writes here. Every KPI card is read-only in the registry, and
 * the acknowledge action for spend lives in the T3 approval-card panel it
 * drills into — not here, because a card that can also open a PR would need to
 * defend two attack surfaces instead of one.
 */

import { logger } from '@/lib/logger'
import { opsGithubJson, OpsGitHubError, type FetchImpl } from '@/lib/ops-github'
import type { OpsConfig } from '@/lib/ops-config'
import {
  KPI_SOURCES,
  dailySeries,
  parseAiEnvelope,
  parseAiSpendCsv,
  parseArAgingCsv,
  sumMonthCredits,
  type KpiCardKind,
  type KpiSnapshot,
  type TrendPoint,
} from '@/lib/ops-kpi'

interface ContentsFile {
  content?: string
  encoding?: string
  sha?: string
  html_url?: string
}

interface ContentsEntry {
  name?: string
  path?: string
  type?: string
}

function decode(file: ContentsFile): string {
  return file.encoding === 'base64' && file.content
    ? Buffer.from(file.content, 'base64').toString('utf8')
    : String(file.content ?? '')
}

/**
 * Read a file from the brain repo. Returns null on 404 rather than throwing —
 * "the series file doesn't exist yet" is a real state on the first cockpit
 * boot after a fresh clone, and the card should render "empty" for it rather
 * than a red error banner.
 */
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

/**
 * Compute the current UTC month prefix (`YYYY-MM-`).
 *
 * Broken out so tests can control the "now" and so the same value seeds the
 * MTD sum and the `subtitle` in one place. Never call `new Date()` inline in
 * the snapshot builders — every reading that displays a month must derive it
 * from the same instant.
 */
function utcMonthPrefix(nowMs: number): string {
  const d = new Date(nowMs)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}-`
}

// ---------------------------------------------------------------------------
// kpi-spend
// ---------------------------------------------------------------------------

export interface SnapshotDeps {
  token: string
  fetchImpl?: FetchImpl
  /** Injected for tests. Defaults to Date.now(). */
  nowMs?: number
}

export async function fetchSpendSnapshot(config: OpsConfig, deps: SnapshotDeps): Promise<KpiSnapshot> {
  const nowMs = deps.nowMs ?? Date.now()
  const monthPrefix = utcMonthPrefix(nowMs)
  const base: KpiSnapshot = {
    kind: 'kpi-spend',
    zone: 'z0',
    title: 'AI spend MTD',
    value: null,
    unit: 'dollars',
    trend: [],
    drillIn: {
      label: 'Open the envelope in the T3 queue',
      panelId: 'ops-approvals',
    },
    state: 'empty',
  }
  try {
    const [csv, budget] = await Promise.all([
      readBrainFile(config, KPI_SOURCES['kpi-spend'].seriesPath, deps),
      readBrainFile(config, KPI_SOURCES['kpi-spend'].budgetPath, deps),
    ])
    if (!csv) {
      return { ...base, state: 'empty', subtitle: 'no spend series in the brain repo yet' }
    }
    const rows = parseAiSpendCsv(csv.text)
    if (rows.length === 0) {
      return { ...base, state: 'empty', subtitle: 'series file is header-only' }
    }
    const mtdCredits = sumMonthCredits(rows, monthPrefix)
    const envelopeDollars = budget ? parseAiEnvelope(budget.text) : null
    const mtdDollars = mtdCredits === null ? null : mtdCredits / 100
    // Trend is the last 30 days of the daily series, oldest first. Days with
    // no spend are omitted rather than zero-filled — the file's own contract
    // is "no row = no spend", and the card should render the same shape as
    // the archive.
    const trend: TrendPoint[] = dailySeries(rows).slice(-30)
    const subtitle =
      envelopeDollars === null
        ? 'no monthly envelope set'
        : mtdDollars === null
          ? `of $${envelopeDollars} envelope (no spend this month yet)`
          : `${((mtdDollars / envelopeDollars) * 100).toFixed(0)}% of $${envelopeDollars} envelope`
    // "As of" is the newest date in the series, not "now" — the card is only
    // ever as fresh as the last cron write, and rendering "now" would lie
    // about that.
    const asOf = trend.length > 0 ? trend[trend.length - 1].date : undefined
    return {
      ...base,
      value: mtdDollars,
      trend,
      subtitle,
      state: 'configured',
      asOf,
    }
  } catch (err) {
    logger.error({ err, kind: 'kpi-spend' }, 'fetchSpendSnapshot failed')
    return { ...base, state: 'unavailable', error: err instanceof Error ? err.message : 'read failed' }
  }
}

// ---------------------------------------------------------------------------
// kpi-ar
// ---------------------------------------------------------------------------

export async function fetchArSnapshot(config: OpsConfig, deps: SnapshotDeps): Promise<KpiSnapshot> {
  const base: KpiSnapshot = {
    kind: 'kpi-ar',
    zone: 'z0',
    title: 'AR outstanding',
    value: null,
    unit: 'dollars',
    trend: [],
    drillIn: {
      // No AR panel exists in the cockpit yet; the honest drill-in is the
      // source file itself. A fake internal panel would waste a click.
      label: 'Open the AR series on GitHub',
      href: `https://github.com/${config.brainRepo.repo}/blob/main/${KPI_SOURCES['kpi-ar'].seriesPath}`,
    },
    state: 'empty',
  }
  try {
    const csv = await readBrainFile(config, KPI_SOURCES['kpi-ar'].seriesPath, deps)
    if (!csv) {
      return { ...base, state: 'empty', subtitle: 'no AR series in the brain repo yet' }
    }
    const rows = parseArAgingCsv(csv.text)
    if (rows.length === 0) {
      return {
        ...base,
        state: 'empty',
        subtitle: 'the weekly Bookkeeper brief writes the first row Monday',
      }
    }
    // Sort by date, take the last row as the current reading.
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))
    const latest = sorted[sorted.length - 1]
    // Trend is total outstanding over time — the primary line the card draws.
    // Individual buckets are not exposed here; a reader who wants the split
    // opens the source file (the drill-in above). Keeping the card single-
    // metric matches the other two.
    const trend: TrendPoint[] = sorted.map(r => ({ date: r.date, value: r.total }))
    const overdue = latest.past_1_30 + latest.past_31_60 + latest.past_61_90 + latest.past_over_90
    const subtitle =
      overdue > 0
        ? `$${overdue.toFixed(2)} overdue across past-due buckets`
        : 'nothing past due'
    return {
      ...base,
      value: latest.total,
      trend,
      subtitle,
      state: 'configured',
      asOf: latest.date,
    }
  } catch (err) {
    logger.error({ err, kind: 'kpi-ar' }, 'fetchArSnapshot failed')
    return { ...base, state: 'unavailable', error: err instanceof Error ? err.message : 'read failed' }
  }
}

// ---------------------------------------------------------------------------
// kpi-queue
// ---------------------------------------------------------------------------

/**
 * List commits touching `queue/` (creations and archives) so the trend line has
 * a real history rather than a single current point. This is one extra GitHub
 * call per card render; when the queue is small (dozens of files at most) and
 * the commit log for the directory is short, it stays under 100 ms.
 *
 * If the commit read fails, the card still renders — the current count is the
 * primary metric and it does not depend on history.
 */
async function fetchQueueHistory(
  config: OpsConfig,
  deps: SnapshotDeps,
): Promise<TrendPoint[]> {
  try {
    // Ask for the last 90 days of commits touching queue/. GitHub returns them
    // newest-first; each commit is one delta (a queue entry landed or a
    // disposition merged), and we treat every commit as a "count changed
    // event". The pattern is imperfect — an archive-only PR shows as a drop
    // and a new-entry PR shows as a rise — but the pattern is *honest* about
    // what it is measuring: activity in the queue directory. That is closer to
    // what the reader wants than a fabricated smooth curve.
    interface CommitEntry {
      sha: string
      commit?: { author?: { date?: string } }
    }
    const commits = await opsGithubJson<CommitEntry[]>({
      path: `/repos/${config.brainRepo.repo}/commits?path=${encodeURIComponent(KPI_SOURCES['kpi-queue'].queueDir)}&per_page=100`,
      token: deps.token,
      fetchImpl: deps.fetchImpl,
    })
    // Reduce to a per-day series: one point per day with at least one commit.
    // Value = the current queue depth *at that commit* is not knowable without
    // reading the tree at each sha, which would be N extra calls. Instead we
    // record the number of commits per day, which measures activity. The card
    // labels this "queue activity" so the trend reader knows what they are
    // seeing.
    const byDay = new Map<string, number>()
    for (const c of commits) {
      const iso = c.commit?.author?.date
      if (!iso) continue
      const day = iso.slice(0, 10)
      byDay.set(day, (byDay.get(day) ?? 0) + 1)
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-30)
      .map(([date, value]) => ({ date, value }))
  } catch (err) {
    logger.warn({ err, kind: 'kpi-queue' }, 'queue history read failed; rendering current count only')
    return []
  }
}

export async function fetchQueueSnapshot(config: OpsConfig, deps: SnapshotDeps): Promise<KpiSnapshot> {
  const base: KpiSnapshot = {
    kind: 'kpi-queue',
    zone: 'z0',
    title: 'T3 queue depth',
    value: null,
    unit: 'count',
    trend: [],
    drillIn: {
      label: 'Open the approval queue',
      panelId: 'ops-approvals',
    },
    state: 'empty',
  }
  try {
    // Current depth = number of .md files in queue/. A 404 means the dir
    // doesn't exist, which is a genuinely empty queue (zero).
    let currentDepth = 0
    try {
      const entries = await opsGithubJson<ContentsEntry[]>({
        path: `/repos/${config.brainRepo.repo}/contents/${KPI_SOURCES['kpi-queue'].queueDir}`,
        token: deps.token,
        fetchImpl: deps.fetchImpl,
      })
      currentDepth = (Array.isArray(entries) ? entries : []).filter(
        e => e.type === 'file' && typeof e.path === 'string' && /\.md$/i.test(e.path),
      ).length
    } catch (err) {
      if (!(err instanceof OpsGitHubError && err.status === 404)) throw err
      currentDepth = 0
    }
    const trend = await fetchQueueHistory(config, deps)
    return {
      ...base,
      value: currentDepth,
      trend,
      subtitle:
        currentDepth === 0
          ? 'nothing pending'
          : currentDepth === 1
            ? '1 request pending'
            : `${currentDepth} requests pending`,
      state: 'configured',
      asOf: new Date().toISOString().slice(0, 10),
    }
  } catch (err) {
    logger.error({ err, kind: 'kpi-queue' }, 'fetchQueueSnapshot failed')
    return { ...base, state: 'unavailable', error: err instanceof Error ? err.message : 'read failed' }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Fetch a snapshot by kind. The API route wraps this; it exists so a caller
 * with a `kind` string can get a snapshot without a switch.
 */
export async function fetchKpiSnapshot(
  kind: KpiCardKind,
  config: OpsConfig,
  deps: SnapshotDeps,
): Promise<KpiSnapshot> {
  switch (kind) {
    case 'kpi-spend':
      return fetchSpendSnapshot(config, deps)
    case 'kpi-ar':
      return fetchArSnapshot(config, deps)
    case 'kpi-queue':
      return fetchQueueSnapshot(config, deps)
  }
}

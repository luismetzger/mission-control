/**
 * Table panel sources — the GitHub reads that produce a `TableSnapshot`.
 *
 * Server-only. Kept out of `ops-table.ts` so a client bundle importing types
 * and pure helpers doesn't drag a fetch client in with it (same split as
 * chart-sources / kpi-sources).
 *
 * There are no writes here. Every table panel is read-only in the registry
 * v1; row-level actions are deferred until a table has actions the T3 model
 * supports (a PR against a pipeline file, for example — AR chase-emails do
 * not fit).
 */

import { logger } from '@/lib/logger'
import { opsGithubJson, OpsGitHubError, type FetchImpl } from '@/lib/ops-github'
import type { OpsConfig } from '@/lib/ops-config'
import { parseArAgingCsv } from '@/lib/ops-kpi'
import {
  latestRow,
  type TableId,
  type TableSnapshot,
} from '@/lib/ops-table'

// ---------------------------------------------------------------------------
// GitHub read helpers (mirror of the KPI / chart sources' shape)
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

export interface TableSnapshotDeps {
  token: string
  fetchImpl?: FetchImpl
}

// ---------------------------------------------------------------------------
// ar-aging
// ---------------------------------------------------------------------------

/**
 * Path to the AR aging series in the brain repo. Kept next to the fetcher
 * (rather than in a `TABLE_SOURCES` map) because there is only one table
 * today and centralising for one entry is speculative. Add the map when a
 * second table has a durable path worth naming.
 */
const AR_AGING_PATH = 'wiki/finance/ar-aging.csv'

/**
 * Build the AR aging table snapshot.
 *
 * The rendered shape is the **latest snapshot** — one row per aging bucket
 * with the amount, plus a totals row. This is what the AR conversation
 * actually needs: "how much is in each bucket right now, and what's the
 * total." Historical trend belongs on the KPI card's sparkline (already
 * shipped in 2.2d), not on a table with one column per week — that would
 * scroll sideways and read worse than the source CSV.
 *
 * The columns are ordered `current → past_1_30 → past_31_60 → past_61_90 →
 * past_over_90`, matching how every accounting system displays aging. A
 * reader who has looked at any AR report before can read this one without
 * relearning the layout.
 */
export async function fetchArAgingSnapshot(
  config: OpsConfig,
  deps: TableSnapshotDeps,
): Promise<TableSnapshot> {
  const base: TableSnapshot = {
    tableId: 'ar-aging',
    zone: 'z0',
    title: 'AR aging',
    columns: [
      { key: 'bucket', label: 'Bucket', format: 'text', align: 'left' },
      { key: 'amount', label: 'Amount', format: 'dollars', align: 'right', hasTotal: true },
    ],
    rows: [],
    drillIn: {
      label: 'Open the AR series on GitHub',
      href: `https://github.com/${config.brainRepo.repo}/blob/main/${AR_AGING_PATH}`,
    },
    state: 'empty',
  }

  try {
    const csv = await readBrainFile(config, AR_AGING_PATH, deps)
    if (!csv) {
      return {
        ...base,
        state: 'empty',
        caption: 'The AR series file does not exist in the brain repo yet.',
      }
    }
    const rows = parseArAgingCsv(csv.text)
    if (rows.length === 0) {
      return {
        ...base,
        state: 'empty',
        caption:
          'No snapshots yet — the weekly Bookkeeper brief writes the first row Monday.',
      }
    }
    const latest = latestRow(rows)
    if (!latest) {
      // Defensive; parseArAgingCsv only emits well-formed rows, so this
      // branch fires only if that contract changes.
      return { ...base, state: 'empty', caption: 'Series has rows but none are readable.' }
    }

    // Standard bucket order — every AR aging report from every accounting
    // system in the last century uses this sequence. Deviating here would
    // save nothing and cost a reader's expectation.
    const bucketRows = [
      { id: 'current', bucket: 'Current (not yet due)', amount: latest.current },
      { id: 'past_1_30', bucket: '1–30 days past due', amount: latest.past_1_30 },
      { id: 'past_31_60', bucket: '31–60 days past due', amount: latest.past_31_60 },
      { id: 'past_61_90', bucket: '61–90 days past due', amount: latest.past_61_90 },
      { id: 'past_over_90', bucket: 'Over 90 days past due', amount: latest.past_over_90 },
    ]

    return {
      ...base,
      state: 'configured',
      rows: bucketRows.map(r => ({
        id: r.id,
        cells: { bucket: r.bucket, amount: r.amount },
      })),
      totals: {
        // The stored total is used rather than re-summing here: the
        // Bookkeeper brief asserts `total` matches the sum of the buckets
        // before writing the row, and preferring the stored value keeps a
        // future correction (a manual edit to the CSV) authoritative over
        // whatever the display code would compute. If the two disagree,
        // that is a real signal, and the check belongs in a test on the
        // series file, not silently masked by re-summing at render time.
        label: 'Total',
        cells: { bucket: 'Total', amount: latest.total },
      },
      caption:
        // Names the two things every AR reader needs to know without
        // opening another page: the snapshot date, and the exclusion rule
        // the Bookkeeper brief follows. See wiki/finance/ar-aging.md for
        // the full contract.
        `Latest snapshot: ${latest.date}. Excludes the historical GolfForever invoice (pre-Metzger, no payment expected).`,
      asOf: latest.date,
    }
  } catch (err) {
    logger.error({ err, tableId: 'ar-aging' }, 'fetchArAgingSnapshot failed')
    return {
      ...base,
      state: 'unavailable',
      error: err instanceof Error ? err.message : 'read failed',
    }
  }
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

/**
 * Resolve a `tableId` to its snapshot fetcher. The exhaustive switch is the
 * check that a new table id in `ops-table.ts` cannot compile without also
 * being wired to a real source here.
 */
export async function fetchTableSnapshot(
  tableId: TableId,
  config: OpsConfig,
  deps: TableSnapshotDeps,
): Promise<TableSnapshot> {
  switch (tableId) {
    case 'ar-aging':
      return fetchArAgingSnapshot(config, deps)
    default: {
      // Exhaustiveness assertion — this line failing to compile means a new
      // `TableId` was added without a fetcher and the linker would rather
      // catch it than the panel would rather crash.
      const _exhaustive: never = tableId
      throw new Error(`No fetcher for tableId ${String(_exhaustive)}`)
    }
  }
}

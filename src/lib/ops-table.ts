/**
 * Table panel kinds and their pure helpers (build-plan 2.2h).
 *
 * The table panel is the reusable equivalent of the chart panel: one kind
 * (`table-panel`), many tables. A table is identified at runtime by
 * `tableId`, and every table shares the same rendered shape — header row,
 * body rows, an optional totals row, an empty state — so one React component
 * can draw all of them.
 *
 * ### Why the shape looks like this
 *
 * Every checklist item under 2.2h (invoices, AR aging, leads, backlog) has
 * the same fixed-column structure: a small handful of typed columns, no
 * dynamic pivoting, no row-level actions in v1. If a future table wants row
 * actions (chase this invoice, mark this lead contacted), those live in a
 * gated-action extension that opens a PR — the same T3 discipline the
 * approval card uses. Baking a per-row action prop into the shape today
 * would either lie about the tier or make every no-action table carry an
 * unused affordance.
 *
 * ### Zero row actions in v1, on purpose
 *
 * The checklist mentions "row-level gated actions" as part of 2.2h. The
 * first table is AR aging, whose only meaningful action is "chase invoice
 * N", which is an email, not a git PR. Wiring a row-action affordance for
 * a table whose actions cannot be represented in the T3 model would encode
 * the wrong shape into the kind. Row actions land when a table has actions
 * the model supports (e.g. a lead that transitions status via a PR to a
 * pipeline file).
 *
 * ### Formatting is a display hint, never data
 *
 * The stored value on a `TableCell` is the raw number/string; the column
 * declares how the panel should render it. This mirrors the KPI card's
 * treatment of `unit` — the archive stays canonical, and a display change
 * never rewrites what happened.
 */

import type { Zone } from '@/lib/ops-registry'

/** The set of table ids the registry knows about today. Add here + a fetcher
 * in `ops-table-sources.ts`, and it becomes reachable by the panel router. */
export type TableId = 'ar-aging'

export const TABLE_IDS: readonly TableId[] = ['ar-aging']

export function isTableId(v: string): v is TableId {
  return (TABLE_IDS as readonly string[]).includes(v)
}

/** How a column formats. The panel decides the actual glyph; storing the
 * hint here keeps a table's shape self-describing without smuggling
 * presentation into the source read. */
export type TableColumnFormat = 'text' | 'number' | 'dollars' | 'date'

/** How a numeric column aligns visually. Text left, numbers right — a rule
 * every ledger has followed for a hundred years because it makes columns
 * add up by eye. */
export type TableColumnAlign = 'left' | 'right'

export interface TableColumn {
  /** Machine key referenced by `TableRow.cells`. */
  key: string
  /** Header text the panel renders. */
  label: string
  format: TableColumnFormat
  align: TableColumnAlign
  /** When true, the totals row (if present) renders a value under this
   * column. Not every column has a total (a date column doesn't). */
  hasTotal?: boolean
}

/** One cell of a row. `null` renders as an em-dash — never as zero. */
export type TableCellValue = string | number | null

export interface TableRow {
  /** Stable identifier for React reconciliation. Rows without a natural id
   * (e.g. AR buckets keyed by column) use the column key or the row's date. */
  id: string
  cells: Record<string, TableCellValue>
}

/** Optional totals row rendered under the body. Kept as a first-class
 * concept because every ledger-style table (AR, invoices, budget) needs it,
 * and reconstructing "did the panel remember to sum this column" from ad-hoc
 * footer markup is exactly the drift a shape should prevent. */
export interface TableTotals {
  /** Label rendered in the leftmost column (typically 'Total'). */
  label: string
  cells: Record<string, TableCellValue>
}

/**
 * The rendered shape a table panel consumes.
 *
 * `state` distinguishes three real situations the panel renders differently:
 *   - `configured` — the source has rows; render them.
 *   - `empty`      — the source exists but has no rows yet (day-one state
 *                    for AR aging, which is header-only until the next
 *                    Monday cron). Render an explicit "no rows yet" banner
 *                    with a source link, not a blank table.
 *   - `unavailable`— the underlying source could not be read; the panel
 *                    shows the reason.
 */
export interface TableSnapshot {
  tableId: TableId
  zone: Zone
  title: string
  columns: TableColumn[]
  rows: TableRow[]
  totals?: TableTotals
  state: 'configured' | 'empty' | 'unavailable'
  /** Human-readable reason when `state === 'unavailable'`. */
  error?: string
  /** Optional caption rendered above the table, e.g. "As of 2026-09-07 —
   * excludes the historical GolfForever invoice." Plain text. */
  caption?: string
  /** Where the panel links out to for "see the source." Always populated;
   * even an empty table has a source worth pointing at. */
  drillIn: {
    label: string
    href: string
  }
  /** Metadata about the source read, for the "as of" line the panel renders.
   * Never invented: this is the actual timestamp of the underlying source. */
  asOf?: string
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Sum a numeric column across rows, treating null as "no reading" (skipped),
 * not as zero. Returns null when the column has no numeric readings at all —
 * a totals row for an empty column renders a dash, not $0.
 *
 * The AR aging series stores a `total` column per row already, but this helper
 * is what a future table without a stored total would use. Kept as a pure
 * function so the totals row's arithmetic is trivial to unit-test.
 */
export function sumColumn(rows: TableRow[], key: string): number | null {
  let out = 0
  let seen = 0
  for (const r of rows) {
    const v = r.cells[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      out += v
      seen++
    }
  }
  return seen > 0 ? out : null
}

/**
 * Read the most recent row from a series that stores newest-last (source
 * order for append-only CSVs like AR aging). Returns null when the series
 * is empty.
 *
 * Extracted as a helper because "the last N snapshots" is a very common
 * table-panel projection (see AR aging's default view: latest snapshot as
 * the primary row, plus an optional history rendering).
 */
export function latestRow<T extends { date: string }>(rows: T[]): T | null {
  if (rows.length === 0) return null
  // Sort by date so a source that isn't strictly append-only still resolves
  // "most recent" correctly. Same rule the KPI cards use.
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  return sorted[sorted.length - 1] ?? null
}

/**
 * Compute the delta between two rows for each numeric column. Returns null
 * when either input is missing — a table showing "change since last week"
 * on its first-ever row has nothing to compare against, and rendering a
 * false zero would suggest the number was unchanged.
 */
export function rowDelta(
  latest: Record<string, TableCellValue> | undefined,
  previous: Record<string, TableCellValue> | undefined,
): Record<string, number | null> {
  if (!latest || !previous) return {}
  const out: Record<string, number | null> = {}
  for (const key of Object.keys(latest)) {
    const a = latest[key]
    const b = previous[key]
    if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
      out[key] = a - b
    } else {
      out[key] = null
    }
  }
  return out
}

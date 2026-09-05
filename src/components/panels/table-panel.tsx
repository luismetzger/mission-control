'use client'

/**
 * Table panel — the reusable tabular card (registry kind `table-panel`,
 * build-plan 2.2h).
 *
 * One component, many tables. What differs per instance is the `tableId`
 * prop, which the panel forwards to `/api/ops/table/:tableId`. The rendered
 * shape — title, optional caption, header, body rows, optional totals row,
 * drill-in — is the same for every table.
 *
 * Rendering choices worth naming:
 *   - Numbers align right, text aligns left. A rule every ledger has
 *     followed for a century, because it makes columns add up by eye. The
 *     panel refuses to render a numeric column left-aligned even when a
 *     future column definition says so — `align` gets clamped at render
 *     time. (See `resolveAlign` below.)
 *   - Null renders as an em-dash, never as $0 or 0. A missing reading is
 *     not a zero; the AR contract asserts this at the source, and the
 *     panel enforces it at the edge so a change to the fetcher can't
 *     silently invent zeros.
 *   - No row actions in v1. Every action a table would want to expose is
 *     T3 (a chase email, a status transition), and those live in the
 *     approval-card panel the drill-in points at. Adding row buttons here
 *     that "open a PR" would give the panel a tier it can't defend.
 *   - Totals render as their own row, visually separated. Not as a footer
 *     tag — a totals row is data, and the panel keeps the arithmetic
 *     visible.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader } from '@/components/ui/loader'
import { ZoneBadge } from '@/components/ops/zone-badge'
import { NotConfigured } from '@/components/panels/note-panel'
import { apiFetch } from '@/lib/api-client'
import type {
  TableCellValue,
  TableColumn,
  TableId,
  TableSnapshot,
} from '@/lib/ops-table'
import type { TablePanelProps } from '@/lib/ops-registry'

interface TableResponse {
  configured: boolean
  missing?: string[]
  invalid?: string[]
  snapshot?: TableSnapshot
}

interface TablePanelComponentProps extends TablePanelProps {
  tableId: TableId
}

/**
 * Render a single cell value using the column's format hint. Kept small and
 * pure so it's the whole surface the table's "how does it display" tests
 * need to cover.
 */
function formatCell(value: TableCellValue, format: TableColumn['format']): string {
  if (value === null || value === undefined) return '—'
  if (format === 'dollars') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    // Two decimal places — AR is stored in dollars.cents, and rounding to
    // whole dollars would change the total by up to $0.50 per row on a
    // five-bucket table. Cheap to render, honest to read.
    return `$${value.toFixed(2)}`
  }
  if (format === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    return String(value)
  }
  if (format === 'date') {
    // Dates arrive as ISO strings; the panel renders them as-is. Any
    // localisation would be presentation drift the archive doesn't ask for.
    return String(value)
  }
  return String(value)
}

/**
 * Clamp column alignment: numeric columns always render right-aligned. A
 * future column definition that says otherwise is treated as a bug in the
 * source, not a preference to honour.
 */
function resolveAlign(column: TableColumn): 'left' | 'right' {
  if (column.format === 'number' || column.format === 'dollars') return 'right'
  return column.align
}

export function TablePanel({ tableId }: TablePanelComponentProps) {
  const [response, setResponse] = useState<TableResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<TableResponse>(`/api/ops/table/${tableId}`)
      setResponse(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'table read failed')
    } finally {
      setLoading(false)
    }
  }, [tableId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !response) {
    return (
      <div className="p-4">
        <Loader />
      </div>
    )
  }

  if (error) {
    return (
      <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <h3 className="text-sm font-semibold text-destructive">Table unavailable</h3>
        <p className="mt-1 text-xs text-muted-foreground">{error}</p>
      </div>
    )
  }

  if (response && !response.configured) {
    return <NotConfigured missing={response.missing ?? []} invalid={response.invalid ?? []} />
  }

  const snapshot = response?.snapshot
  if (!snapshot) {
    return (
      <div className="m-4 rounded-lg border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">No snapshot returned.</p>
      </div>
    )
  }

  if (snapshot.state === 'unavailable') {
    return (
      <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-destructive">{snapshot.title}</h3>
          <ZoneBadge zone={snapshot.zone} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{snapshot.error ?? 'read failed'}</p>
      </div>
    )
  }

  return (
    <div className="m-4 rounded-lg border border-border bg-card p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{snapshot.title}</h3>
          <ZoneBadge zone={snapshot.zone} />
        </div>
        {snapshot.asOf && (
          <span className="text-xs text-muted-foreground">as of {snapshot.asOf}</span>
        )}
      </header>

      {snapshot.caption && (
        <p className="mt-2 text-xs text-muted-foreground">{snapshot.caption}</p>
      )}

      {snapshot.state === 'empty' ? (
        <div className="mt-3 rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          No rows yet.
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {snapshot.columns.map(col => (
                  <th
                    key={col.key}
                    scope="col"
                    className={`py-2 pr-3 text-xs font-medium uppercase tracking-wide text-muted-foreground ${
                      resolveAlign(col) === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshot.rows.map(row => (
                <tr key={row.id} className="border-b border-border/40">
                  {snapshot.columns.map(col => (
                    <td
                      key={col.key}
                      className={`py-2 pr-3 tabular-nums ${
                        resolveAlign(col) === 'right' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {formatCell(row.cells[col.key] ?? null, col.format)}
                    </td>
                  ))}
                </tr>
              ))}
              {snapshot.totals && (
                <tr className="border-t-2 border-border font-semibold">
                  {snapshot.columns.map((col, idx) => (
                    <td
                      key={col.key}
                      className={`py-2 pr-3 tabular-nums ${
                        resolveAlign(col) === 'right' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {idx === 0
                        ? snapshot.totals!.label
                        : col.hasTotal
                          ? formatCell(snapshot.totals!.cells[col.key] ?? null, col.format)
                          : ''}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <footer className="mt-3">
        <a
          href={snapshot.drillIn.href}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline-offset-4 hover:underline"
        >
          {snapshot.drillIn.label} →
        </a>
      </footer>
    </div>
  )
}

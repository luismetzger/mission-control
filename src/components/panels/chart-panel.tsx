'use client'

/**
 * Chart panel — the reusable time-series card (registry kind `chart-panel`,
 * build-plan 2.2e).
 *
 * One component, many series. What differs per instance is the `seriesId`
 * prop, which the panel forwards to `/api/ops/chart/:seriesId?window=…`. The
 * rendered shape — title, subtitle, big number, plotted line, optional
 * threshold, three-window toggle, drill-in — is the same for every series.
 *
 * Rendering choices worth naming:
 *   - Inline SVG, no chart library. Same trade as the KPI sparkline: a
 *     200×80 shape with one line and one reference doesn't need axes, ticks
 *     and tooltips, and adding a library for this size taxes the bundle
 *     without giving the reader anything they couldn't see already.
 *   - The threshold line renders on top of the plot, dashed, labeled at the
 *     right edge. When the line reaches or crosses the threshold, the
 *     crossing point is *not* highlighted — the whole line above the
 *     threshold reads as "over" without a special glyph, and drawing an
 *     alert dot at the crossing would give the panel a job (alerting) that
 *     belongs to the daily budget monitor.
 *   - Nulls create gaps in the line (same rule as the KPI sparkline). A
 *     null in the source is a missing reading, not a zero.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader } from '@/components/ui/loader'
import { ZoneBadge } from '@/components/ops/zone-badge'
import { NotConfigured } from '@/components/panels/note-panel'
import { apiFetch } from '@/lib/api-client'
import {
  CHART_WINDOWS,
  type ChartPoint,
  type ChartSeriesId,
  type ChartSnapshot,
  type ChartWindow,
} from '@/lib/ops-chart'
import type { ChartPanelProps } from '@/lib/ops-registry'

interface ChartResponse {
  configured: boolean
  missing?: string[]
  invalid?: string[]
  snapshot?: ChartSnapshot
}

interface ChartPanelComponentProps extends ChartPanelProps {
  seriesId: ChartSeriesId
}

function formatValue(value: number | null, unit: ChartSnapshot['unit']): string {
  if (value === null) return '—'
  if (unit === 'dollars') return `$${value.toFixed(2)}`
  if (unit === 'percent') return `${value.toFixed(0)}%`
  return String(value)
}

/**
 * Full chart in inline SVG. Width is responsive via viewBox; height is fixed
 * so the panel doesn't jump on window resize.
 *
 * The plotted line is a series of segments (rather than a single polyline)
 * so a null on either endpoint creates a real gap. The threshold is one
 * dashed horizontal at `t.value`. The y-scale runs from 0 to
 * `max(threshold, max(points)) * 1.1`, so a line under the threshold reads
 * as safe and a line over reads as over — the panel does not zoom to hide
 * either state.
 */
function ChartFigure({
  points,
  threshold,
  unit,
  ariaLabel,
}: {
  points: ChartPoint[]
  threshold?: { value: number; label: string }
  unit: ChartSnapshot['unit']
  ariaLabel: string
}) {
  const nonNull = points.filter(p => p.value !== null) as Array<{ date: string; value: number }>
  if (nonNull.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center text-xs text-foreground/40" aria-label={ariaLabel}>
        no data in this window
      </div>
    )
  }

  const width = 320
  const height = 80
  const padX = 4
  const padY = 8
  const usableW = width - padX * 2
  const usableH = height - padY * 2

  const dataMax = Math.max(...nonNull.map(p => p.value))
  const yMax = Math.max(dataMax, threshold?.value ?? 0) * 1.1 || 1
  // If yMax rounds to 0 (all zeros and no threshold), still clamp to 1 so
  // dividing yields real numbers.

  const xFor = (i: number) =>
    padX + (points.length === 1 ? usableW / 2 : (i / (points.length - 1)) * usableW)
  const yFor = (v: number) => padY + usableH - (v / yMax) * usableH

  // Build segments so nulls create gaps rather than being smoothed over.
  const segments: string[] = []
  let currentPath = ''
  points.forEach((p, i) => {
    if (p.value === null) {
      if (currentPath) segments.push(currentPath)
      currentPath = ''
      return
    }
    const cmd = currentPath === '' ? 'M' : 'L'
    currentPath += `${cmd}${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)} `
  })
  if (currentPath) segments.push(currentPath)

  const thresholdY = threshold ? yFor(threshold.value) : null
  // Fill for area under the line. Drawn under the polyline. Kept subtle;
  // this is not the primary readable feature, it just anchors the eye.
  const areaPath = (() => {
    if (points.length === 0) return ''
    let path = ''
    let inSegment = false
    let firstX = 0
    points.forEach((p, i) => {
      if (p.value === null) {
        if (inSegment) {
          path += `L${xFor(i - 1).toFixed(1)},${(height - padY).toFixed(1)}L${firstX.toFixed(1)},${(height - padY).toFixed(1)}Z `
          inSegment = false
        }
        return
      }
      if (!inSegment) {
        firstX = xFor(i)
        path += `M${firstX.toFixed(1)},${(height - padY).toFixed(1)}L${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)} `
        inSegment = true
      } else {
        path += `L${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)} `
      }
    })
    if (inSegment) {
      const lastI = points.length - 1
      path += `L${xFor(lastI).toFixed(1)},${(height - padY).toFixed(1)}L${firstX.toFixed(1)},${(height - padY).toFixed(1)}Z `
    }
    return path
  })()

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-20 w-full"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="none"
    >
      <path d={areaPath} className="fill-primary/10" />
      {thresholdY !== null && threshold && (
        <>
          <line
            x1={padX}
            x2={width - padX}
            y1={thresholdY}
            y2={thresholdY}
            className="stroke-destructive/60"
            strokeWidth="1"
            strokeDasharray="4 3"
          />
          <text
            x={width - padX}
            y={thresholdY - 2}
            textAnchor="end"
            className="fill-destructive/70 text-[9px]"
          >
            {threshold.label}
          </text>
        </>
      )}
      {segments.map((d, i) => (
        <path
          key={i}
          d={d}
          className="stroke-primary"
          fill="none"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}

export function ChartPanel({ seriesId }: ChartPanelComponentProps) {
  // The window persists as a client-side state; a URL param would let it
  // survive reload, but the panel is embedded (not a top-level route on its
  // own), so URL state would leak into the parent's params. If a top-level
  // chart route is ever added, that page can hoist the state.
  const [window, setWindow] = useState<ChartWindow>('mtd')
  const [response, setResponse] = useState<ChartResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<ChartResponse>(`/api/ops/chart/${seriesId}?window=${window}`)
      setResponse(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'chart read failed')
    } finally {
      setLoading(false)
    }
  }, [seriesId, window])

  useEffect(() => {
    load()
  }, [load])

  if (loading && !response) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-card/80">
        <Loader />
      </div>
    )
  }

  if (response && !response.configured) {
    return (
      <NotConfigured
        missing={response.missing ?? []}
        invalid={response.invalid ?? []}
      />
    )
  }

  const snapshot = response?.snapshot

  return (
    <div className="rounded-xl border border-border bg-card/80 px-4 py-3 backdrop-blur-xs">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{snapshot?.title ?? 'Chart'}</h3>
            {snapshot && <ZoneBadge zone={snapshot.zone} />}
          </div>
          {snapshot?.subtitle && (
            <p className="text-[11px] text-foreground/60">{snapshot.subtitle}</p>
          )}
        </div>
        <fieldset
          className="flex shrink-0 gap-0.5 rounded-md border border-border p-0.5"
          aria-label="Change window"
        >
          {CHART_WINDOWS.map(w => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={
                w === window
                  ? 'rounded px-2 py-0.5 text-[10px] font-medium bg-primary/15 text-primary'
                  : 'rounded px-2 py-0.5 text-[10px] text-foreground/60 hover:text-foreground'
              }
              aria-pressed={w === window}
            >
              {w.toUpperCase()}
            </button>
          ))}
        </fieldset>
      </div>

      {snapshot?.state === 'unavailable' ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          source unavailable{snapshot.error ? `: ${snapshot.error}` : ''}
        </div>
      ) : (
        <>
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold">
              {snapshot ? formatValue(snapshot.headline.value, snapshot.unit) : '—'}
            </span>
            {snapshot && (
              <span className="text-[11px] text-foreground/60">{snapshot.headline.label}</span>
            )}
          </div>
          {snapshot && (
            <ChartFigure
              points={snapshot.points}
              threshold={snapshot.threshold}
              unit={snapshot.unit}
              ariaLabel={`${snapshot.title} over ${window}`}
            />
          )}
        </>
      )}

      {error && (
        <div className="mt-2 text-[11px] text-destructive/80">read error: {error}</div>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-foreground/50">
        {snapshot?.asOf ? (
          <span>
            as of {new Date(snapshot.asOf).toLocaleString(undefined, {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </span>
        ) : (
          <span />
        )}
        {snapshot?.drillIn && (
          <a
            href={snapshot.drillIn.href}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {snapshot.drillIn.label} →
          </a>
        )}
      </div>
    </div>
  )
}

'use client'

/**
 * KPI card panel — the cockpit telemetry strip's individual card (registry
 * kinds `kpi-spend`, `kpi-ar`, `kpi-queue`).
 *
 * One component renders all three. See `src/lib/ops-registry.ts` for why the
 * three kinds are three registrations sharing this file rather than one kind
 * with a source prop — the short version is that action tier and drill-in
 * target live in the registry with the kind, so a rendering choice never
 * changes them.
 *
 * The card is intentionally small: a title, a big number, a subtitle, a
 * 30-point sparkline, a zone badge, and one drill-in link. No secondary
 * actions — the acknowledge for the spend card lives in the T3 panel it
 * points at, because a card that could also open a PR would need to defend
 * two attack surfaces instead of one.
 *
 * Three states worth rendering distinctly:
 *   - `configured`   the series has a reading; draw the number and the line.
 *   - `empty`        the series exists but has no rows yet (real on day one).
 *                    Draw a dash and the reason, not a zero — a zero would
 *                    read as a false current reading.
 *   - `unavailable`  the source could not be read. Say why, plainly. The card
 *                    still shows its title so the layout stays stable.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader } from '@/components/ui/loader'
import { ZoneBadge } from '@/components/ops/zone-badge'
import { NotConfigured } from '@/components/panels/note-panel'
import { apiFetch } from '@/lib/api-client'
import { panelHref } from '@/lib/navigation'
import type { KpiCardKind, KpiSnapshot, TrendPoint } from '@/lib/ops-kpi'
import type { KpiCardProps } from '@/lib/ops-registry'

interface KpiResponse {
  configured: boolean
  missing?: string[]
  invalid?: string[]
  snapshot?: KpiSnapshot
}

interface KpiCardPanelProps extends KpiCardProps {
  kind: KpiCardKind
}

/** Format a value for the big number. Null renders as an em-dash to say "no
 * reading" without picking a wrong number. */
function formatValue(value: number | null, unit: KpiSnapshot['unit']): string {
  if (value === null) return '—'
  if (unit === 'dollars') {
    // Whole dollars for readability; cents on the sparkline would add noise
    // without adding information at this size. The source stores precision.
    return `$${value.toFixed(0)}`
  }
  if (unit === 'percent') return `${value.toFixed(0)}%`
  return String(value)
}

/**
 * Sparkline in a bare inline SVG — no chart library.
 *
 * A KPI trend line is a shape, not an axis-labelled chart; a full charting
 * dependency for a 120×32 image is a large tax on the bundle for something a
 * `polyline` renders in six lines. If a card later needs axes or tooltips, it
 * gets its own component, not a knob here.
 *
 * Nulls create gaps: the line breaks at a missing day and picks up on the
 * next reading. A line that skips over nulls silently would draw a smoother
 * trend than the archive contains.
 */
function Sparkline({ points, ariaLabel }: { points: TrendPoint[]; ariaLabel: string }) {
  if (points.length === 0) {
    return (
      <div className="h-8 text-[10px] text-foreground/40" aria-label={ariaLabel}>
        no trend yet
      </div>
    )
  }
  const width = 120
  const height = 32
  const values = points.map(p => p.value ?? 0)
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 1)
  const range = max - min || 1
  const dx = points.length > 1 ? width / (points.length - 1) : 0
  const segments: string[] = []
  let current: string[] = []
  for (let i = 0; i < points.length; i++) {
    const v = points[i].value
    if (v === null) {
      if (current.length > 0) segments.push(current.join(' '))
      current = []
      continue
    }
    const x = i * dx
    const y = height - ((v - min) / range) * (height - 2) - 1
    current.push(`${current.length === 0 ? 'M' : 'L'} ${x.toFixed(1)},${y.toFixed(1)}`)
  }
  if (current.length > 0) segments.push(current.join(' '))
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-8 w-full text-primary/70"
      role="img"
      aria-label={ariaLabel}
    >
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  )
}

function DrillInLink({ drillIn }: { drillIn: KpiSnapshot['drillIn'] }) {
  if (drillIn.panelId) {
    return (
      <Link
        href={panelHref(drillIn.panelId)}
        className="text-[11px] font-medium text-primary underline underline-offset-2 hover:no-underline"
      >
        {drillIn.label} →
      </Link>
    )
  }
  if (drillIn.href) {
    return (
      <a
        href={drillIn.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] font-medium text-primary underline underline-offset-2 hover:no-underline"
      >
        {drillIn.label} ↗
      </a>
    )
  }
  return null
}

export function KpiCardPanel({ kind }: KpiCardPanelProps) {
  const [state, setState] = useState<{ loading: boolean; error?: string; response?: KpiResponse }>({
    loading: true,
  })

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: undefined }))
    try {
      const response = await apiFetch<KpiResponse>(`/api/ops/kpi/${kind}`)
      setState({ loading: false, response })
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : 'failed to load' })
    }
  }, [kind])

  useEffect(() => {
    void load()
  }, [load])

  if (state.loading && !state.response) {
    return (
      <div className="flex h-full items-center justify-center rounded border border-border/40 bg-background/40 p-4">
        <Loader />
      </div>
    )
  }

  if (state.response && !state.response.configured) {
    return <NotConfigured missing={state.response.missing ?? []} invalid={state.response.invalid} />
  }

  if (state.error) {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-400">
        {state.error}
      </div>
    )
  }

  const snapshot = state.response?.snapshot
  if (!snapshot) return null

  return (
    <div className="flex h-full flex-col gap-2 rounded border border-border/40 bg-background/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-medium uppercase tracking-wide text-foreground/60">
            {snapshot.title}
          </div>
          {snapshot.subtitle ? (
            <div className="mt-0.5 truncate text-[10px] text-foreground/50">{snapshot.subtitle}</div>
          ) : null}
        </div>
        <ZoneBadge zone={snapshot.zone} />
      </div>

      <div className="flex items-baseline gap-2">
        <span
          className={`text-2xl font-semibold tabular-nums ${
            snapshot.state === 'configured' ? 'text-foreground' : 'text-foreground/40'
          }`}
        >
          {formatValue(snapshot.value, snapshot.unit)}
        </span>
        {snapshot.state === 'empty' ? (
          <span className="text-[10px] text-foreground/40">no reading yet</span>
        ) : null}
        {snapshot.state === 'unavailable' ? (
          <span className="text-[10px] text-red-400/80" title={snapshot.error}>
            source unavailable
          </span>
        ) : null}
      </div>

      <Sparkline points={snapshot.trend} ariaLabel={`${snapshot.title} trend`} />

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] text-foreground/40">
          {snapshot.asOf ? `as of ${snapshot.asOf}` : ''}
        </span>
        <DrillInLink drillIn={snapshot.drillIn} />
      </div>
    </div>
  )
}

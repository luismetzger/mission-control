'use client'

/**
 * Run timeline — read-only ledger view (registry kind `run-timeline`).
 *
 * Three sources per repo, as defined by policies/run-ledger.md: Actions runs,
 * open automation PRs, and `log.md`. Manual refresh plus a configurable
 * auto-refresh that is floored at 60s — no tighter polling loops.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { ZoneBadge } from '@/components/ops/zone-badge'
import { NotConfigured } from '@/components/panels/note-panel'
import { apiFetch } from '@/lib/api-client'
import { MIN_REFRESH_MS, STALE_PR_DAYS } from '@/lib/ops-timeline'
import type { TimelineLogEntry, TimelinePull, TimelineRun } from '@/lib/ops-timeline'
import type { RunTimelineProps } from '@/lib/ops-registry'

interface TimelineResponse {
  configured: boolean
  missing?: string[]
  invalid?: string[]
  runs: TimelineRun[]
  pulls: TimelinePull[]
  logEntries: TimelineLogEntry[]
  errors: string[]
  generatedAt?: string
}

type TabId = 'runs' | 'pulls' | 'log'

function timeAgo(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return '—'
  const minutes = Math.floor((Date.now() - parsed) / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function RunTimelinePanel({ refreshIntervalMs }: RunTimelineProps = {}) {
  const interval = Math.max(refreshIntervalMs ?? MIN_REFRESH_MS, MIN_REFRESH_MS)
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [tab, setTab] = useState<TabId>('runs')
  const loadRef = useRef<() => void>(() => {})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await apiFetch<TimelineResponse>('/api/ops/timeline', { cache: 'no-store' })
      setData(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the run timeline')
    } finally {
      setLoading(false)
    }
  }, [])

  loadRef.current = load

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => loadRef.current(), interval)
    return () => clearInterval(id)
  }, [autoRefresh, interval])

  const failedRuns = useMemo(() => (data?.runs ?? []).filter(r => r.failed).length, [data?.runs])
  const stalledPulls = useMemo(() => (data?.pulls ?? []).filter(p => p.stalled).length, [data?.pulls])

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader variant="inline" label="Loading timeline" />
      </div>
    )
  }

  if (data && !data.configured) {
    return <NotConfigured missing={data.missing ?? []} invalid={data.invalid} />
  }

  const tabs: Array<[TabId, string]> = [
    ['runs', `Runs (${data?.runs.length ?? 0})`],
    ['pulls', `Open automation PRs (${data?.pulls.length ?? 0})`],
    ['log', `log.md (${data?.logEntries.length ?? 0})`],
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Run timeline</h2>
          <p className="text-2xs text-muted-foreground">
            {failedRuns > 0 ? `${failedRuns} non-success run(s). ` : 'No failed runs. '}
            {stalledPulls > 0
              ? `${stalledPulls} PR(s) open longer than ${STALE_PR_DAYS} days.`
              : `No PR older than ${STALE_PR_DAYS} days.`}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs text-muted-foreground">
            {data?.generatedAt ? `updated ${timeAgo(data.generatedAt)}` : ''}
          </span>
          <Button variant="outline" size="xs" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button variant={autoRefresh ? 'success' : 'outline'} size="xs" onClick={() => setAutoRefresh(v => !v)}>
            Auto {Math.round(interval / 1000)}s {autoRefresh ? 'on' : 'off'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="m-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>
      )}
      {data?.errors && data.errors.length > 0 && (
        <div className="mx-4 mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
          {data.errors.map(e => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      <div className="flex shrink-0 gap-1 border-b border-border px-4">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-xs transition-smooth ${
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'runs' && (
          <div className="space-y-2">
            {(data?.runs ?? []).length === 0 && <p className="text-xs text-muted-foreground">No workflow runs.</p>}
            {(data?.runs ?? []).map(run => (
              <a
                key={`${run.repo}:${run.id}`}
                href={run.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center gap-3 rounded-lg border p-3 transition-smooth hover:bg-secondary ${
                  run.failed ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-card'
                }`}
              >
                <ZoneBadge zone={run.zone} />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{run.name}</span>
                <span className="hidden font-mono text-2xs text-muted-foreground md:inline">{run.branch}</span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-2xs ${
                    run.failed
                      ? 'bg-red-500/15 text-red-400'
                      : run.status !== 'completed'
                        ? 'bg-amber-500/10 text-amber-400'
                        : 'bg-green-500/10 text-green-400'
                  }`}
                >
                  {run.conclusion ?? run.status}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">{timeAgo(run.createdAt)}</span>
              </a>
            ))}
          </div>
        )}

        {tab === 'pulls' && (
          <div className="space-y-2">
            {(data?.pulls ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No open automation pull requests.</p>
            )}
            {(data?.pulls ?? []).map(pr => (
              <a
                key={`${pr.repo}:${pr.number}`}
                href={pr.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center gap-3 rounded-lg border p-3 transition-smooth hover:bg-secondary ${
                  pr.stalled ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-card'
                }`}
              >
                <ZoneBadge zone={pr.zone} />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  #{pr.number} {pr.title}
                </span>
                <span className="hidden font-mono text-2xs text-muted-foreground md:inline">{pr.branch}</span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-2xs ${
                    pr.stalled ? 'bg-amber-500/15 text-amber-400' : 'text-muted-foreground'
                  }`}
                >
                  {pr.ageDays}d old{pr.stalled ? ' · stalled' : ''}
                </span>
              </a>
            ))}
          </div>
        )}

        {tab === 'log' && (
          <div className="space-y-2">
            {(data?.logEntries ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No log entries.</p>
            )}
            {(data?.logEntries ?? []).map((entry, i) => (
              <div key={`${entry.repo}:${entry.date}:${i}`} className="rounded-lg border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ZoneBadge zone={entry.zone} />
                  <span className="font-mono text-2xs text-muted-foreground">{entry.date}</span>
                  <span className="text-2xs text-foreground/80">{entry.who}</span>
                </div>
                <p className="mt-1.5 text-xs text-foreground/85">{entry.what}</p>
                {entry.why && <p className="mt-1 text-2xs text-muted-foreground">why: {entry.why}</p>}
                {entry.source && (
                  <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground/70">
                    source: {entry.source}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

'use client'

/**
 * Diff panel — the reusable proposed-changes viewer (registry kind
 * `diff-panel`, build-plan 2.2g).
 *
 * One component, many diffs. Same one-kind-many-instances shape as chart
 * (2.2e) and table (2.2h): what differs per instance is `diffId`, forwarded
 * to `/api/ops/diff/:diffId`. Every diff has the same rendered shape — a
 * list of PRs, each expandable into per-file unified patches — because the
 * shape is what a reviewer sees, not what the retro job wrote.
 *
 * Rendering choices worth naming:
 *
 *   - Native `<details>` / `<summary>` for the per-PR expander. It is
 *     keyboard-accessible for free, prints as expanded by default, and
 *     survives a JS-off render. A custom accordion component adds
 *     dependencies and a11y footguns for no rendering benefit.
 *
 *   - Patches render in a monospace `<pre>` with lines colour-cued by
 *     leading character (+ / - / space / @). No syntax highlighting: the
 *     diff is what a reviewer approves, not a prettified version of it,
 *     and any transformation is a lie about what will land on main.
 *
 *   - A file with `patchTruncated` renders an explicit banner ("patch
 *     omitted by GitHub — file too large") rather than an empty box. The
 *     statistics (+N/-M) still come from GitHub's own count, so the
 *     reviewer knows the file changed even without the text.
 *
 *   - A PR with `filesTruncated` renders a footer note under the file list
 *     ("more files than the panel shows; open on GitHub for the full
 *     diff"). Same discipline as `patchTruncated` — the panel says what it
 *     doesn't know.
 *
 *   - Every action leaves the panel. There is no "approve" button here
 *     because merging *is* the approval, and the cockpit has no write
 *     access to a default branch. The primary link on every PR row and
 *     every file header goes to GitHub.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader } from '@/components/ui/loader'
import { ZoneBadge } from '@/components/ops/zone-badge'
import { NotConfigured } from '@/components/panels/note-panel'
import { apiFetch } from '@/lib/api-client'
import { sumChangeStats, type DiffFile, type DiffId, type DiffPr, type DiffSnapshot } from '@/lib/ops-diff'
import type { DiffPanelProps } from '@/lib/ops-registry'

interface DiffResponse {
  configured: boolean
  missing?: string[]
  invalid?: string[]
  snapshot?: DiffSnapshot
}

interface DiffPanelComponentProps extends DiffPanelProps {
  diffId: DiffId
}

function StatusPill({ status }: { status: DiffFile['status'] }) {
  // The status pill uses only colour cues from the design tokens; anything
  // more (icons, tooltips) would restate the label without adding signal.
  const cls =
    status === 'added'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : status === 'removed'
        ? 'bg-destructive/10 text-destructive'
        : status === 'renamed' || status === 'copied'
          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          : 'bg-muted text-muted-foreground'
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${cls}`}>
      {status}
    </span>
  )
}

/**
 * Render a single file's patch, one line per row. Empty patches render as
 * an explicit banner; renames without a text delta (pure move) render as a
 * short "renamed" note rather than an empty box.
 */
function PatchBlock({ file }: { file: DiffFile }) {
  if (file.patchTruncated) {
    return (
      <div className="mt-2 rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
        Patch omitted by GitHub — file too large. Open the PR on GitHub for the full diff.
      </div>
    )
  }
  if (!file.patch) {
    if (file.status === 'renamed' || file.status === 'copied') {
      return (
        <div className="mt-2 rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
          {file.status === 'renamed' ? 'Renamed' : 'Copied'} without a text change
          {file.previousFilename ? ` (from ${file.previousFilename})` : ''}.
        </div>
      )
    }
    return (
      <div className="mt-2 rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
        No textual change.
      </div>
    )
  }
  const lines = file.patch.split('\n')
  return (
    <pre className="mt-2 overflow-x-auto rounded border border-border bg-muted/30 p-3 text-xs leading-5">
      {lines.map((line, i) => {
        const first = line.charAt(0)
        const cls =
          first === '+'
            ? 'text-emerald-700 dark:text-emerald-400'
            : first === '-'
              ? 'text-destructive'
              : first === '@'
                ? 'text-primary'
                : 'text-foreground/80'
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

function PrRow({ pr }: { pr: DiffPr }) {
  const { additions, deletions } = sumChangeStats(pr.files)
  return (
    <details className="rounded-lg border border-border bg-card/40 open:bg-card">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">#{pr.number}</span>
            <span className="truncate font-medium text-foreground">{pr.title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
              {' '}
              <span className="text-destructive">-{deletions}</span>
            </span>
            <span>{pr.files.length} file{pr.files.length === 1 ? '' : 's'}</span>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
              onClick={e => e.stopPropagation()}
            >
              open →
            </a>
          </div>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{pr.branch}</span>
          <span>·</span>
          <span>by {pr.author}</span>
          {pr.createdAt && (
            <>
              <span>·</span>
              <span>{pr.createdAt.slice(0, 10)}</span>
            </>
          )}
        </div>
      </summary>

      <div className="border-t border-border px-3 py-3">
        {pr.files.length === 0 ? (
          <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
            The panel could not read this PR&apos;s files. Open on GitHub for the diff.
          </div>
        ) : (
          <ul className="space-y-3">
            {pr.files.map(f => (
              <li key={f.path}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusPill status={f.status} />
                    <span className="truncate font-mono text-foreground">{f.path}</span>
                    {f.previousFilename && (
                      <span className="truncate text-muted-foreground">
                        (from {f.previousFilename})
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
                    {' '}
                    <span className="text-destructive">-{f.deletions}</span>
                  </span>
                </div>
                <PatchBlock file={f} />
              </li>
            ))}
          </ul>
        )}
        {pr.filesTruncated && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            More files than the panel shows. Open on GitHub for the full diff.
          </p>
        )}
      </div>
    </details>
  )
}

export function DiffPanel({ diffId }: DiffPanelComponentProps) {
  const [response, setResponse] = useState<DiffResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<DiffResponse>(`/api/ops/diff/${diffId}`)
      setResponse(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'diff read failed')
    } finally {
      setLoading(false)
    }
  }, [diffId])

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
        <h3 className="text-sm font-semibold text-destructive">Diff unavailable</h3>
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
          <span className="text-xs text-muted-foreground">as of {snapshot.asOf.slice(0, 16).replace('T', ' ')}</span>
        )}
      </header>

      <p className="mt-2 text-xs text-muted-foreground">{snapshot.caption}</p>

      {snapshot.state === 'empty' ? (
        <div className="mt-3 rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          Nothing to review. When the retro job (build-plan 3.2) opens PRs, they land here.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {snapshot.prs.map(pr => (
            <li key={pr.number}>
              <PrRow pr={pr} />
            </li>
          ))}
        </ul>
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

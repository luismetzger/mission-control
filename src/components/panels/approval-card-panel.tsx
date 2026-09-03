'use client'

/**
 * Approval card — the T3 queue, rendered (registry kind `approval-card`).
 *
 * The card shows what a decision needs and nothing it does not: the requested
 * action, the evidence, the blast radius, the recommendation, and how long is
 * left before the request expires.
 *
 * What it deliberately does not have is an Approve button that approves. Every
 * control here opens a pull request against the brain repo, and the merge is the
 * decision — the cockpit has no write access to a default branch. So the buttons
 * say "Draft …", the card says so above them, and there is no typed-confirmation
 * ceremony: a PR you still have to read and merge is a real gate, and stacking a
 * modal in front of it would only make a reviewable action feel supervised
 * without changing what it does.
 *
 * An expired request offers no approve control at all (t3-queue.md rule 6), and
 * the API refuses it again server-side — a disabled button is a hint, not a rule.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { ZoneBadge } from '@/components/ops/zone-badge'
import { NotConfigured } from '@/components/panels/note-panel'
import { apiFetch } from '@/lib/api-client'
// Types only: ops-queue reaches server-side modules, and this component is
// client-side. The approve refusal it would otherwise recompute is already on
// the request, decided by the same code the API enforces.
import type { ApprovalRequest, Disposition } from '@/lib/ops-queue'
import type { ApprovalCardProps } from '@/lib/ops-registry'
import type { Zone } from '@/lib/ops-registry'

interface QueueResponse {
  configured: boolean
  missing?: string[]
  invalid?: string[]
  repo: string
  pending: ApprovalRequest[]
  decided: ApprovalRequest[]
  errors: Array<{ path: string; message: string }>
}

interface RequestResponse {
  configured: boolean
  request: ApprovalRequest
  sha: string
}

interface DispositionResult {
  prUrl: string
  prNumber: number
  disposition: Disposition
  archivePath: string
}

function expiryLabel(request: ApprovalRequest): { text: string; className: string } {
  const { state, daysRemaining, expiresAt } = request.expiry
  if (state === 'missing') {
    return { text: 'no expiry set', className: 'text-red-400' }
  }
  if (state === 'invalid') {
    return { text: `expires_at is unparseable (${expiresAt})`, className: 'text-red-400' }
  }
  if (state === 'expired') {
    const days = Math.abs(daysRemaining ?? 0)
    return {
      text: `expired ${days}d ago — the wiki gate is already failing on this`,
      className: 'text-red-400',
    }
  }
  if (state === 'due-soon') {
    return {
      text: daysRemaining === 0 ? 'expires today' : `expires in ${daysRemaining}d`,
      className: 'text-amber-400',
    }
  }
  return { text: `expires in ${daysRemaining}d (${expiresAt})`, className: 'text-muted-foreground' }
}

const DISPOSITION_STYLES: Record<string, string> = {
  approved: 'bg-green-500/10 text-green-400 border-green-500/30',
  denied: 'bg-red-500/10 text-red-400 border-red-500/30',
  expired: 'bg-muted text-muted-foreground border-border',
  pending: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
}

function DispositionBadge({ disposition }: { disposition: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
        DISPOSITION_STYLES[disposition] ?? DISPOSITION_STYLES.pending
      }`}
    >
      {disposition}
    </span>
  )
}

/**
 * One request, expanded. Sections render in the order the file declares them,
 * so a request that is missing one is visibly missing it rather than silently
 * rendering an empty card.
 */
function RequestBody({
  request,
  sha,
  onDecided,
}: {
  request: ApprovalRequest
  sha: string
  onDecided: (result: DispositionResult) => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<Disposition | null>(null)
  const [error, setError] = useState<string | null>(null)

  const decide = useCallback(
    async (disposition: Disposition) => {
      setBusy(disposition)
      setError(null)
      try {
        const result = await apiFetch<DispositionResult>('/api/ops/queue', {
          method: 'POST',
          body: JSON.stringify({ path: request.path, disposition, sha, note: note.trim() || undefined }),
        })
        onDecided(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to open the disposition pull request')
      } finally {
        setBusy(null)
      }
    },
    [request.path, sha, note, onDecided],
  )

  const approveRefusal = request.approveRefusal

  return (
    <div className="space-y-4 border-t border-border bg-muted/20 p-4">
      {request.warnings.length > 0 && (
        <ul className="space-y-1 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-2xs text-amber-400">
          {request.warnings.map(w => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {request.sections.map(section => (
        <section key={section.heading}>
          <h4 className="mb-1 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
            {section.heading}
          </h4>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">{section.body}</p>
        </section>
      ))}

      {request.sources.length > 0 && (
        <section>
          <h4 className="mb-1 font-mono text-2xs uppercase tracking-wide text-muted-foreground">Sources</h4>
          <ul className="space-y-0.5 font-mono text-2xs text-muted-foreground">
            {request.sources.map(s => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}

      {request.disposition === 'pending' ? (
        <div className="space-y-2 rounded border border-border bg-background p-3">
          <p className="text-2xs text-muted-foreground">
            Each control below opens a pull request against{' '}
            <span className="font-mono">{request.repo}</span>. Nothing is acted on until you merge it —
            the cockpit cannot write to the default branch, so <strong>merging is the decision</strong>.
          </p>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
            placeholder="Optional note, recorded under ## Disposition (the request itself is never edited)"
            className="w-full resize-y rounded border border-border bg-muted/30 p-2 font-mono text-2xs text-foreground placeholder:text-muted-foreground"
          />
          {approveRefusal && (
            <p className="rounded border border-red-500/30 bg-red-500/5 p-2 text-2xs text-red-400">
              {approveRefusal}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {!approveRefusal && (
              <Button variant="success" size="xs" disabled={busy !== null} onClick={() => decide('approved')}>
                {busy === 'approved' ? 'Opening PR…' : 'Draft approval PR'}
              </Button>
            )}
            <Button variant="outline" size="xs" disabled={busy !== null} onClick={() => decide('denied')}>
              {busy === 'denied' ? 'Opening PR…' : 'Draft denial PR'}
            </Button>
            <Button variant="outline" size="xs" disabled={busy !== null} onClick={() => decide('expired')}>
              {busy === 'expired' ? 'Opening PR…' : 'Draft "expired" PR'}
            </Button>
            {request.htmlUrl && (
              <a
                href={request.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-2xs text-primary hover:underline"
              >
                view the file on GitHub
              </a>
            )}
          </div>
          {error && <p className="text-2xs text-red-400">{error}</p>}
        </div>
      ) : (
        <p className="rounded border border-border bg-background p-3 text-2xs text-muted-foreground">
          {request.disposition} by {request.decidedBy ?? 'unknown'} on {request.decidedAt ?? 'unknown date'}.
          A decided request is terminal — if it needs revisiting it is raised again as a new request.
        </p>
      )}
    </div>
  )
}

function RequestRow({
  request,
  expanded,
  onToggle,
  onDecided,
}: {
  request: ApprovalRequest
  expanded: boolean
  onToggle: () => void
  onDecided: (result: DispositionResult) => void
}) {
  const [detail, setDetail] = useState<RequestResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded || detail) return
    let cancelled = false
    setLoading(true)
    setError(null)
    // Re-read on expand rather than trusting the list payload: the sha the
    // disposition is based on has to be the one just read, or a concurrent edit
    // could be overwritten.
    apiFetch<RequestResponse>(`/api/ops/queue?path=${encodeURIComponent(request.path)}`, {
      cache: 'no-store',
    })
      .then(body => {
        if (!cancelled) setDetail(body)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the request')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [expanded, detail, request.path])

  const expiry = expiryLabel(request)

  return (
    <li className="overflow-hidden rounded border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 p-3 text-left hover:bg-muted/30"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">{request.title}</span>
            <DispositionBadge disposition={request.disposition} />
            <ZoneBadge zone={request.actionZone as Zone} />
          </div>
          <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
            {request.path} · raised by {request.requestedBy}
            {request.createdAt ? ` on ${request.createdAt}` : ''}
          </p>
          {request.disposition === 'pending' && (
            <p className={`mt-0.5 text-2xs ${expiry.className}`}>{expiry.text}</p>
          )}
        </div>
        <span className="shrink-0 pt-0.5 font-mono text-2xs text-muted-foreground">
          {expanded ? '−' : '+'}
        </span>
      </button>

      {expanded && loading && (
        <div className="border-t border-border p-4">
          <Loader variant="inline" label="Loading request" />
        </div>
      )}
      {expanded && error && (
        <p className="border-t border-border p-4 text-2xs text-red-400">{error}</p>
      )}
      {expanded && detail && (
        <RequestBody request={detail.request} sha={detail.sha} onDecided={onDecided} />
      )}
    </li>
  )
}

export function ApprovalCardPanel({ initialPath, showDecided = true }: ApprovalCardProps = {}) {
  const [data, setData] = useState<QueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(initialPath ?? null)
  const [drafted, setDrafted] = useState<DispositionResult[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await apiFetch<QueueResponse>('/api/ops/queue', { cache: 'no-store' })
      setData(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the approval queue')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onDecided = useCallback(
    (result: DispositionResult) => {
      setDrafted(prev => [result, ...prev])
      setExpanded(null)
      load()
    },
    [load],
  )

  const counts = useMemo(() => {
    const pending = data?.pending ?? []
    return {
      pending: pending.length,
      expired: pending.filter(r => r.expiry.state === 'expired').length,
      dueSoon: pending.filter(r => r.expiry.state === 'due-soon').length,
    }
  }, [data?.pending])

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader variant="inline" label="Loading approval queue" />
      </div>
    )
  }

  if (data && !data.configured) {
    return <NotConfigured missing={data.missing ?? []} invalid={data.invalid} />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Approvals</h2>
          <p className="text-2xs text-muted-foreground">
            {counts.pending === 0
              ? 'Nothing waiting on you.'
              : `${counts.pending} waiting on you` +
                (counts.expired > 0 ? `, ${counts.expired} already expired and failing CI` : '') +
                (counts.dueSoon > 0 ? `, ${counts.dueSoon} expiring soon` : '') +
                '.'}{' '}
            T3 requests from <span className="font-mono">{data?.repo}</span>.
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {error && <p className="text-2xs text-red-400">{error}</p>}

        {drafted.length > 0 && (
          <ul className="space-y-1 rounded border border-primary/30 bg-primary/5 p-3 text-2xs">
            {drafted.map(d => (
              <li key={d.prUrl}>
                Drafted <strong>{d.disposition}</strong> —{' '}
                <a href={d.prUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  PR #{d.prNumber}
                </a>
                . Merge it to record the decision; nothing has happened yet.
              </li>
            ))}
          </ul>
        )}

        {(data?.errors ?? []).length > 0 && (
          <ul className="space-y-1 rounded border border-red-500/30 bg-red-500/5 p-3 text-2xs text-red-400">
            {(data?.errors ?? []).map(e => (
              <li key={e.path}>
                <span className="font-mono">{e.path}</span>: {e.message}
              </li>
            ))}
          </ul>
        )}

        {counts.pending === 0 ? (
          <p className="rounded border border-border bg-card p-4 text-xs text-muted-foreground">
            The queue is empty. That is the expected state — a request sits here only while it waits
            for a decision, and expiring is a denial rather than a resting place.
          </p>
        ) : (
          <ul className="space-y-2">
            {(data?.pending ?? []).map(request => (
              <RequestRow
                key={request.path}
                request={request}
                expanded={expanded === request.path}
                onToggle={() => setExpanded(prev => (prev === request.path ? null : request.path))}
                onDecided={onDecided}
              />
            ))}
          </ul>
        )}

        {showDecided && (data?.decided ?? []).length > 0 && (
          <section>
            <h3 className="mb-2 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
              Recent decisions
            </h3>
            <ul className="space-y-2">
              {(data?.decided ?? []).map(request => (
                <RequestRow
                  key={request.path}
                  request={request}
                  expanded={expanded === request.path}
                  onToggle={() => setExpanded(prev => (prev === request.path ? null : request.path))}
                  onDecided={onDecided}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

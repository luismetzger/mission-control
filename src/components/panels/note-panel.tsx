'use client'

/**
 * Note panel — renders any wiki page from the configured repos, and turns an
 * edit into a pull request.
 *
 * Registry kind: `note-panel` (architecture/04 §2). Read path is git; the only
 * mutation is "propose edit → PR", which is T1 (reversible, logged) and goes
 * through /api/ops/notes, the same gated path an agent would use.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { ZoneBadge } from '@/components/ops/zone-badge'
import { apiFetch } from '@/lib/api-client'
import type { NotePanelProps, Zone } from '@/lib/ops-registry'
import type { OpsFrontmatter, ReviewStatus } from '@/lib/ops-notes'

interface RepoSummary {
  repo: string
  zone: Zone
  slug: string | null
  hasVault: boolean
}

interface PageSummary {
  repo: string
  zone: Zone
  path: string
  name: string
  section: string
}

interface NotePage extends PageSummary {
  raw: string
  body: string
  frontmatter: OpsFrontmatter
  malformed: boolean
  warnings: string[]
  review: ReviewStatus
  sha: string
  htmlUrl: string
  obsidianUri: string | null
}

interface NotesIndexResponse {
  configured: boolean
  missing?: string[]
  invalid?: string[]
  repos: RepoSummary[]
  pages?: PageSummary[]
  errors?: string[]
}

interface NotePageResponse {
  configured: boolean
  missing?: string[]
  repos: RepoSummary[]
  page?: NotePage
}

const FRONTMATTER_FIELDS: Array<[keyof OpsFrontmatter & string, string]> = [
  ['type', 'type'],
  ['owner_role', 'owner'],
  ['confidence', 'confidence'],
  ['updated_at', 'updated'],
  ['status', 'status'],
]

export function NotConfigured({ missing, invalid }: { missing: string[]; invalid?: string[] }) {
  return (
    <div className="m-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <h3 className="text-sm font-semibold text-amber-400">Not configured</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        The cockpit ops panels need these environment variables before they can read anything:
      </p>
      <ul className="mt-2 space-y-1">
        {missing.map(name => (
          <li key={name} className="font-mono text-xs text-amber-300">
            {name}
          </li>
        ))}
      </ul>
      {invalid && invalid.length > 0 && (
        <ul className="mt-3 space-y-1">
          {invalid.map(msg => (
            <li key={msg} className="text-xs text-muted-foreground">
              {msg}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-2xs text-muted-foreground">
        See README → &quot;Cockpit ops panels&quot;. <span className="font-mono">OPS_BRAIN_REPO</span> falls back to
        the company brain repo, and <span className="font-mono">OPS_OBSIDIAN_VAULTS</span> is optional (the Obsidian
        link is hidden when unset).
      </p>
    </div>
  )
}

function ReviewChip({ review }: { review: ReviewStatus }) {
  if (review.state === 'missing') {
    return <span className="text-2xs text-muted-foreground">review_after: none</span>
  }
  if (review.state === 'invalid') {
    return <span className="text-2xs text-red-400">review_after: unparseable</span>
  }
  const overdue = review.state === 'overdue'
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-2xs ${
        overdue
          ? 'bg-red-500/15 text-red-400 border border-red-500/30'
          : review.state === 'due-soon'
            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
            : 'text-muted-foreground'
      }`}
    >
      review {overdue ? `overdue by ${review.daysOverdue}d` : `in ${Math.abs(review.daysOverdue ?? 0)}d`}
    </span>
  )
}

export function NotePanel({ initialRepo, initialPath }: NotePanelProps = {}) {
  const [index, setIndex] = useState<NotesIndexResponse | null>(null)
  const [selected, setSelected] = useState<{ repo: string; path: string } | null>(
    initialRepo && initialPath ? { repo: initialRepo, path: initialPath } : null,
  )
  const [page, setPage] = useState<NotePage | null>(null)
  const [loadingIndex, setLoadingIndex] = useState(true)
  const [loadingPage, setLoadingPage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [prUrl, setPrUrl] = useState<string | null>(null)

  const loadIndex = useCallback(async () => {
    setLoadingIndex(true)
    setError(null)
    try {
      const data = await apiFetch<NotesIndexResponse>('/api/ops/notes', { cache: 'no-store' })
      setIndex(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pages')
    } finally {
      setLoadingIndex(false)
    }
  }, [])

  useEffect(() => {
    loadIndex()
  }, [loadIndex])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    async function run() {
      setLoadingPage(true)
      setError(null)
      setPrUrl(null)
      setEditing(false)
      try {
        const qs = new URLSearchParams({ repo: selected!.repo, path: selected!.path })
        const data = await apiFetch<NotePageResponse>(`/api/ops/notes?${qs.toString()}`, { cache: 'no-store' })
        if (!cancelled) {
          setPage(data.page ?? null)
          setDraft(data.page?.raw ?? '')
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load page')
      } finally {
        if (!cancelled) setLoadingPage(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [selected])

  const pages = useMemo(() => {
    const all = index?.pages ?? []
    const needle = filter.trim().toLowerCase()
    if (!needle) return all
    return all.filter(p => p.path.toLowerCase().includes(needle) || p.repo.toLowerCase().includes(needle))
  }, [index?.pages, filter])

  const submitEdit = async () => {
    if (!page) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await apiFetch<{ prUrl: string; branch: string; base: string }>('/api/ops/notes', {
        method: 'POST',
        body: JSON.stringify({ repo: page.repo, path: page.path, content: draft, sha: page.sha }),
      })
      setPrUrl(result.prUrl)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open pull request')
    } finally {
      setSubmitting(false)
    }
  }

  if (loadingIndex) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader variant="inline" label="Loading pages" />
      </div>
    )
  }

  if (index && !index.configured) {
    return <NotConfigured missing={index.missing ?? []} invalid={index.invalid} />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Notes</h2>
          <p className="text-2xs text-muted-foreground">
            Pages read from git. Edits open a pull request — the cockpit never writes to main.
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={loadIndex}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="m-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>
      )}
      {index?.errors && index.errors.length > 0 && (
        <div className="mx-4 mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
          {index.errors.map(e => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex w-full shrink-0 flex-col border-b border-border md:w-72 md:border-b-0 md:border-r">
          <div className="p-3">
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter pages"
              className="w-full rounded-md bg-surface-1 px-3 py-2 text-xs text-foreground focus:outline-hidden focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div className="max-h-64 overflow-y-auto px-2 pb-3 md:max-h-none">
            {pages.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">No pages matched.</p>
            ) : (
              pages.map(p => {
                const isActive = selected?.repo === p.repo && selected?.path === p.path
                return (
                  <button
                    key={`${p.repo}:${p.path}`}
                    onClick={() => setSelected({ repo: p.repo, path: p.path })}
                    className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-smooth ${
                      isActive ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-secondary'
                    }`}
                  >
                    <ZoneBadge zone={p.zone} />
                    <span className="min-w-0 flex-1 truncate text-xs" title={`${p.repo} · ${p.path}`}>
                      {p.path}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loadingPage ? (
            <div className="flex h-32 items-center justify-center">
              <Loader variant="inline" label="Loading page" />
            </div>
          ) : !page ? (
            <p className="text-xs text-muted-foreground">Select a page to render it.</p>
          ) : (
            <>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ZoneBadge zone={page.zone} />
                  <span className="text-sm font-semibold text-foreground">
                    {typeof page.frontmatter.title === 'string' ? page.frontmatter.title : page.name}
                  </span>
                  <span className="font-mono text-2xs text-muted-foreground">
                    {page.repo}/{page.path}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
                  {FRONTMATTER_FIELDS.map(([field, label]) => (
                    <span key={field}>
                      {label}:{' '}
                      <span className="text-foreground/80">
                        {typeof page.frontmatter[field] === 'string' ? (page.frontmatter[field] as string) : '—'}
                      </span>
                    </span>
                  ))}
                  <ReviewChip review={page.review} />
                </div>
                {page.malformed && (
                  <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-2xs text-amber-300">
                    Frontmatter did not parse cleanly — rendering the page as-is.
                    {page.warnings.map(w => (
                      <div key={w}>· {w}</div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Button variant="outline" size="xs" onClick={() => setEditing(v => !v)}>
                    {editing ? 'Cancel edit' : 'Edit → PR'}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => window.open(page.htmlUrl, '_blank', 'noopener,noreferrer')}
                    disabled={!page.htmlUrl}
                  >
                    View on GitHub
                  </Button>
                  {page.obsidianUri && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => window.open(page.obsidianUri as string, '_self')}
                    >
                      Open in Obsidian
                    </Button>
                  )}
                </div>
              </div>

              {prUrl && (
                <div className="mt-3 rounded-lg border border-green-500/30 bg-green-500/5 p-3 text-xs text-green-400">
                  Pull request opened:{' '}
                  <a href={prUrl} target="_blank" rel="noopener noreferrer" className="underline">
                    {prUrl}
                  </a>
                </div>
              )}

              {editing ? (
                <div className="mt-3">
                  <textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    spellCheck={false}
                    rows={24}
                    className="w-full rounded-md border border-border bg-surface-1 p-3 font-mono text-xs text-foreground focus:outline-hidden focus:ring-1 focus:ring-primary/50"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <Button size="xs" onClick={submitEdit} disabled={submitting || draft === page.raw}>
                      {submitting ? 'Opening PR…' : 'Propose edit as PR'}
                    </Button>
                    <span className="text-2xs text-muted-foreground">
                      Opens a <span className="font-mono">cockpit/edit-*</span> branch and a PR against{' '}
                      {page.repo}. Never commits to main.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <MarkdownRenderer content={page.body || page.raw} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Run timeline sources — the GitHub reads behind /api/ops/timeline.
 *
 * Split from ops-timeline.ts so the panel can import the ledger types and
 * thresholds without pulling a server-side GitHub client into the client bundle.
 */

import { opsGithubJson, OpsGitHubError, type FetchImpl } from '@/lib/ops-github'
import type { OpsRepoRef } from '@/lib/ops-config'
import {
  DEFAULT_RUN_LIMIT,
  STALE_PR_DAYS,
  ageInDays,
  isAutomationBranch,
  parseLogEntries,
  type Timeline,
  type TimelineLogEntry,
  type TimelinePull,
  type TimelineRepoResult,
  type TimelineRun,
} from '@/lib/ops-timeline'

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

interface ActionsRunsResponse {
  workflow_runs?: Array<{
    id?: number
    name?: string
    head_branch?: string
    status?: string
    conclusion?: string | null
    created_at?: string
    html_url?: string
  }>
}

export async function fetchRuns(
  ref: OpsRepoRef,
  deps: { token: string; fetchImpl?: FetchImpl; limit?: number },
): Promise<TimelineRun[]> {
  const limit = deps.limit ?? DEFAULT_RUN_LIMIT
  const data = await opsGithubJson<ActionsRunsResponse>({
    path: `/repos/${ref.repo}/actions/runs?per_page=${limit}`,
    token: deps.token,
    fetchImpl: deps.fetchImpl,
  })
  return (data.workflow_runs ?? []).slice(0, limit).map(run => {
    const status = String(run.status ?? 'unknown')
    const conclusion = run.conclusion ?? null
    return {
      repo: ref.repo,
      zone: ref.zone,
      id: Number(run.id ?? 0),
      name: String(run.name ?? 'workflow'),
      branch: String(run.head_branch ?? ''),
      status,
      conclusion,
      failed: status === 'completed' && conclusion !== 'success',
      createdAt: String(run.created_at ?? ''),
      htmlUrl: String(run.html_url ?? ''),
    }
  })
}

interface PullsResponse
  extends Array<{
    number?: number
    title?: string
    head?: { ref?: string }
    user?: { login?: string }
    created_at?: string
    html_url?: string
    draft?: boolean
  }> {}

export async function fetchAutomationPulls(
  ref: OpsRepoRef,
  deps: { token: string; fetchImpl?: FetchImpl; nowMs?: number },
): Promise<TimelinePull[]> {
  const nowMs = deps.nowMs ?? Date.now()
  const data = await opsGithubJson<PullsResponse>({
    path: `/repos/${ref.repo}/pulls?state=open&per_page=50`,
    token: deps.token,
    fetchImpl: deps.fetchImpl,
  })
  return (data ?? [])
    .map(pr => {
      const branch = String(pr.head?.ref ?? '')
      const createdAt = String(pr.created_at ?? '')
      const ageDays = ageInDays(createdAt, nowMs)
      return {
        repo: ref.repo,
        zone: ref.zone,
        number: Number(pr.number ?? 0),
        title: String(pr.title ?? ''),
        branch,
        author: String(pr.user?.login ?? ''),
        createdAt,
        ageDays,
        stalled: ageDays > STALE_PR_DAYS,
        htmlUrl: String(pr.html_url ?? ''),
      }
    })
    .filter(pr => isAutomationBranch(pr.branch))
    .sort((a, b) => b.ageDays - a.ageDays)
}

export async function fetchLogEntries(
  ref: OpsRepoRef,
  deps: { token: string; fetchImpl?: FetchImpl; limit?: number },
): Promise<TimelineLogEntry[]> {
  const file = await opsGithubJson<{ content?: string; encoding?: string }>({
    path: `/repos/${ref.repo}/contents/log.md`,
    token: deps.token,
    fetchImpl: deps.fetchImpl,
  })
  const markdown = file.encoding === 'base64' && file.content
    ? Buffer.from(file.content, 'base64').toString('utf8')
    : String(file.content ?? '')
  return parseLogEntries(markdown, { repo: ref.repo, zone: ref.zone, limit: deps.limit })
}

function describeError(source: string, err: unknown): string {
  if (err instanceof OpsGitHubError) return `${source}: GitHub API ${err.status}`
  return `${source}: ${err instanceof Error ? err.message : 'unknown error'}`
}

/**
 * Assemble the timeline for every configured repo. Each of the three sources is
 * fetched independently and its failure recorded rather than thrown, because a
 * repo with no `log.md` must not blank the runs of the repo next to it.
 */
export async function assembleTimeline(
  refs: OpsRepoRef[],
  deps: {
    token: string
    fetchImpl?: FetchImpl
    nowMs?: number
    runLimit?: number
    logLimit?: number
  },
): Promise<Timeline> {
  const nowMs = deps.nowMs ?? Date.now()

  const perRepo = await Promise.all(
    refs.map(async (ref): Promise<TimelineRepoResult> => {
      const errors: string[] = []
      const [runs, pulls, logEntries] = await Promise.all([
        fetchRuns(ref, { token: deps.token, fetchImpl: deps.fetchImpl, limit: deps.runLimit }).catch(err => {
          errors.push(describeError(`${ref.repo} actions runs`, err))
          return [] as TimelineRun[]
        }),
        fetchAutomationPulls(ref, { token: deps.token, fetchImpl: deps.fetchImpl, nowMs }).catch(err => {
          errors.push(describeError(`${ref.repo} open pulls`, err))
          return [] as TimelinePull[]
        }),
        fetchLogEntries(ref, { token: deps.token, fetchImpl: deps.fetchImpl, limit: deps.logLimit }).catch(err => {
          errors.push(describeError(`${ref.repo} log.md`, err))
          return [] as TimelineLogEntry[]
        }),
      ])
      return { repo: ref.repo, zone: ref.zone, runs, pulls, logEntries, errors }
    }),
  )

  const runs = perRepo.flatMap(r => r.runs).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const pulls = perRepo.flatMap(r => r.pulls).sort((a, b) => b.ageDays - a.ageDays)
  const logEntries = perRepo.flatMap(r => r.logEntries).sort((a, b) => b.date.localeCompare(a.date))

  return {
    repos: perRepo,
    runs,
    pulls,
    logEntries,
    errors: perRepo.flatMap(r => r.errors),
    generatedAt: new Date(nowMs).toISOString(),
  }
}

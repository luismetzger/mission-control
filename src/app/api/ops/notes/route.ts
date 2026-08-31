/**
 * GET  /api/ops/notes                          → configured repos + page index
 * GET  /api/ops/notes?repo=owner/repo&path=…    → one rendered page
 * POST /api/ops/notes                          → propose an edit as a PR (T1)
 *
 * Reads come from git and only from the repos named in OPS_CLIENT_REPOS /
 * OPS_BRAIN_REPO. The write path opens a pull request; there is no path here
 * that commits to a default branch.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  findRepoRef,
  isOpsConfigured,
  loadOpsConfig,
  obsidianUri,
  type OpsConfig,
} from '@/lib/ops-config'
import { fetchPage, listPages, proposeEdit } from '@/lib/ops-notes'

function notConfigured(config: OpsConfig) {
  return NextResponse.json({
    configured: false,
    missing: config.missing,
    invalid: config.invalid,
    repos: [],
    pages: [],
  })
}

function repoSummaries(config: OpsConfig) {
  return config.repos.map(ref => ({
    repo: ref.repo,
    zone: ref.zone,
    slug: ref.slug,
    hasVault: Boolean(ref.vault),
  }))
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const config = loadOpsConfig()
  if (!isOpsConfigured(config) || !config.token) return notConfigured(config)
  const token = config.token

  const { searchParams } = new URL(request.url)
  const repoParam = searchParams.get('repo')
  const pathParam = searchParams.get('path')

  try {
    if (repoParam && pathParam) {
      const ref = findRepoRef(config, repoParam)
      if (!ref) {
        return NextResponse.json({ error: 'repo is not in the configured ops repo set' }, { status: 400 })
      }
      const page = await fetchPage(ref, pathParam, { token })
      return NextResponse.json({
        configured: true,
        repos: repoSummaries(config),
        page: { ...page, obsidianUri: obsidianUri(ref, page.path) },
      })
    }

    const refs = repoParam
      ? [findRepoRef(config, repoParam)].filter(ref => ref !== null)
      : config.repos
    if (repoParam && refs.length === 0) {
      return NextResponse.json({ error: 'repo is not in the configured ops repo set' }, { status: 400 })
    }

    const results = await Promise.all(
      refs.map(async ref => {
        try {
          return { pages: await listPages(ref, { token }), error: null as string | null }
        } catch (err) {
          return {
            pages: [],
            error: `${ref.repo}: ${err instanceof Error ? err.message : 'failed to list pages'}`,
          }
        }
      }),
    )

    return NextResponse.json({
      configured: true,
      repos: repoSummaries(config),
      pages: results.flatMap(r => r.pages),
      errors: results.map(r => r.error).filter((e): e is string => e !== null),
    })
  } catch (err) {
    logger.error({ err }, 'GET /api/ops/notes failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read pages' },
      { status: 502 },
    )
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const config = loadOpsConfig()
  if (!isOpsConfigured(config) || !config.token) return notConfigured(config)

  let body: { repo?: string; path?: string; content?: string; sha?: string; summary?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const ref = findRepoRef(config, String(body.repo ?? ''))
  if (!ref) {
    return NextResponse.json({ error: 'repo is not in the configured ops repo set' }, { status: 400 })
  }
  if (!body.path || !body.content || !body.sha) {
    return NextResponse.json({ error: 'path, content and sha are required' }, { status: 400 })
  }

  try {
    const result = await proposeEdit(
      {
        ref,
        path: body.path,
        content: body.content,
        sha: body.sha,
        actor: auth.user.username,
        summary: body.summary,
      },
      { token: config.token },
    )

    try {
      logAuditEvent({
        action: 'ops_note_edit_proposed',
        actor: auth.user.username,
        actor_id: auth.user.id,
        target_type: 'ops_note',
        detail: {
          repo: ref.repo,
          zone: ref.zone,
          path: body.path,
          branch: result.branch,
          base: result.base,
          pr: result.prUrl,
        },
      })
    } catch (auditErr) {
      logger.warn({ err: auditErr }, 'failed to audit ops note edit proposal')
    }

    return NextResponse.json({ configured: true, ...result })
  } catch (err) {
    logger.error({ err, repo: ref.repo, path: body.path }, 'POST /api/ops/notes failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to open pull request' },
      { status: 502 },
    )
  }
}

export const dynamic = 'force-dynamic'

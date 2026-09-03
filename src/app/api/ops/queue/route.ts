/**
 * GET  /api/ops/queue        → the T3 approval queue (pending + recent decisions)
 * GET  /api/ops/queue?path=… → one request, with the blob sha needed to decide it
 * POST /api/ops/queue        → propose a disposition as a PR
 *
 * The queue lives in the brain repo only (`policies/t3-queue.md` rule 1), so
 * neither verb takes a repo parameter — there is no caller-supplied repo here to
 * point at a client zone.
 *
 * The POST is the highest-authority route in the cockpit and still only opens a
 * pull request. `decided_by` is the authenticated identity, never a field in the
 * request body, so a decision cannot be attributed to someone who did not make
 * it. Merging the PR is the approval.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/db'
import { logger } from '@/lib/logger'
import { isOpsConfigured, loadOpsConfig, type OpsConfig } from '@/lib/ops-config'
import { DECIDABLE, dispositionRefusal, type Disposition } from '@/lib/ops-queue'
import { fetchQueue, fetchRequest, proposeDisposition } from '@/lib/ops-queue-sources'

function notConfigured(config: OpsConfig) {
  return NextResponse.json({
    configured: false,
    missing: config.missing,
    invalid: config.invalid,
    repo: config.brainRepo.repo,
    pending: [],
    decided: [],
    errors: [],
  })
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const config = loadOpsConfig()
  if (!isOpsConfigured(config) || !config.token) return notConfigured(config)
  const token = config.token

  const path = new URL(request.url).searchParams.get('path')

  try {
    if (path) {
      const { request: req, sha } = await fetchRequest(config, path, { token })
      return NextResponse.json({ configured: true, request: req, sha })
    }
    const snapshot = await fetchQueue(config, { token })
    return NextResponse.json({ configured: true, invalid: config.invalid, ...snapshot })
  } catch (err) {
    logger.error({ err, path }, 'GET /api/ops/queue failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read the approval queue' },
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

  let body: { path?: string; disposition?: string; sha?: string; note?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  if (!body.path || !body.sha) {
    return NextResponse.json({ error: 'path and sha are required' }, { status: 400 })
  }
  const disposition = String(body.disposition ?? '') as Disposition
  if (!(DECIDABLE as readonly string[]).includes(disposition)) {
    return NextResponse.json(
      { error: `disposition must be one of ${DECIDABLE.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    // Refuse before writing, with the policy's own wording, so the operator sees
    // why rather than a generic 502 from a rejected PR.
    const current = await fetchRequest(config, body.path, { token: config.token })
    const refusal = dispositionRefusal(current.request, disposition)
    if (refusal) {
      return NextResponse.json({ error: refusal, refused: true }, { status: 409 })
    }

    const result = await proposeDisposition(
      config,
      {
        path: body.path,
        disposition,
        decidedBy: auth.user.username,
        note: body.note,
        sha: body.sha,
      },
      { token: config.token },
    )

    try {
      logAuditEvent({
        action: 'ops_t3_disposition_proposed',
        actor: auth.user.username,
        actor_id: auth.user.id,
        target_type: 'ops_approval_request',
        detail: {
          repo: config.brainRepo.repo,
          zone: config.brainRepo.zone,
          path: body.path,
          archivePath: result.archivePath,
          disposition,
          actionZone: current.request.actionZone,
          branch: result.branch,
          base: result.base,
          pr: result.prUrl,
        },
      })
    } catch (auditErr) {
      logger.warn({ err: auditErr }, 'failed to audit T3 disposition proposal')
    }

    return NextResponse.json({ configured: true, ...result })
  } catch (err) {
    logger.error({ err, path: body.path, disposition }, 'POST /api/ops/queue failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to open the disposition pull request' },
      { status: 502 },
    )
  }
}

export const dynamic = 'force-dynamic'

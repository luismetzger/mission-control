/**
 * GET /api/ops/diff/:diffId — a single `DiffSnapshot`.
 *
 * Read-only. The diff panel proposes nothing: every action link in the
 * rendered panel goes to GitHub, where merging is the approval. The route
 * validates `:diffId` against the closed set and returns 400 on an unknown
 * value (a bad panelId is almost always a typo in a binding — pointing at
 * it is the useful error).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isOpsConfigured, loadOpsConfig, type OpsConfig } from '@/lib/ops-config'
import { isDiffId, type DiffId } from '@/lib/ops-diff'
import { fetchDiffSnapshot } from '@/lib/ops-diff-sources'

function notConfigured(config: OpsConfig, diffId: DiffId) {
  return NextResponse.json({
    configured: false,
    missing: config.missing,
    invalid: config.invalid,
    diffId,
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ diffId: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { diffId } = await params
  if (!isDiffId(diffId)) {
    return NextResponse.json({ error: `unknown diff: ${diffId}` }, { status: 400 })
  }

  const config = loadOpsConfig()
  if (!isOpsConfigured(config) || !config.token) return notConfigured(config, diffId)

  try {
    const snapshot = await fetchDiffSnapshot(diffId, config, { token: config.token })
    return NextResponse.json({ configured: true, snapshot })
  } catch (err) {
    logger.error({ err, diffId }, 'GET /api/ops/diff failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read the diff' },
      { status: 502 },
    )
  }
}

export const dynamic = 'force-dynamic'

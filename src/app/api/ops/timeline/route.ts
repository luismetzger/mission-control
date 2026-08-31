/**
 * GET /api/ops/timeline → read-only run ledger across the configured repos.
 *
 * Assembles GitHub Actions runs, open automation PRs and the newest `log.md`
 * entries (policies/run-ledger.md). No mutations live on this route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isOpsConfigured, loadOpsConfig } from '@/lib/ops-config'
import { DEFAULT_LOG_LIMIT, DEFAULT_RUN_LIMIT, MIN_REFRESH_MS } from '@/lib/ops-timeline'
import { assembleTimeline } from '@/lib/ops-timeline-sources'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const config = loadOpsConfig()
  if (!isOpsConfigured(config) || !config.token) {
    return NextResponse.json({
      configured: false,
      missing: config.missing,
      invalid: config.invalid,
      repos: [],
      runs: [],
      pulls: [],
      logEntries: [],
      errors: [],
    })
  }

  try {
    const timeline = await assembleTimeline(config.repos, {
      token: config.token,
      runLimit: DEFAULT_RUN_LIMIT,
      logLimit: DEFAULT_LOG_LIMIT,
    })
    return NextResponse.json({
      configured: true,
      minRefreshMs: MIN_REFRESH_MS,
      invalid: config.invalid,
      ...timeline,
    })
  } catch (err) {
    logger.error({ err }, 'GET /api/ops/timeline failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to assemble timeline' },
      { status: 502 },
    )
  }
}

export const dynamic = 'force-dynamic'

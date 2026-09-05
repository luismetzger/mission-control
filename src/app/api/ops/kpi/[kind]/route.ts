/**
 * GET /api/ops/kpi/:kind — a single `KpiSnapshot` for one card kind.
 *
 * Read-only. The KPI card family has no write; acknowledging a spend
 * threshold happens by opening the T3 approval-card panel and merging the
 * envelope PR, which is where the actual gate lives. Putting the write here
 * would give the card two responsibilities and duplicate the T3 route.
 *
 * `kind` is validated against the small, closed set — anything else is a 400,
 * not a 404, so the caller learns the difference between "unknown route" and
 * "unknown card". The route also refuses to run when ops config is missing,
 * mirroring the other ops routes' shape so the panel can render the same
 * NotConfigured state without a per-card branch.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isOpsConfigured, loadOpsConfig, type OpsConfig } from '@/lib/ops-config'
import { KPI_KINDS, type KpiCardKind } from '@/lib/ops-kpi'
import { fetchKpiSnapshot } from '@/lib/ops-kpi-sources'

function notConfigured(config: OpsConfig, kind: KpiCardKind) {
  return NextResponse.json({
    configured: false,
    missing: config.missing,
    invalid: config.invalid,
    kind,
  })
}

function isKpiKind(s: string): s is KpiCardKind {
  return (KPI_KINDS as readonly string[]).includes(s)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { kind } = await params
  if (!isKpiKind(kind)) {
    return NextResponse.json({ error: `unknown KPI kind: ${kind}` }, { status: 400 })
  }

  const config = loadOpsConfig()
  if (!isOpsConfigured(config) || !config.token) return notConfigured(config, kind)

  try {
    const snapshot = await fetchKpiSnapshot(kind, config, { token: config.token })
    return NextResponse.json({ configured: true, snapshot })
  } catch (err) {
    logger.error({ err, kind }, 'GET /api/ops/kpi failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read the KPI series' },
      { status: 502 },
    )
  }
}

export const dynamic = 'force-dynamic'

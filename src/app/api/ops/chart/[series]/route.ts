/**
 * GET /api/ops/chart/:series?window=7d|30d|mtd — a single `ChartSnapshot`.
 *
 * Read-only. The chart panel family has no write; a series that would need
 * to change something (adjust an envelope, ack a burn threshold) delegates
 * to the T3 approval-card panel it links out to.
 *
 * The route validates `:series` against the closed set, and `?window=` against
 * the closed set of `ChartWindow`. `window` defaults to `mtd` — when the
 * question is "am I burning through the envelope," that is almost always the
 * right first view; the panel's toggle covers the other two.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isOpsConfigured, loadOpsConfig, type OpsConfig } from '@/lib/ops-config'
import {
  CHART_WINDOWS,
  isChartSeriesId,
  isChartWindow,
  type ChartSeriesId,
  type ChartWindow,
} from '@/lib/ops-chart'
import { fetchChartSnapshot } from '@/lib/ops-chart-sources'

function notConfigured(config: OpsConfig, seriesId: ChartSeriesId, window: ChartWindow) {
  return NextResponse.json({
    configured: false,
    missing: config.missing,
    invalid: config.invalid,
    seriesId,
    window,
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ series: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { series } = await params
  if (!isChartSeriesId(series)) {
    return NextResponse.json({ error: `unknown chart series: ${series}` }, { status: 400 })
  }
  const rawWindow = request.nextUrl.searchParams.get('window') ?? 'mtd'
  if (!isChartWindow(rawWindow)) {
    return NextResponse.json(
      { error: `unknown window: ${rawWindow}; expected one of ${CHART_WINDOWS.join(', ')}` },
      { status: 400 },
    )
  }

  const config = loadOpsConfig()
  if (!isOpsConfigured(config) || !config.token) return notConfigured(config, series, rawWindow)

  try {
    const snapshot = await fetchChartSnapshot(series, rawWindow, config, { token: config.token })
    return NextResponse.json({ configured: true, snapshot })
  } catch (err) {
    logger.error({ err, series, window: rawWindow }, 'GET /api/ops/chart failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read the chart series' },
      { status: 502 },
    )
  }
}

export const dynamic = 'force-dynamic'

/**
 * GET /api/ops/table/:tableId — a single `TableSnapshot`.
 *
 * Read-only. Table panels have no write in v1; a table whose row actions
 * would need to change something (chase an invoice, transition a lead)
 * delegates to a T3 flow that opens a PR, and that lives in the approval
 * card panel, not here.
 *
 * The route validates `:tableId` against the closed set. Unknown ids come
 * back as 400 rather than a generic 404 — the caller almost always has a
 * typo in a panelId binding, and pointing at the bad value is the useful
 * error message.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isOpsConfigured, loadOpsConfig, type OpsConfig } from '@/lib/ops-config'
import { isTableId, type TableId } from '@/lib/ops-table'
import { fetchTableSnapshot } from '@/lib/ops-table-sources'

function notConfigured(config: OpsConfig, tableId: TableId) {
  return NextResponse.json({
    configured: false,
    missing: config.missing,
    invalid: config.invalid,
    tableId,
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tableId: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { tableId } = await params
  if (!isTableId(tableId)) {
    return NextResponse.json({ error: `unknown table: ${tableId}` }, { status: 400 })
  }

  const config = loadOpsConfig()
  if (!isOpsConfigured(config) || !config.token) return notConfigured(config, tableId)

  try {
    const snapshot = await fetchTableSnapshot(tableId, config, { token: config.token })
    return NextResponse.json({ configured: true, snapshot })
  } catch (err) {
    logger.error({ err, tableId }, 'GET /api/ops/table failed')
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read the table' },
      { status: 502 },
    )
  }
}

export const dynamic = 'force-dynamic'

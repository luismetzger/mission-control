'use client'

/**
 * AR aging table widget — dashboard slot for the `table-ar-aging` panel
 * (build-plan 2.2h).
 *
 * A thin wrapper around TablePanel with the AR aging table bound in. Same
 * pattern as the burn chart widget: the dashboard imports the panel
 * component directly and passes the tableId; `renderOpsPanel` is for the
 * panel router (URL → component), not for the dashboard's own composition.
 *
 * Why AR aging is the *dashboard* table and not, say, a queue table: the
 * queue depth is already a KPI card and a chart series; a table on top would
 * be a third rendering of the same data. AR aging has bucket detail that
 * the KPI card intentionally does not expose (the card is a single number
 * plus a trend), and that detail — how much sits in which age bucket — is
 * what determines whether the number is climbing benignly or badly.
 */

import { TablePanel } from '@/components/panels/table-panel'
import type { DashboardData } from '../widget-primitives'

export function ArAgingTableWidget(_props: { data: DashboardData }) {
  return <TablePanel tableId="ar-aging" />
}

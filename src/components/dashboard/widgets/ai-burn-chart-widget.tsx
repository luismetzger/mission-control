'use client'

/**
 * AI burn chart widget — dashboard slot for the `chart-ai-burn` panel
 * (build-plan 2.2e).
 *
 * A thin wrapper around ChartPanel with the AI burn series bound in. Follows
 * the same pattern as the telemetry strip: the dashboard doesn't reach into
 * the ops registry's `renderOpsPanel` (that helper is for the panel router,
 * which resolves one URL path to one component); it imports the panel
 * component directly and hands it the seriesId it wants.
 *
 * Why AI burn is the *dashboard* series and not, say, the queue depth: it is
 * the one series where a chart earns its keep. The daily budget monitor
 * (cron `c83f7c00`) can only alert *after* a threshold is crossed; the burn
 * chart tells you the shape of the month *before* it does. Every other series
 * on the dashboard is either a snapshot (metric cards) or a discrete event
 * (activity timeline); a projected trajectory belongs on a chart.
 */

import { ChartPanel } from '@/components/panels/chart-panel'
import type { DashboardData } from '../widget-primitives'

export function AiBurnChartWidget(_props: { data: DashboardData }) {
  return <ChartPanel seriesId="ai-burn-vs-envelope" />
}

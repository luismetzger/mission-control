'use client'

/**
 * Registration of the v1 cockpit components.
 *
 * Importing this module registers every kind exactly once; the panel router
 * resolves components through the registry rather than importing them directly,
 * which is what makes the registry load-bearing instead of speculative.
 */

import { createElement } from 'react'
import { ApprovalCardPanel } from '@/components/panels/approval-card-panel'
import { ChartPanel } from '@/components/panels/chart-panel'
import { KpiCardPanel } from '@/components/panels/kpi-card-panel'
import { NotePanel } from '@/components/panels/note-panel'
import { RunTimelinePanel } from '@/components/panels/run-timeline-panel'
import { VoiceConsolePanel } from '@/components/panels/voice-console-panel'
import type { ChartSeriesId } from '@/lib/ops-chart'
import type { KpiCardKind } from '@/lib/ops-kpi'
import {
  getOpsComponentByPanelId,
  listOpsComponents,
  registerOpsComponent,
  type OpsComponentDef,
} from '@/lib/ops-registry'

/**
 * Wrap the shared KPI card so each registered kind gets its own component
 * reference with the kind bound in. `renderOpsPanel` passes zero props by
 * design (every kind derives its data from the API); binding the kind here is
 * the smallest change that keeps that contract while letting one component
 * serve three kinds. If we later add a fourth KPI kind this stays a one-line
 * change here plus a registry entry below.
 */
function bindKpi(kind: KpiCardKind) {
  const Bound = () => createElement(KpiCardPanel, { kind })
  Bound.displayName = `KpiCardPanel(${kind})`
  return Bound
}

/**
 * Bind a chart series into the shared ChartPanel component. Same mechanism as
 * `bindKpi` and for the same reason: `renderOpsPanel` passes zero props, so
 * the seriesId gets baked in at registration time. Unlike KPI, `chart-panel`
 * is a *single* registered kind — different chart panels differ by `panelId`
 * (e.g. `chart-ai-burn`) that all resolve to the same kind. A future second
 * series adds a `registerOpsComponent` line here plus a `ChartSeriesDef`; no
 * new kind, no new API route.
 */
function bindChart(seriesId: ChartSeriesId) {
  const Bound = () => createElement(ChartPanel, { seriesId })
  Bound.displayName = `ChartPanel(${seriesId})`
  return Bound
}

if (listOpsComponents().length === 0) {
  registerOpsComponent({
    kind: 'note-panel',
    panelId: 'notes',
    title: 'Notes',
    // Read-only except "propose edit → PR", which is T1: reversible and logged.
    maxActionTier: 'T1',
    component: NotePanel,
  })

  registerOpsComponent({
    kind: 'run-timeline',
    panelId: 'runs',
    title: 'Run timeline',
    maxActionTier: 'read-only',
    component: RunTimelinePanel,
  })

  registerOpsComponent({
    kind: 'approval-card',
    // Not 'approvals': the upstream template already ships an 'exec-approvals'
    // panel, and two nav entries reading "Approvals" is exactly the ambiguity
    // a T3 control should not have.
    panelId: 'ops-approvals',
    title: 'T3 approvals',
    // The tier of the action being decided, not of what this panel does — the
    // panel itself only opens a PR. Recorded as T3 so the registry answers
    // "what is the most consequential thing reachable from here" honestly.
    maxActionTier: 'T3',
    component: ApprovalCardPanel,
  })

  registerOpsComponent({
    kind: 'voice-console',
    panelId: 'voice',
    title: 'Voice',
    maxActionTier: 'read-only',
    component: VoiceConsolePanel,
  })

  // KPI/status cards (build-plan 2.2d). Three kinds share KpiCardPanel with
  // the kind bound in at registration time — see bindKpi above.
  registerOpsComponent({
    kind: 'kpi-spend',
    panelId: 'kpi-spend',
    title: 'AI spend MTD',
    // Read-only. The card drills into the T3 approval-card panel, which is
    // where a spend decision actually happens — recording T3 here would
    // overstate what the card itself can do.
    maxActionTier: 'read-only',
    component: bindKpi('kpi-spend'),
  })

  registerOpsComponent({
    kind: 'kpi-ar',
    panelId: 'kpi-ar',
    title: 'AR outstanding',
    maxActionTier: 'read-only',
    component: bindKpi('kpi-ar'),
  })

  registerOpsComponent({
    kind: 'kpi-queue',
    panelId: 'kpi-queue',
    title: 'T3 queue depth',
    maxActionTier: 'read-only',
    component: bindKpi('kpi-queue'),
  })

  // Chart panels (build-plan 2.2e). One kind (`chart-panel`), one series
  // today, one panelId per series. The kind is the reusable shell; the
  // panelId identifies which series the router hands off. Adding a second
  // series is: (a) a `ChartSeriesDef` in ops-chart-sources, (b) one line
  // here. No new kind, no new route, no new component.
  registerOpsComponent({
    kind: 'chart-panel',
    panelId: 'chart-ai-burn',
    title: 'AI burn vs envelope',
    // Read-only. If the burn crosses the envelope, the response is opening a
    // PR on the envelope, which is a T3 action that lives in the approval
    // card panel. Reporting T3 here would inflate what the chart itself can
    // do — it renders numbers, it decides nothing.
    maxActionTier: 'read-only',
    component: bindChart('ai-burn-vs-envelope'),
  })
}

export { getOpsComponentByPanelId, listOpsComponents }

/** Panel ids the registry can render, for the router. */
export function opsPanelIds(): string[] {
  return listOpsComponents().map(def => def.panelId)
}

/**
 * Render a registered component by panel id, or null when the id is not ours.
 * Props are supplied per kind by the caller; every registered kind accepts zero
 * props and derives zone from the API payload.
 */
export function renderOpsPanel(panelId: string): React.ReactElement | null {
  const def: OpsComponentDef | undefined = getOpsComponentByPanelId(panelId)
  if (!def) return null
  return createElement(def.component as React.ComponentType, {})
}

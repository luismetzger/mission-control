'use client'

/**
 * Cockpit telemetry strip — the dashboard widget that renders all three KPI
 * cards in one row (build-plan 2.2e).
 *
 * The strip is a widget, not a hardcoded row above the grid. Two reasons: the
 * dashboard already has a grid-and-catalog system with drag-to-reorder and
 * per-mode default layouts, and adding a second layout mechanism above it
 * would double the surface area for "where did that panel go?" bugs. Second,
 * making it a widget lets a user who does not want the strip drop it, and one
 * who wants it at the bottom put it there — which matches how every other
 * dashboard element is arranged.
 *
 * The strip renders the three registered KPI kinds by importing the shared
 * `KpiCardPanel` component directly and passing each `kind` in. It does *not*
 * go through `renderOpsPanel(panelId)` — that helper exists for the panel
 * router which resolves a URL path to a component, and the strip has three
 * components in one view, not one. Using the component directly is honest
 * about the coupling: this widget knows the three KPI kinds by name, and if a
 * fourth kind is added, adding it here is a one-line change.
 *
 * `DashboardData` is threaded through by the grid but unused here — the KPI
 * cards fetch their own data from `/api/ops/kpi/:kind`. That is deliberate:
 * the dashboard's `apiFetch` cadence and the KPI cadence are different (the
 * dashboard polls every few seconds; a git-tracked CSV moves once a week),
 * and coupling them would make the strip refresh at the wrong rate for what
 * it is measuring.
 */

import { KpiCardPanel } from '@/components/panels/kpi-card-panel'
import type { DashboardData } from '../widget-primitives'
import type { KpiCardKind } from '@/lib/ops-kpi'

// The three kinds the strip renders, in the intended reading order:
// spend first (because it is the one with an envelope you can breach),
// AR second (because it is the one that funds the others), queue third
// (because it is the one that measures whether the whole approval loop is
// still moving). Order is a design decision, not a runtime one — a user who
// wants a different order drops the strip and adds the individual cards to
// the panel router.
const KPI_ORDER: readonly KpiCardKind[] = ['kpi-spend', 'kpi-ar', 'kpi-queue']

export function CockpitTelemetryStripWidget(_props: { data: DashboardData }) {
  return (
    <div className="rounded-xl border border-border bg-card/80 px-3 py-3 backdrop-blur-xs">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-foreground/60">
          Cockpit telemetry
        </h3>
        <span className="text-[10px] text-foreground/40">
          spend · AR · T3 queue
        </span>
      </div>
      {/*
        On narrow screens the three cards stack; on md+ they sit in one row.
        Each card is `h-full` inside the panel component, so equal-height rows
        happen for free with grid rather than needing an ad-hoc flex trick.
      */}
      <div className="grid gap-2 md:grid-cols-3">
        {KPI_ORDER.map(kind => (
          <div key={kind} className="min-h-[130px]">
            <KpiCardPanel kind={kind} />
          </div>
        ))}
      </div>
    </div>
  )
}

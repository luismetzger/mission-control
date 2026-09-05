/**
 * Cockpit component registry — v1.
 *
 * architecture/04 §2 ("Dynamic Jarvis UI") describes the cockpit as a *typed
 * component registry* views are composed from at answer-time, rather than a
 * fixed dashboard. This module is the minimal foundation for that: a
 * `ComponentKind` union, one props contract per kind, and a single place where
 * the next kind lands.
 *
 * Deliberately small. A registry no component uses is speculative, so it
 * registers only kinds that exist: `note-panel`, `run-timeline`, and
 * `approval-card`, from `src/components/ops/register.tsx`.
 *
 * Module-scoped registry following the existing register*() pattern
 * (registerPluginPanels in plugins.ts, registerAuthResolver in auth.ts).
 */

import type { ComponentType } from 'react'

// ---------------------------------------------------------------------------
// Zones (architecture/04 §3 "Zone model")
// ---------------------------------------------------------------------------

/**
 * `z0` company-private, `z1-<slug>` one zone per client, `p` public.
 *
 * `unknown` exists so an unrecognised data source fails *visibly* — a repo that
 * is not in the configured set must never silently render as `z0`.
 */
export type Zone = 'z0' | `z1-${string}` | 'p' | 'unknown'

export const ZONE_UNKNOWN: Zone = 'unknown'

/** Human-readable zone label for badges and screen readers. */
export function zoneLabel(zone: Zone): string {
  if (zone === 'z0') return 'Z0 · company'
  if (zone === 'p') return 'P · public'
  if (zone === 'unknown') return 'zone unknown'
  return `Z1 · ${zone.slice('z1-'.length)}`
}

/** Client slug for a `z1-*` zone, else null. */
export function zoneClientSlug(zone: Zone): string | null {
  return zone.startsWith('z1-') ? zone.slice('z1-'.length) : null
}

// ---------------------------------------------------------------------------
// Props contracts — one per kind
// ---------------------------------------------------------------------------

/**
 * Anything a registered component renders per row/page carries its zone, and
 * the zone is derived from the data source (which repo it came from) rather
 * than passed in by a caller. See `deriveZone` in ops-config.ts.
 */
export interface ZoneScoped {
  repo: string
  zone: Zone
}

/** Props contract for `note-panel`. */
export interface NotePanelProps {
  /** Repo to select on mount (`owner/repo`). Must be in the configured set. */
  initialRepo?: string
  /** Page path to open on mount, e.g. `wiki/brand/voice.md`. */
  initialPath?: string
}

/** Props contract for `run-timeline`. */
export interface RunTimelineProps {
  /** Auto-refresh interval in ms. Floored at 60s (see MIN_REFRESH_MS). */
  refreshIntervalMs?: number
}

/** Props contract for `approval-card`. */
export interface ApprovalCardProps {
  /** Queue path to expand on mount, e.g. `queue/2026-09-02-ops-token.md`. */
  initialPath?: string
  /** Show recent decisions alongside the pending queue. Default true. */
  showDecided?: boolean
}

/** Props contract for `voice-console`. Zero props — it derives everything from
 * the event stream and the user's stored audio preferences. */
export interface VoiceConsoleProps {
  /** Reserved for deep-linking a specific transition. */
  focusEventId?: string
}

/**
 * Props contract for the KPI card family (`kpi-spend`, `kpi-ar`, `kpi-queue`).
 *
 * Three kinds, one component. The choice is deliberate: `kind` is the contract
 * (one action tier, one data source, one drill-in target), so three trend cards
 * that differ in all three of those things are three kinds — not one card with
 * a runtime prop that picks the source. That would let a `read-only` card
 * accidentally register with a `T3` action just by flipping a string; keeping
 * the source in the kind means the tier and the target follow it in the
 * registry, and typos become type errors.
 *
 * The React component itself is shared, because the *rendering* is identical:
 * label, big number, sparkline, badge, drill-in link. Only the data adapter
 * and the drill-in href differ, and those are decided from `kind` on the
 * server, not from props here.
 */
export interface KpiCardProps {
  /** Optional deep-link into a specific point on the trend line. Reserved. */
  focusDate?: string
}

/**
 * Props for the reusable chart panel (build-plan 2.2e). Kind is `chart-panel`
 * — a single registration, not one-per-series like the KPI cards. See
 * `src/lib/ops-chart.ts` for why: KPI kinds differ in contract (action tier,
 * drill-in target) so baking those into the kind was right; chart panels
 * differ only in *series*, and every chart panel has the same read-only
 * contract with one deep link out. A single kind means adding a new chart
 * is adding a series definition, not a new registration.
 */
export interface ChartPanelProps {
  seriesId: import('@/lib/ops-chart').ChartSeriesId
}

/**
 * Props for the reusable table panel (build-plan 2.2h). Kind is `table-panel`
 * — the same shape decision as the chart panel: one kind, many tables. See
 * `src/lib/ops-table.ts` for why: every checklist item under 2.2h (invoices,
 * AR aging, leads, backlog) has the same fixed-column structure, no dynamic
 * pivoting, no row actions in v1 — baking a per-table kind would encode
 * differences the tables don't actually have.
 *
 * Row-level actions are deferred (see `ops-table.ts` for the reasoning: no
 * table today has actions the T3 model represents, so wiring the affordance
 * now would encode the wrong shape).
 */
export interface TablePanelProps {
  tableId: import('@/lib/ops-table').TableId
}

/**
 * Props for the reusable diff panel (build-plan 2.2g). Kind is `diff-panel`
 * — the same shape decision as chart and table: one kind, many diffs, the
 * `diffId` a prop. Every diff has the same contract: read-only, one deep
 * link to the PR on GitHub, no in-panel merge. The retro job (3.2) will be
 * the first source of PRs that land here.
 */
export interface DiffPanelProps {
  diffId: import('@/lib/ops-diff').DiffId
}

/** The props contract per kind. Add the next kind here and nowhere else. */
export interface OpsComponentPropsByKind {
  'note-panel': NotePanelProps
  'run-timeline': RunTimelineProps
  // Tier-1 audio feedback over the ops transition stream. Read-only: it makes
  // noise about state, it never changes it.
  'voice-console': VoiceConsoleProps
  // T3 queue items with evidence and recommendation. Its `maxActionTier` is
  // 'T3' and it is the only kind that reaches that tier, but note what the
  // action actually is: it opens a pull request. T3 must never render as a
  // one-click optimistic button (architecture/04 §2), and here it cannot —
  // the cockpit has no write access to a default branch, so merging is the
  // decision. Voice read-back is 2.2c and lands on this same kind.
  'approval-card': ApprovalCardProps
  // KPI/status cards for the cockpit telemetry strip (architecture/03 §164,
  // build-plan 2.2d). Three kinds — one per underlying series — so the tier
  // and drill-in target live in the registry rather than in a component prop:
  //   - `kpi-spend`  read-only view of AI spend MTD against the monthly
  //                  envelope; drills into the T3 approval queue for the
  //                  envelope itself. The card renders read-only; the action
  //                  is in the queue it points at.
  //   - `kpi-ar`     read-only view of AR total across all aging buckets from
  //                  the weekly Bookkeeper snapshot. No drill-in yet (no AR
  //                  panel exists), and none is faked — the card links out to
  //                  the source file in the brain repo instead.
  //   - `kpi-queue`  read-only view of the T3 queue depth over time. Drills
  //                  into the existing approval-card panel, which is where a
  //                  decision is actually made.
  'kpi-spend': KpiCardProps
  'kpi-ar': KpiCardProps
  'kpi-queue': KpiCardProps
  // Reusable time-series chart (architecture/04 §2, build-plan 2.2e). One
  // kind, many series — the series is a prop, not a kind, because a chart's
  // action tier and drill-in shape are identical across series. Read-only:
  // ack-of-threshold happens in the T3 approval-card panel a series may link
  // out to, never inline on the chart.
  'chart-panel': ChartPanelProps
  // Reusable tabular card (architecture/04 §2, build-plan 2.2h). One kind,
  // many tables — the tableId is a prop, not a kind, for the same reason as
  // chart: every table sub-item in 2.2h (invoices, AR aging, leads, backlog)
  // has the same shape (fixed columns, optional totals row, no row actions
  // in v1). Read-only: row-level actions that would fit the T3 model land in
  // a follow-up when a table has actions PRs can represent.
  'table-panel': TablePanelProps
  // Reusable diff viewer (architecture/04 §2, build-plan 2.2g). One kind,
  // many diffs — the diffId is a prop for the same reason as chart/table:
  // every diff has the same shape (list of PRs, per-file unified patches,
  // one deep link out to GitHub). Read-only: merging is the approval and
  // the cockpit has no write access to a default branch, so there is no
  // in-panel merge button to build. This is the review surface build-plan
  // 3.2's retro job needs before it can propose skill/policy/template
  // changes.
  'diff-panel': DiffPanelProps
}

export type ComponentKind = keyof OpsComponentPropsByKind

export interface OpsComponentDef<K extends ComponentKind = ComponentKind> {
  kind: K
  /** Panel id used by the router in `src/app/[[...panel]]/page.tsx`. */
  panelId: string
  title: string
  /** Highest authority tier any action binding on this component can reach. */
  maxActionTier: 'read-only' | 'T1' | 'T3'
  component: ComponentType<OpsComponentPropsByKind[K]>
}

// ---------------------------------------------------------------------------
// Registry (module-scoped)
// ---------------------------------------------------------------------------

const _components = new Map<ComponentKind, OpsComponentDef>()

export function registerOpsComponent<K extends ComponentKind>(def: OpsComponentDef<K>): void {
  // The map is keyed by kind and values are heterogeneous — storage is
  // widened via `unknown`, and `getOpsComponent<K>` narrows it back on
  // read. A direct `def as OpsComponentDef` cast worked when the props
  // union was small enough for TS's variance check to accept it; each
  // new kind widens that union until the check refuses.
  _components.set(def.kind, def as unknown as OpsComponentDef)
}

export function getOpsComponent<K extends ComponentKind>(kind: K): OpsComponentDef<K> | undefined {
  return _components.get(kind) as OpsComponentDef<K> | undefined
}

export function getOpsComponentByPanelId(panelId: string): OpsComponentDef | undefined {
  for (const def of _components.values()) {
    if (def.panelId === panelId) return def
  }
  return undefined
}

export function listOpsComponents(): OpsComponentDef[] {
  return [..._components.values()]
}

/** Test-only: drop all registrations. */
export function _resetOpsRegistry(): void {
  _components.clear()
}

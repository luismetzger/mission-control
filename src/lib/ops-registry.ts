/**
 * Cockpit component registry — v1.
 *
 * architecture/04 §2 ("Dynamic Jarvis UI") describes the cockpit as a *typed
 * component registry* views are composed from at answer-time, rather than a
 * fixed dashboard. This module is the minimal foundation for that: a
 * `ComponentKind` union, one props contract per kind, and a single place where
 * the next kind lands.
 *
 * Deliberately small. A registry no component uses is speculative, so v1
 * registers exactly two kinds — `note-panel` and `run-timeline` — from
 * `src/components/ops/register.tsx`.
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

/** The props contract per kind. Add the next kind here and nowhere else. */
export interface OpsComponentPropsByKind {
  'note-panel': NotePanelProps
  'run-timeline': RunTimelineProps
  // Next: 'approval-card' — T3 queue items with evidence, recommendation and
  // voice read-back. Deliberately out of scope for this PR; T3 actions must
  // never render as one-click optimistic buttons (architecture/04 §2).
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
  _components.set(def.kind, def as OpsComponentDef)
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

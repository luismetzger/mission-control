/**
 * Registration tests for the table panel family.
 *
 * Same shape as the chart panel: one *kind*, one panelId per table. This
 * test locks the shape the API and drill-in URLs assume: the `table-panel`
 * kind is registered, `table-ar-aging` resolves to it, and the tier stays
 * read-only. If any of those drifts, an entire panel silently 404s or
 * (worse) mis-reports its authority to the registry.
 */
import { describe, expect, it } from 'vitest'
import '@/components/ops/register'
import { getOpsComponent, getOpsComponentByPanelId } from '@/lib/ops-registry'

describe('table panel registration', () => {
  it('registers a single `table-panel` kind', () => {
    const def = getOpsComponent('table-panel')
    expect(def, 'table-panel must be registered').toBeDefined()
    // Row actions on the first table (AR) don't fit the T3-via-PR model,
    // so the kind stays read-only; a future gated-action table lands as a
    // separate kind or as an extension on this one \u2014 either way, a change
    // here should be deliberate, not accidental.
    expect(def?.maxActionTier).toBe('read-only')
  })

  it('exposes the AR aging table at panelId `table-ar-aging`', () => {
    // Default cockpit route into the table family. If this panelId is
    // renamed without updating the router or any deep-link, the panel
    // silently 404s in a UI nobody reloads.
    const def = getOpsComponentByPanelId('table-ar-aging')
    expect(def, 'table-ar-aging must resolve to a registered component').toBeDefined()
    expect(def?.kind).toBe('table-panel')
    expect(def?.title).toBe('AR aging')
  })
})

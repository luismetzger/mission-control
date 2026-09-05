/**
 * Registration tests for the chart panel family.
 *
 * Unlike the KPI cards, chart panels are one *kind* with one panelId per
 * series. This test locks the shape the API and drill-in URLs assume: the
 * `chart-panel` kind is registered, the `chart-ai-burn` panelId resolves to
 * it, and the tier stays read-only. If any of those drifts, an entire panel
 * silently 404s or (worse) mis-reports its authority to the registry.
 */
import { describe, expect, it } from 'vitest'
import '@/components/ops/register'
import { getOpsComponent, getOpsComponentByPanelId } from '@/lib/ops-registry'

describe('chart panel registration', () => {
  it('registers a single `chart-panel` kind', () => {
    const def = getOpsComponent('chart-panel')
    expect(def, 'chart-panel must be registered').toBeDefined()
    expect(def?.maxActionTier).toBe('read-only')
  })

  it('exposes the AI burn series at panelId `chart-ai-burn`', () => {
    // The default cockpit route into the chart family. If this panelId is
    // renamed without updating the router or any deep-link, the panel
    // silently 404s.
    const def = getOpsComponentByPanelId('chart-ai-burn')
    expect(def, 'chart-ai-burn must resolve to a registered component').toBeDefined()
    expect(def?.kind).toBe('chart-panel')
    // Title read by the router / breadcrumbs / analytics.
    expect(def?.title).toBe('AI burn vs envelope')
  })
})

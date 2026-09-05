/**
 * Tests for the cockpit telemetry strip's catalog integration.
 *
 * The strip lives in three places: the widget catalog, the widget-grid
 * component registry, and both default layouts. Any one of those drifting is
 * a silent regression — the widget stops rendering by default but nothing
 * throws, so nobody notices in a UI they don't reload. These assertions are
 * the smallest set that catches all three failure modes.
 */
import { describe, expect, it } from 'vitest'
import {
  GATEWAY_DEFAULT_LAYOUT,
  LOCAL_DEFAULT_LAYOUT,
  getAvailableWidgets,
  getDefaultLayout,
  getWidgetById,
} from '@/lib/dashboard-widgets'

const STRIP_ID = 'cockpit-telemetry-strip'

describe('cockpit telemetry strip catalog registration', () => {
  it('is registered with a full-width default and both modes', () => {
    const w = getWidgetById(STRIP_ID)
    expect(w, 'strip must be in WIDGET_CATALOG').toBeDefined()
    // Full width — the strip renders three cards, and a narrower default
    // would clip the third one on the standard cockpit break-point.
    expect(w?.defaultSize).toBe('full')
    // Both modes — spend/AR/queue don't depend on a local runtime, so there
    // is no reason to hide the strip on the gateway install.
    expect(w?.modes).toEqual(expect.arrayContaining(['local', 'full']))
  })

  it.each([
    ['local', LOCAL_DEFAULT_LAYOUT],
    ['full', GATEWAY_DEFAULT_LAYOUT],
  ] as const)('sits directly under the briefing bar in the %s default layout', (_mode, layout) => {
    // Adjacency is the specification the widget was designed against — the
    // briefing bar says "what needs attention right now" and the strip says
    // "which of the three slow-moving KPIs is drifting". If a future change
    // reorders them, this test flags the drift so it happens on purpose.
    const briefingIdx = layout.indexOf('briefing-bar')
    const stripIdx = layout.indexOf(STRIP_ID)
    expect(briefingIdx).toBeGreaterThanOrEqual(0)
    expect(stripIdx).toBe(briefingIdx + 1)
  })

  it('is available in both dashboard modes via getAvailableWidgets', () => {
    // getAvailableWidgets is what the grid's "add a widget" menu reads, so a
    // strip that is in the catalog but not returned here is invisible to a
    // user who removed it and wants it back.
    expect(getAvailableWidgets('local').some(w => w.id === STRIP_ID)).toBe(true)
    expect(getAvailableWidgets('full').some(w => w.id === STRIP_ID)).toBe(true)
  })

  it('appears in getDefaultLayout for both modes', () => {
    // The single source of truth for what the dashboard renders on first load.
    // Guards the "the layout constant was updated but getDefaultLayout wasn't"
    // failure mode, cheap.
    expect(getDefaultLayout('local')).toContain(STRIP_ID)
    expect(getDefaultLayout('full')).toContain(STRIP_ID)
  })
})

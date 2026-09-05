/**
 * Registration tests for the diff panel family.
 *
 * Same shape as chart and table: one *kind*, one panelId per diff. This
 * test locks the shape the API and deep-links assume: the `diff-panel` kind
 * is registered, `diff-retro-proposals` resolves to it, and the tier stays
 * read-only. The tier check matters here specifically because the natural
 * failure mode of a diff viewer is drifting toward "we can merge from
 * this panel" — the invariant is that merging is a human on GitHub, so
 * this kind's authority never rises above read-only.
 */
import { describe, expect, it } from 'vitest'
import '@/components/ops/register'
import { getOpsComponent, getOpsComponentByPanelId } from '@/lib/ops-registry'

describe('diff panel registration', () => {
  it('registers a single `diff-panel` kind', () => {
    const def = getOpsComponent('diff-panel')
    expect(def, 'diff-panel must be registered').toBeDefined()
    // Merging is the approval and the cockpit has no write access to a
    // default branch. If this ever ticks above read-only, the panel is
    // claiming authority it does not have — and the T3 architectural
    // invariant "actions never render as one-click optimistic buttons"
    // starts to erode from the registry outward.
    expect(def?.maxActionTier).toBe('read-only')
  })

  it('exposes the retro proposals diff at panelId `diff-retro-proposals`', () => {
    // Default cockpit route into the diff family. Build-plan 3.2's retro
    // job will link into this panelId; a rename that misses either side
    // silently 404s in a UI nobody reloads.
    const def = getOpsComponentByPanelId('diff-retro-proposals')
    expect(def, 'diff-retro-proposals must resolve to a registered component').toBeDefined()
    expect(def?.kind).toBe('diff-panel')
    expect(def?.title).toBe('Retro proposals')
  })
})

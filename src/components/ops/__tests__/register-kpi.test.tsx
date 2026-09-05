/**
 * Registration tests for the KPI card family.
 *
 * The registry test already covers the general contract (register, resolve,
 * one entry per kind). This test asks the specific question the KPI feature
 * turns on: are all three kinds registered, each with the panel id and
 * action tier the API and the drill-in links assume?
 *
 * If any of those three answers drifts, an entire card silently fails to
 * render or its drill-in link 404s in a UI nobody has clicked in a week.
 * That is exactly the "check that cannot fail proves nothing" trap this test
 * is here to close.
 */
import { describe, expect, it } from 'vitest'
import '@/components/ops/register'
import { getOpsComponent, getOpsComponentByPanelId } from '@/lib/ops-registry'
import { KPI_KINDS } from '@/lib/ops-kpi'

describe('KPI card registration', () => {
  it.each(KPI_KINDS)('registers %s with matching panel id and read-only tier', kind => {
    const def = getOpsComponent(kind)
    expect(def, `${kind} must be registered`).toBeDefined()
    // Panel id equals the kind — the API route and drill-in URLs assume this,
    // and having them diverge is a real footgun the test names outright.
    expect(def?.panelId).toBe(kind)
    // Every KPI card is read-only: the tier of any real decision lives in the
    // panel it points at (ops-approvals for spend and queue), not here.
    expect(def?.maxActionTier).toBe('read-only')
  })

  it('drill-in target ops-approvals is a real registered panel', () => {
    // Spend and queue cards drill into 'ops-approvals'. A typo there means a
    // KPI card renders a link to a panel that does not exist. Asserting the
    // target resolves is worth more than a URL-matching regex.
    expect(getOpsComponentByPanelId('ops-approvals')?.kind).toBe('approval-card')
  })
})

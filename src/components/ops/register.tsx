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
import { NotePanel } from '@/components/panels/note-panel'
import { RunTimelinePanel } from '@/components/panels/run-timeline-panel'
import { VoiceConsolePanel } from '@/components/panels/voice-console-panel'
import {
  getOpsComponentByPanelId,
  listOpsComponents,
  registerOpsComponent,
  type OpsComponentDef,
} from '@/lib/ops-registry'

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

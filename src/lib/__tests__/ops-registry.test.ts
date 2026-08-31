/**
 * Tests for src/lib/ops-registry.ts — the typed component registry foundation.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetOpsRegistry,
  getOpsComponent,
  getOpsComponentByPanelId,
  listOpsComponents,
  registerOpsComponent,
  type ComponentKind,
} from '../ops-registry'

function Stub() {
  return null
}

describe('ops component registry', () => {
  beforeEach(() => {
    _resetOpsRegistry()
  })

  it('registers and resolves a kind, by kind and by panel id', () => {
    registerOpsComponent({
      kind: 'note-panel',
      panelId: 'notes',
      title: 'Notes',
      maxActionTier: 'T1',
      component: Stub,
    })
    expect(getOpsComponent('note-panel')?.panelId).toBe('notes')
    expect(getOpsComponentByPanelId('notes')?.kind).toBe('note-panel')
    expect(getOpsComponentByPanelId('nope')).toBeUndefined()
  })

  it('holds exactly the two v1 kinds and no speculative extras', () => {
    registerOpsComponent({
      kind: 'note-panel',
      panelId: 'notes',
      title: 'Notes',
      maxActionTier: 'T1',
      component: Stub,
    })
    registerOpsComponent({
      kind: 'run-timeline',
      panelId: 'runs',
      title: 'Run timeline',
      maxActionTier: 'read-only',
      component: Stub,
    })
    const kinds = listOpsComponents().map(d => d.kind).sort()
    expect(kinds).toEqual(['note-panel', 'run-timeline'] satisfies ComponentKind[])
  })

  it('re-registering a kind replaces it rather than duplicating', () => {
    registerOpsComponent({
      kind: 'run-timeline',
      panelId: 'runs',
      title: 'Run timeline',
      maxActionTier: 'read-only',
      component: Stub,
    })
    registerOpsComponent({
      kind: 'run-timeline',
      panelId: 'runs-v2',
      title: 'Run timeline',
      maxActionTier: 'read-only',
      component: Stub,
    })
    expect(listOpsComponents()).toHaveLength(1)
    expect(getOpsComponent('run-timeline')?.panelId).toBe('runs-v2')
  })

  it('keeps the run timeline read-only and the note panel at T1', () => {
    registerOpsComponent({
      kind: 'note-panel',
      panelId: 'notes',
      title: 'Notes',
      maxActionTier: 'T1',
      component: Stub,
    })
    registerOpsComponent({
      kind: 'run-timeline',
      panelId: 'runs',
      title: 'Run timeline',
      maxActionTier: 'read-only',
      component: Stub,
    })
    // No v1 component may carry a T3 action; T3 belongs to the approval card.
    expect(listOpsComponents().every(d => d.maxActionTier !== 'T3')).toBe(true)
  })
})

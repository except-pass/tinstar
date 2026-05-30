// src/server/stores/__tests__/constellationGraph.docstore.test.ts
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../document-store'
import { emptyGraph, addSnap } from '../../../domain/constellationGraph'

describe('DocumentStore constellationGraph', () => {
  it('upserts, reads, and emits a change with spaceId in the payload', () => {
    const store = new DocumentStore()
    const events: Array<{ entity: string; id: string; data: unknown }> = []
    store.changes.on('change', e => events.push(e))

    const g = addSnap(emptyGraph('space-1'), 'pw-a', 'run-R1')
    store.upsertConstellationGraph('space-1', g)

    expect(store.getConstellationGraph('space-1')).toEqual(g)
    expect(store.getAllConstellationGraphs()).toEqual([g])
    const last = events.at(-1)!
    expect(last.entity).toBe('constellationGraph')
    expect(last.id).toBe('space-1')
    expect((last.data as { spaceId: string }).spaceId).toBe('space-1')
  })

  it('includes constellationGraphs in the snapshot, filtered by active space', () => {
    const store = new DocumentStore()
    store.upsertConstellationGraph('space-1', emptyGraph('space-1'))
    store.upsertConstellationGraph('space-2', emptyGraph('space-2'))
    store.activeSpaceId = 'space-1'
    const snap = store.snapshot() as { constellationGraphs: Array<{ spaceId: string }> }
    expect(snap.constellationGraphs.map(g => g.spaceId)).toEqual(['space-1'])
  })
})

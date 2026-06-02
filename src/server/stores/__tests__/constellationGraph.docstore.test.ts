// src/server/stores/__tests__/constellationGraph.docstore.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocumentStore } from '../document-store'
import { emptyGraph, addSnap } from '../../../domain/constellationGraph'

function makePluginWidget(id: string, spaceId: string) {
  return { id, pluginId: 'p', widgetType: 'stretchplan', spaceId, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {}, createdAt: '', updatedAt: '' }
}

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

  it('prunes graph edges referencing a deleted plugin widget', () => {
    const store = new DocumentStore()
    let g = addSnap(emptyGraph('space-1'), 'pw-a', 'run-R1')
    g = { ...g, members: [{ widget: 'pw-a', slot: '1' }, { widget: 'run-R1', slot: '1' }] }
    store.upsertConstellationGraph('space-1', g)
    store.upsertPluginWidget('pw-a', { id: 'pw-a', pluginId: 'p', widgetType: 'saloon', spaceId: 'space-1', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, data: {}, createdAt: '', updatedAt: '' })

    store.deletePluginWidget('pw-a')

    const after = store.getConstellationGraph('space-1')!
    expect(after.snapped).toEqual([])                      // snap edge gone
    expect(after.members.map(m => m.widget)).toEqual([])   // run-R1 freed (was left a singleton)
  })

  // Regression: a plugin widget that still exists must keep its constellation
  // slot membership. Pruning is keyed strictly on the deleted widget id, so
  // deleting an unrelated widget must never evict a surviving plugin widget.
  it('keeps a surviving plugin widget in its slot when an unrelated widget is deleted', () => {
    const store = new DocumentStore()
    let g = addSnap(emptyGraph('space-1'), 'pw-a', 'run-R1')
    g = { ...g, members: [{ widget: 'pw-a', slot: '1' }, { widget: 'run-R1', slot: '1' }] }
    store.upsertConstellationGraph('space-1', g)
    store.upsertPluginWidget('pw-a', makePluginWidget('pw-a', 'space-1'))
    store.upsertPluginWidget('pw-b', makePluginWidget('pw-b', 'space-1')) // unrelated, not a member

    store.deletePluginWidget('pw-b')

    const after = store.getConstellationGraph('space-1')!
    expect(after.members.map(m => m.widget).sort()).toEqual(['pw-a', 'run-R1'])
    expect(after.snapped).toEqual([['pw-a', 'run-R1']])
  })

  // Regression: persisted plugin-widget membership must survive a reload. The
  // graph round-trips through disk verbatim — nothing prunes members against the
  // live node list on load (the old client-side prune-on-reload bug).
  it('restores plugin-widget slot membership across a persist/reload cycle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'constellation-reload-'))
    const file = join(dir, 'snapshot.json')
    try {
      const store = new DocumentStore()
      store.enablePersistence(file)
      let g = addSnap(emptyGraph('space-1'), 'pw-a', 'run-R1')
      g = { ...g, members: [{ widget: 'pw-a', slot: '1' }, { widget: 'run-R1', slot: '1' }] }
      store.upsertConstellationGraph('space-1', g)
      store.upsertPluginWidget('pw-a', makePluginWidget('pw-a', 'space-1'))
      store.flush()

      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      const after = reloaded.getConstellationGraph('space-1')!
      expect(after.members.map(m => m.widget).sort()).toEqual(['pw-a', 'run-R1'])
      expect(after.snapped).toEqual([['pw-a', 'run-R1']])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

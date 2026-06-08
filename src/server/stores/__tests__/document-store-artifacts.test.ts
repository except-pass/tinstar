import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../document-store'
import type { Artifact, BrowserWidget } from '../../../domain/types'

function makeArtifact(over: Partial<Artifact> = {}): Artifact {
  const now = 1_700_000_000_000
  return { id: 'eph-1', html: '<h1>hi</h1>', rev: 1, createdAt: now, updatedAt: now, ...over }
}

describe('DocumentStore artifacts', () => {
  it('upsert / get / getAll / delete', () => {
    const store = new DocumentStore()
    store.upsertArtifact('eph-1', makeArtifact())
    expect(store.getArtifact('eph-1')?.html).toBe('<h1>hi</h1>')
    expect(store.getAllArtifacts()).toHaveLength(1)
    store.deleteArtifact('eph-1')
    expect(store.getArtifact('eph-1')).toBeUndefined()
    expect(store.getAllArtifacts()).toHaveLength(0)
  })

  it('deleteAllArtifacts returns count and clears', () => {
    const store = new DocumentStore()
    store.upsertArtifact('eph-1', makeArtifact({ id: 'eph-1' }))
    store.upsertArtifact('eph-2', makeArtifact({ id: 'eph-2' }))
    expect(store.deleteAllArtifacts()).toBe(2)
    expect(store.getAllArtifacts()).toHaveLength(0)
  })

  it('upsert emits a metadata-only change event (no html)', () => {
    const store = new DocumentStore()
    const seen: Array<{ entity: string; data: unknown }> = []
    store.changes.on('change', e => { if (e.entity === 'artifact') seen.push(e) })
    store.upsertArtifact('eph-1', makeArtifact({ spaceId: 'spc-1', widgetId: 'browser-9' }))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.data).toEqual({ id: 'eph-1', spaceId: 'spc-1', widgetId: 'browser-9', rev: 1 })
    expect(JSON.stringify(seen[0]?.data)).not.toContain('<h1>')
  })

  it('deleting a browser widget cascades to its owned artifacts', () => {
    const store = new DocumentStore()
    const widget: BrowserWidget = { id: 'browser-9', url: 'http://localhost:5273/api/artifacts/eph-1' }
    store.upsertBrowserWidget('browser-9', widget)
    store.upsertArtifact('eph-1', makeArtifact({ widgetId: 'browser-9' }))
    store.upsertArtifact('eph-2', makeArtifact({ id: 'eph-2', widgetId: 'browser-other' }))
    store.deleteBrowserWidget('browser-9')
    expect(store.getArtifact('eph-1')).toBeUndefined()
    expect(store.getArtifact('eph-2')).toBeDefined()
  })

  it('clearSpace deletes widgetId-only artifacts owned by browser widgets in that space', () => {
    const store = new DocumentStore()
    // browser widget lives in spc-1; its artifact has NO spaceId (only widgetId).
    store.upsertBrowserWidget('browser-9', { id: 'browser-9', spaceId: 'spc-1', url: '/api/artifacts/eph-owned' })
    store.upsertArtifact('eph-owned', makeArtifact({ id: 'eph-owned', widgetId: 'browser-9' })) // spaceId omitted
    store.upsertArtifact('eph-spaced', makeArtifact({ id: 'eph-spaced', spaceId: 'spc-1' }))     // by spaceId
    // a widget + artifact in a DIFFERENT space must survive.
    store.upsertBrowserWidget('browser-2', { id: 'browser-2', spaceId: 'spc-2', url: '/x' })
    store.upsertArtifact('eph-other', makeArtifact({ id: 'eph-other', widgetId: 'browser-2' }))

    store.clearSpace('spc-1')

    expect(store.getArtifact('eph-owned')).toBeUndefined()   // was the orphan bug
    expect(store.getArtifact('eph-spaced')).toBeUndefined()
    expect(store.getArtifact('eph-other')).toBeDefined()
  })
})

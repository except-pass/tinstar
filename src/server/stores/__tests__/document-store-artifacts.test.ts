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
})

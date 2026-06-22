import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocumentStore } from '../document-store'
import { emptyPinSet, addPin } from '../../../domain/pinSet'

const mkPin = (id: string, nodeId: string) => ({
  id, nodeId, nx: 0.5, ny: 0.5, comment: '', createdAt: 1,
})

describe('DocumentStore pins', () => {
  it('upsertPinSet stores and getPinSet returns it', () => {
    const s = new DocumentStore()
    const set = addPin(emptyPinSet('space-1'), mkPin('pin-1', 'run-a'))
    expect(s.upsertPinSet('space-1', { ...set, rev: 1 })).toBe(true)
    expect(s.getPinSet('space-1')!.pins).toHaveLength(1)
  })

  it('rejects a stale/equal revision', () => {
    const s = new DocumentStore()
    s.upsertPinSet('space-1', { spaceId: 'space-1', pins: [], rev: 2 })
    expect(s.upsertPinSet('space-1', { spaceId: 'space-1', pins: [], rev: 2 })).toBe(false)
    expect(s.upsertPinSet('space-1', { spaceId: 'space-1', pins: [], rev: 1 })).toBe(false)
    expect(s.upsertPinSet('space-1', { spaceId: 'space-1', pins: [], rev: 3 })).toBe(true)
  })

  it('upsertPinSet emits a pinSet change', () => {
    const s = new DocumentStore()
    const seen: Array<{ entity: string; id: string }> = []
    s.changes.on('change', (c: { entity: string; id: string }) => seen.push(c))
    s.upsertPinSet('space-1', { spaceId: 'space-1', pins: [], rev: 1 })
    expect(seen.some(c => c.entity === 'pinSet' && c.id === 'space-1')).toBe(true)
  })

  it('removePinsForNodeAcrossSpaces drops a node\'s pins and bumps rev', () => {
    const s = new DocumentStore()
    let set = addPin(emptyPinSet('space-1'), mkPin('pin-1', 'run-a'))
    set = addPin(set, mkPin('pin-2', 'browser-b'))
    s.upsertPinSet('space-1', { ...set, rev: 1 })
    s.removePinsForNodeAcrossSpaces('run-a')
    expect(s.getPinSet('space-1')!.pins.map(p => p.id)).toEqual(['pin-2'])
    expect(s.getPinSet('space-1')!.rev).toBe(2)
  })

  it('removePinsForNodeAcrossSpaces drops a node from every space (multi-space GC)', () => {
    const s = new DocumentStore()
    s.upsertPinSet('space-1', { ...addPin(emptyPinSet('space-1'), mkPin('p1', 'run-x')), rev: 1 })
    s.upsertPinSet('space-2', { ...addPin(emptyPinSet('space-2'), mkPin('p2', 'run-x')), rev: 1 })
    s.removePinsForNodeAcrossSpaces('run-x')
    expect(s.getPinSet('space-1')!.pins).toHaveLength(0)
    expect(s.getPinSet('space-2')!.pins).toHaveLength(0)
  })

  it('removePinsForNodeAcrossSpaces is a no-op when no space pins the node', () => {
    const s = new DocumentStore()
    s.upsertPinSet('space-1', { ...addPin(emptyPinSet('space-1'), mkPin('p1', 'run-a')), rev: 5 })
    const before = s.getPinSet('space-1')!.rev
    const seen: Array<{ entity: string }> = []
    s.changes.on('change', (c: { entity: string }) => seen.push(c))
    s.removePinsForNodeAcrossSpaces('nonexistent-node')
    expect(s.getPinSet('space-1')!.rev).toBe(before)
    expect(seen.some(c => c.entity === 'pinSet')).toBe(false)
  })

  it('persists a pinSet across a save/reload cycle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-reload-'))
    const file = join(dir, 'snapshot.json')
    try {
      const store = new DocumentStore()
      store.enablePersistence(file)
      store.upsertPinSet('space-1', { ...addPin(emptyPinSet('space-1'), mkPin('p1', 'run-a')), rev: 1 })
      store.flush()

      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      const after = reloaded.getPinSet('space-1')!
      expect(after.pins.map(p => p.id)).toEqual(['p1'])
      expect(after.rev).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

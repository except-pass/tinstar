import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentStore } from '../../stores/document-store'
import { migrateAllBrowserNotes } from '../migrateAllBrowserNotes'
import type { BrowserWidget } from '../../../domain/types'

const note = (id: string, over: Partial<any> = {}) => ({
  id, url: 'http://x/', comment: `c-${id}`, x: 10, y: 20, nx: 0.1, ny: 0.2, createdAt: 1, ...over,
})

const widget = (id: string, over: Partial<BrowserWidget> = {}): BrowserWidget => ({
  id, url: 'http://x/', ...over,
})

describe('migrateAllBrowserNotes', () => {
  it('seeds per-space pins, groups by space, handles space-less widgets, and is idempotent', () => {
    const s = new DocumentStore()

    // Space A: two browser widgets, each with notes.
    s.upsertBrowserWidget('browser-a1', widget('browser-a1', { spaceId: 'A', notes: [note('na1')] }))
    s.upsertBrowserWidget('browser-a2', widget('browser-a2', { spaceId: 'A', notes: [note('na2a'), note('na2b')] }))
    // Space B: one widget with notes.
    s.upsertBrowserWidget('browser-b1', widget('browser-b1', { spaceId: 'B', notes: [note('nb1')] }))
    // Space-less widget with notes — no home space.
    s.upsertBrowserWidget('browser-orphan', widget('browser-orphan', { notes: [note('norph')] }))
    // Space C: a pre-existing, non-empty PinSet that must NOT be clobbered.
    s.upsertBrowserWidget('browser-c1', widget('browser-c1', { spaceId: 'C', notes: [note('nc1')] }))
    s.upsertPinSet('C', { spaceId: 'C', pins: [{ id: 'live', nodeId: 'browser-c1', nx: 0.9, ny: 0.9, comment: 'live', createdAt: 99 }], rev: 5 })

    const res = migrateAllBrowserNotes(s)

    // Space A holds both widgets' pins, with correct nodeIds.
    const aPins = s.getPinSet('A')!.pins
    expect(aPins.map(p => p.id).sort()).toEqual(['na1', 'na2a', 'na2b'])
    expect(aPins.find(p => p.id === 'na1')!.nodeId).toBe('browser-a1')
    expect(aPins.find(p => p.id === 'na2a')!.nodeId).toBe('browser-a2')
    expect(aPins.find(p => p.id === 'na1')!.context).toEqual({ url: 'http://x/', docX: 10, docY: 20 })

    // Space B holds its widget's pin.
    expect(s.getPinSet('B')!.pins.map(p => p.id)).toEqual(['nb1'])

    // Space C left untouched (pre-existing non-empty PinSet).
    expect(s.getPinSet('C')!.pins.map(p => p.id)).toEqual(['live'])
    expect(s.getPinSet('C')!.rev).toBe(5)

    // Result bookkeeping.
    expect(res.seeded.sort()).toEqual(['A', 'B'])
    expect(res.skippedExisting).toEqual(['C'])
    expect(res.orphanWidgetIds).toEqual(['browser-orphan'])

    // Idempotent: re-running does not duplicate pins.
    const res2 = migrateAllBrowserNotes(s)
    expect(s.getPinSet('A')!.pins.map(p => p.id).sort()).toEqual(['na1', 'na2a', 'na2b'])
    expect(s.getPinSet('B')!.pins.map(p => p.id)).toEqual(['nb1'])
    expect(s.getPinSet('C')!.pins.map(p => p.id)).toEqual(['live'])
    expect(res2.seeded).toEqual([])
    expect(res2.skippedExisting.sort()).toEqual(['A', 'B', 'C'])
  })

  it('leaves an existing-but-EMPTY PinSet untouched (no resurrection of deleted pins)', () => {
    // Once a space has been migrated it always has a PinSet. If the user later
    // deletes every pin, that PinSet is empty. Reseeding it would resurrect the
    // deleted pins from the legacy widget.notes — so an existing PinSet, empty or
    // not, must be left alone.
    const s = new DocumentStore()
    s.upsertBrowserWidget('browser-e', widget('browser-e', { spaceId: 'E', notes: [note('ne')] }))
    s.upsertPinSet('E', { spaceId: 'E', pins: [], rev: 3 })

    const res = migrateAllBrowserNotes(s)

    const set = s.getPinSet('E')!
    expect(set.pins).toEqual([]) // NOT reseeded from widget.notes
    expect(set.rev).toBe(3) // untouched
    expect(res.seeded).toEqual([])
    expect(res.skippedExisting).toEqual(['E'])
  })

  it('persists the seeded migration so it does NOT re-run on reload (durability)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tinstar-migrate-'))
    const file = join(dir, 'docstore.json')

    // First boot: enablePersistence on an empty file attaches the change→persist
    // listener, then we add a browser widget with notes (no PinSet yet) and run
    // the migration — the seed's change event schedules a persist.
    const s1 = new DocumentStore()
    s1.enablePersistence(file) // empty file: nothing to hydrate, listener attached
    s1.upsertBrowserWidget('browser-d', widget('browser-d', { spaceId: 'D', notes: [note('nd')] }))
    migrateAllBrowserNotes(s1) // seeds D's PinSet; emits change → schedules persist
    s1.flush() // force the scheduled persist to disk synchronously

    // The seeded PinSet must be on disk.
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    const dSet = onDisk.pinSets?.find((p: { spaceId: string }) => p.spaceId === 'D')
    expect(dSet?.pins.map((p: { id: string }) => p.id)).toEqual(['nd'])

    // Second boot from the same file: the PinSet is hydrated, so the migration
    // sees an existing PinSet and does NOT re-seed.
    const s2 = new DocumentStore()
    s2.enablePersistence(file)
    // Re-running the migration explicitly proves it now skips (existing PinSet).
    const res = migrateAllBrowserNotes(s2)
    expect(res.seeded).toEqual([])
    expect(res.skippedExisting).toEqual(['D'])
    expect(s2.getPinSet('D')!.pins.map(p => p.id)).toEqual(['nd'])
  })
})

// src/server/stores/__tests__/document-store-graveyard.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocumentStore } from '../document-store'
import type { Tombstone } from '../../../domain/types'

function makeTombstone(overrides: Partial<Tombstone> = {}): Tombstone {
  return {
    convId: 'conv-abc',
    sessionName: 'askviktor',
    coversSummary: 'Explored the design of the graveyard feature.',
    taskId: 'task-1',
    task: 'Graveyard',
    workspacePath: '/tmp/wt/askviktor',
    model: 'claude-opus-4-8',
    created: '2026-06-30T10:00:00.000Z',
    retiredAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
  }
}

describe('DocumentStore graveyard', () => {
  it('upserts, reads, and lists tombstones, emitting a change keyed by convId', () => {
    const store = new DocumentStore()
    const events: Array<{ entity: string; id: string; data: unknown }> = []
    store.changes.on('change', e => events.push(e))

    const t = makeTombstone()
    store.upsertTombstone(t)

    expect(store.getTombstone('conv-abc')).toEqual(t)
    expect(store.getAllTombstones()).toEqual([t])
    const last = events.at(-1)!
    expect(last.entity).toBe('tombstone')
    expect(last.id).toBe('conv-abc')
  })

  it('short-circuits an identical upsert (no duplicate change event)', () => {
    const store = new DocumentStore()
    const events: unknown[] = []
    store.upsertTombstone(makeTombstone())
    store.changes.on('change', e => events.push(e))

    store.upsertTombstone(makeTombstone()) // identical

    expect(events).toHaveLength(0)
  })

  it('emits a change when a field actually differs', () => {
    const store = new DocumentStore()
    store.upsertTombstone(makeTombstone())
    const events: unknown[] = []
    store.changes.on('change', e => events.push(e))

    store.upsertTombstone(makeTombstone({ coversSummary: 'regenerated summary' }))

    expect(events).toHaveLength(1)
    expect(store.getTombstone('conv-abc')!.coversSummary).toBe('regenerated summary')
  })

  it('emits a change when only the snapshotted flag differs', () => {
    const store = new DocumentStore()
    store.upsertTombstone(makeTombstone({ snapshotted: false }))
    const events: unknown[] = []
    store.changes.on('change', e => events.push(e))

    store.upsertTombstone(makeTombstone({ snapshotted: true }))

    expect(events).toHaveLength(1)
    expect(store.getTombstone('conv-abc')!.snapshotted).toBe(true)
  })

  it('purges a tombstone and reports whether one was removed', () => {
    const store = new DocumentStore()
    store.upsertTombstone(makeTombstone())

    expect(store.deleteTombstone('conv-abc')).toBe(true)
    expect(store.getTombstone('conv-abc')).toBeUndefined()
    expect(store.deleteTombstone('conv-abc')).toBe(false) // already gone
  })

  it('persists tombstones and reloads them in a fresh store (survives dir loss)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graveyard-'))
    const file = join(dir, 'docstore.json')
    try {
      const store = new DocumentStore()
      store.enablePersistence(file)
      store.upsertTombstone(makeTombstone())
      store.flush()

      // A brand-new store reading the same file — models a backend restart
      // after the session dir + worktree were removed.
      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      expect(reloaded.getTombstone('conv-abc')).toEqual(makeTombstone())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a corrupt tombstone (no convId) on load without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graveyard-'))
    const file = join(dir, 'docstore.json')
    try {
      const store = new DocumentStore()
      store.enablePersistence(file)
      // Write one good + one convId-less entry directly, then reload.
      store.upsertTombstone(makeTombstone())
      store.upsertTombstone(makeTombstone({ convId: 'conv-2' }))
      store.flush()
      // Corrupt the file: drop convId from the second entry.
      const data = JSON.parse(readFileSync(file, 'utf-8'))
      data.graveyard[1].convId = ''
      writeFileSync(file, JSON.stringify(data))

      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      expect(reloaded.getAllTombstones()).toHaveLength(1)
      expect(reloaded.getTombstone('conv-abc')).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

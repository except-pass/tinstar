// src/server/stores/__tests__/document-store.notices.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocumentStore } from '../document-store'
import type { Notice, Run } from '../../../domain/types'

function makeNotice(overrides: Partial<Notice> = {}): Notice {
  const now = 1_700_000_000_000
  return {
    id: 'notice-1',
    runId: 'CLD-run-1',
    kind: 'needs-you',
    headline: 'Deploy now or wait for review?',
    content: {
      root: 'root',
      components: [
        { id: 'root', component: 'Text', text: 'Two options, laid out in plain words.', variant: 'body' },
      ],
    },
    createdAt: now,
    amendedAt: now,
    ...overrides,
  }
}

function seedRun(store: DocumentStore, id: string, sessionId = id): void {
  const run: Run = {
    id, sessionId, status: 'running', name: undefined,
    initiative: '', epic: '', task: '', repo: 'repo', worktree: 'wt',
    taskId: 'task-1', worktreeId: 'wt', createdAt: '2026-07-01T00:00:00Z',
    recapEntries: [], touchedFiles: [], rawLogs: '', port: null,
    backend: 'tmux', spaceId: 'spc-1',
  } as unknown as Run
  store.upsertRun(id, run)
}

type Change = { entity: string; id: string; data: unknown }

describe('DocumentStore notices', () => {
  it('posts a notice: stores it and emits one change keyed by id with entity "notice"', () => {
    const store = new DocumentStore()
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    const n = makeNotice()
    store.upsertNotice(n)

    expect(store.getNotice('notice-1')).toEqual(n)
    expect(store.getAllNotices()).toEqual([n])
    expect(events).toHaveLength(1)
    expect(events[0]!.entity).toBe('notice')
    expect(events[0]!.id).toBe('notice-1')
    expect(events[0]!.data).toEqual(n)
  })

  it('amends a notice: a changed headline emits exactly one change and advances amendedAt past createdAt', () => {
    const store = new DocumentStore()
    store.upsertNotice(makeNotice())
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    const amended = makeNotice({ headline: 'Deploy, wait, or ship behind a flag?', amendedAt: 1_700_000_060_000 })
    store.upsertNotice(amended)

    expect(events).toHaveLength(1)
    const stored = store.getNotice('notice-1')!
    expect(stored.headline).toBe('Deploy, wait, or ship behind a flag?')
    expect(stored.amendedAt).toBeGreaterThan(stored.createdAt)
  })

  // CONTRACT TEST: the mutator must equality-short-circuit. If the guard in
  // upsertNotice is removed, an identical re-post broadcasts an SSE delta and
  // reschedules a persist for nothing — this test fails.
  it('short-circuits an identical upsert: zero change events', () => {
    const store = new DocumentStore()
    store.upsertNotice(makeNotice())
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    store.upsertNotice(makeNotice()) // value-equal to the stored one

    expect(events).toHaveLength(0)
  })

  // Guards the noticeEqual content compare: a changed A2UI body must broadcast,
  // and a structurally-identical one must short-circuit. If noticeEqual stopped
  // comparing `content` (e.g. reverted to only scalar fields), the first
  // assertion fails (a real amend would be swallowed).
  it('treats content by value: a changed A2UI body emits one change, an identical one emits none', () => {
    const store = new DocumentStore()
    store.upsertNotice(makeNotice())
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    const changed = makeNotice({
      content: { root: 'root', components: [{ id: 'root', component: 'Text', text: 'A different body.', variant: 'body' }] },
    })
    store.upsertNotice(changed)
    expect(events).toHaveLength(1)

    // Re-post a fresh object that is structurally identical — must short-circuit.
    events.length = 0
    store.upsertNotice(makeNotice({
      content: { root: 'root', components: [{ id: 'root', component: 'Text', text: 'A different body.', variant: 'body' }] },
    }))
    expect(events).toHaveLength(0)
  })

  // Guards the noticeEqual answer compare: persisting the user's answer must
  // broadcast (the widget reflects "answered"), and an identical re-upsert must
  // short-circuit. If noticeEqual stopped comparing `answer`, the first assertion
  // fails (a real answer would be swallowed and never reach the board).
  it('treats answer by value: writing an answer emits one change, an identical re-upsert emits none', () => {
    const store = new DocumentStore()
    store.upsertNotice(makeNotice())
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    const answered = makeNotice({ answer: { choices: ['opt-a'], text: 'go', answeredAt: 1_700_000_060_000 } })
    store.upsertNotice(answered)
    expect(events).toHaveLength(1)
    expect(store.getNotice('notice-1')!.answer!.choices).toEqual(['opt-a'])

    // Re-upsert a structurally identical answered notice — must short-circuit.
    events.length = 0
    store.upsertNotice(makeNotice({ answer: { choices: ['opt-a'], text: 'go', answeredAt: 1_700_000_060_000 } }))
    expect(events).toHaveLength(0)
  })

  // Guards the noticeEqual dismissedAt compare. The user's dismiss bit is the
  // ONLY thing that changes on a dismiss write, so if noticeEqual stopped
  // comparing it the write would short-circuit SILENTLY: no SSE delta, and the
  // board would never dim the card. Both assertions below would fail.
  it('treats dismissedAt by value: dismissing emits one change, an identical re-upsert emits none', () => {
    const store = new DocumentStore()
    store.upsertNotice(makeNotice())
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    store.upsertNotice(makeNotice({ dismissedAt: 1_700_000_060_000 }))
    expect(events).toHaveLength(1)
    expect(store.getNotice('notice-1')!.dismissedAt).toBe(1_700_000_060_000)

    events.length = 0
    store.upsertNotice(makeNotice({ dismissedAt: 1_700_000_060_000 }))
    expect(events).toHaveLength(0)
  })

  it('undismissing (clearing dismissedAt) emits a change; absent and undefined are the same value', () => {
    const store = new DocumentStore()
    store.upsertNotice(makeNotice({ dismissedAt: 1_700_000_060_000 }))
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    store.upsertNotice(makeNotice({ dismissedAt: undefined }))
    expect(events).toHaveLength(1)
    expect(store.getNotice('notice-1')!.dismissedAt).toBeUndefined()

    // An explicit `undefined` and an absent key must not look like a change.
    events.length = 0
    store.upsertNotice(makeNotice())
    expect(events).toHaveLength(0)
  })

  // Guards the noticeEqual followUps compare. A thread write moves NOTHING else on
  // the notice — not amendedAt, not answer, not dismissedAt — so this compare is the
  // only thing that makes asking a question observable. Drop it and the write
  // short-circuits SILENTLY: no SSE delta, and the widget's ask panel never updates.
  it('treats followUps by value: appending a message emits one change, an identical re-upsert emits none', () => {
    const store = new DocumentStore()
    store.upsertNotice(makeNotice())
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    const q = { id: 'fu-1', author: 'user' as const, text: 'explain that plainly?', createdAt: 1_700_000_060_000 }
    store.upsertNotice(makeNotice({ followUps: [q] }))
    expect(events).toHaveLength(1)
    expect(store.getNotice('notice-1')!.followUps).toHaveLength(1)

    events.length = 0
    store.upsertNotice(makeNotice({ followUps: [q] }))
    expect(events).toHaveLength(0)

    // The agent's reply appends to the same thread — also a change.
    const a = { id: 'fu-2', author: 'agent' as const, text: 'here it is in plain words', createdAt: 1_700_000_070_000 }
    store.upsertNotice(makeNotice({ followUps: [q, a] }))
    expect(events).toHaveLength(1)
    expect(store.getNotice('notice-1')!.followUps).toHaveLength(2)
  })

  it('pulls a notice: deleteNotice removes it and emits a change with data:null; a missing id returns false and emits nothing', () => {
    const store = new DocumentStore()
    store.upsertNotice(makeNotice())
    const events: Change[] = []
    store.changes.on('change', e => events.push(e as Change))

    expect(store.deleteNotice('notice-1')).toBe(true)
    expect(store.getNotice('notice-1')).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(events[0]!.entity).toBe('notice')
    expect(events[0]!.id).toBe('notice-1')
    expect(events[0]!.data).toBeNull()

    events.length = 0
    expect(store.deleteNotice('notice-1')).toBe(false) // already gone
    expect(events).toHaveLength(0)
  })

  it('run-end cascade (R20 / AE3): deleting a run drops every notice it posted, emits a null change per notice, and leaves other runs\' notices standing', () => {
    const store = new DocumentStore()
    seedRun(store, 'CLD-run-1')
    seedRun(store, 'CLD-run-2')
    store.upsertNotice(makeNotice({ id: 'notice-a', runId: 'CLD-run-1' }))
    store.upsertNotice(makeNotice({ id: 'notice-b', runId: 'CLD-run-1' }))
    store.upsertNotice(makeNotice({ id: 'notice-c', runId: 'CLD-run-2' }))

    const noticeNulls: string[] = []
    store.changes.on('change', e => {
      const c = e as Change
      if (c.entity === 'notice' && c.data === null) noticeNulls.push(c.id)
    })

    store.deleteRun('CLD-run-1')

    expect(store.getNotice('notice-a')).toBeUndefined()
    expect(store.getNotice('notice-b')).toBeUndefined()
    expect(store.getNotice('notice-c')).toBeDefined() // different run — survives
    expect(new Set(noticeNulls)).toEqual(new Set(['notice-a', 'notice-b']))
  })

  it('run-end cascade also fires when a run is deleted by sessionId (simulator keying)', () => {
    const store = new DocumentStore()
    seedRun(store, 'R-xyz', 'CLD-session-9')
    store.upsertNotice(makeNotice({ id: 'notice-s', runId: 'R-xyz' }))

    store.deleteRun('CLD-session-9') // delete by sessionId, not the map key

    expect(store.getNotice('notice-s')).toBeUndefined()
  })

  it('persists notices and reloads them in a fresh store (round-trip through snapshotAll)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notices-'))
    const file = join(dir, 'docstore.json')
    try {
      const store = new DocumentStore()
      store.enablePersistence(file)
      store.upsertNotice(makeNotice({ id: 'notice-p' }))
      store.flush()

      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      expect(reloaded.getAllNotices()).toHaveLength(1)
      expect(reloaded.getNotice('notice-p')).toEqual(makeNotice({ id: 'notice-p' }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

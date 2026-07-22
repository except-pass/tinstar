// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../document-store'
import type { Run, SlateSurface } from '../../../domain/types'

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'vpppm-general-pourpose-2dc86',
    sessionId: 'vpppm-general-pourpose-2dc86',
    taskId: 't1',
    worktreeId: 'wt1',
    status: 'running',
    background: false,
    blocked: false,
    initiative: 'i', epic: 'e', task: 't',
    repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

function surface(id: string, text: string): SlateSurface {
  return {
    id, author: 'agent', kind: 'diagram', createdAt: 1, amendedAt: 1,
    body: { root: 'r', components: [{ component: 'Text', id: 'r', text }] },
  }
}

/** Count `change` events emitted for runs while `fn` runs. */
function countRunEmits(store: DocumentStore, fn: () => void): number {
  let n = 0
  const onChange = (c: { entity: string }) => { if (c.entity === 'run') n++ }
  store.changes.on('change', onChange)
  try { fn() } finally { store.changes.off('change', onChange) }
  return n
}

describe('DocumentStore — run Slate projection', () => {
  it('emits a change when surfaces are projected onto a run', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    const emits = countRunEmits(store, () => {
      store.setRunSlate(run.id, [surface('s1', 'step 1/3')])
    })

    expect(emits).toBe(1)
    expect(store.getRun(run.id)?.slate).toHaveLength(1)
  })

  it('emits nothing when the same surfaces are re-projected (the file-watch storm guard)', () => {
    // Guards the by-value short-circuit in setRunSlate AND the runShallowEqual
    // slate compare: the Slate watcher rebuilds a fresh projection object on every
    // fs event, so a reference compare would emit constantly. Back out either
    // by-value compare and this test goes red.
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.setRunSlate(run.id, [surface('s1', 'step 1/3')])

    const emits = countRunEmits(store, () => {
      store.setRunSlate(run.id, [surface('s1', 'step 1/3')]) // fresh object, identical value
    })

    expect(emits).toBe(0)
  })

  it('emits a change when a surface body changes', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.setRunSlate(run.id, [surface('s1', 'step 1/3')])

    const emits = countRunEmits(store, () => {
      store.setRunSlate(run.id, [surface('s1', 'step 2/3')])
    })

    expect(emits).toBe(1)
  })

  it('clears the Slate (empty array → undefined) and emits', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.setRunSlate(run.id, [surface('s1', 'done')])

    const emits = countRunEmits(store, () => {
      store.setRunSlate(run.id, [])
    })

    expect(emits).toBe(1)
    expect(store.getRun(run.id)?.slate).toBeUndefined()
  })

  it('emits nothing when an already-empty Slate is cleared again', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    const emits = countRunEmits(store, () => {
      store.setRunSlate(run.id, undefined)
    })

    expect(emits).toBe(0)
  })

  it('emits when an upsertRun changes only the slate field (runShallowEqual guard)', () => {
    // Guards the slate compare inside runShallowEqual specifically: upsertRun
    // short-circuits on runShallowEqual, so a slate-only change with the compare
    // missing would be judged "no change" and the delta dropped SILENTLY.
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    const emits = countRunEmits(store, () => {
      store.upsertRun(run.id, { ...run, slate: [surface('s1', 'hi')] })
    })

    expect(emits).toBe(1)
    expect(store.getRun(run.id)?.slate).toHaveLength(1)
  })

  it('rides the run snapshot (so it persists and reaches new clients)', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.setRunSlate(run.id, [surface('s1', 'persisted')])

    const snapRun = store.snapshot().runs.find(r => r.id === run.id)
    expect(snapRun?.slate).toHaveLength(1)
  })
})

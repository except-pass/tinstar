// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../document-store'
import type { Run } from '../../../domain/types'

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

/** Count `change` events emitted for runs while `fn` runs. */
function countRunEmits(store: DocumentStore, fn: () => void): number {
  let n = 0
  const onChange = (c: { entity: string }) => { if (c.entity === 'run') n++ }
  store.changes.on('change', onChange)
  try { fn() } finally { store.changes.off('change', onChange) }
  return n
}

describe('DocumentStore — run friendly name', () => {
  it('emits a change when a name is set on a run', () => {
    // Guards the runShallowEqual short-circuit in upsertRun: a field missing from
    // that comparison is judged "no change", the emit is skipped, and the rename
    // never reaches any client. The optimistic UI update would mask this locally.
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    const emits = countRunEmits(store, () => {
      store.upsertRun(run.id, { ...run, name: 'PM Vpp project' })
    })

    expect(emits).toBe(1)
    expect(store.getRun(run.id)?.name).toBe('PM Vpp project')
  })

  it('emits a change when a name is changed to a different name', () => {
    const store = new DocumentStore()
    const run = makeRun({ name: 'PM Vpp project' })
    store.upsertRun(run.id, run)

    const emits = countRunEmits(store, () => {
      store.upsertRun(run.id, { ...run, name: 'VPP program management' })
    })

    expect(emits).toBe(1)
    expect(store.getRun(run.id)?.name).toBe('VPP program management')
  })

  it('emits a change when a name is cleared back to undefined', () => {
    const store = new DocumentStore()
    const run = makeRun({ name: 'PM Vpp project' })
    store.upsertRun(run.id, run)

    const emits = countRunEmits(store, () => {
      store.upsertRun(run.id, { ...run, name: undefined })
    })

    expect(emits).toBe(1)
    expect(store.getRun(run.id)?.name).toBeUndefined()
  })

  it('emits nothing when the run is re-upserted with an unchanged name', () => {
    const store = new DocumentStore()
    const run = makeRun({ name: 'PM Vpp project' })
    store.upsertRun(run.id, run)

    const emits = countRunEmits(store, () => {
      store.upsertRun(run.id, { ...run, name: 'PM Vpp project' })
    })

    expect(emits).toBe(0)
  })

  it('never lets a rename touch the run id', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.upsertRun(run.id, { ...run, name: 'PM Vpp project' })

    const after = store.getRun('vpppm-general-pourpose-2dc86')
    expect(after?.id).toBe('vpppm-general-pourpose-2dc86')
    expect(after?.sessionId).toBe('vpppm-general-pourpose-2dc86')
    expect(after?.worktree).toBe('w')
  })
})

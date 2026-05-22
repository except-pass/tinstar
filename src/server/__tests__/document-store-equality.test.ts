import { describe, it, expect, beforeEach } from 'vitest'
import { DocumentStore } from '../stores/document-store'
import type { Run } from '../../domain/types'
import type { TouchedFile } from '../../types'

// Factory — never share a Run reference across tests. updateRunStatus mutates
// the stored run in place, so a shared reference leaks state between tests.
const makeRun = (): Run => ({
  id: 'r1',
  status: 'running',
  sessionId: 's1',
  initiative: 'i',
  epic: 'e',
  task: 't',
  repo: 'repo',
  worktree: 'wt',
  taskId: 't',
  worktreeId: 'wt',
  createdAt: '2026-05-22T00:00:00Z',
  recapEntries: [],
  touchedFiles: [],
  rawLogs: '',
  port: null,
  backend: 'tmux',
})

describe('DocumentStore equality short-circuits', () => {
  let store: DocumentStore
  let changes: unknown[]

  beforeEach(() => {
    store = new DocumentStore()
    changes = []
    store.changes.on('change', (e) => changes.push(e))
  })

  it('updateRunStatus: does NOT emit when status is unchanged', () => {
    store.upsertRun('r1', makeRun())
    changes.length = 0
    store.updateRunStatus('r1', 'running')
    expect(changes).toHaveLength(0)
  })

  it('updateRunStatus: DOES emit when status changes', () => {
    store.upsertRun('r1', makeRun())
    changes.length = 0
    store.updateRunStatus('r1', 'idle')
    expect(changes).toHaveLength(1)
  })

  it('reconcileFiles: does NOT emit when the file set is identical', () => {
    const f: TouchedFile = { id: 'a.ts', name: 'a.ts', path: 'a.ts', additions: 1, deletions: 0, kind: 'code' }
    store.upsertRun('r1', { ...makeRun(), touchedFiles: [f] })
    changes.length = 0
    store.reconcileFiles('r1', [{ ...f }])
    expect(changes).toHaveLength(0)
  })

  it('reconcileFiles: DOES emit when files differ', () => {
    store.upsertRun('r1', makeRun())
    changes.length = 0
    store.reconcileFiles('r1', [{ id: 'a.ts', name: 'a.ts', path: 'a.ts', additions: 1, deletions: 0, kind: 'code' }])
    expect(changes).toHaveLength(1)
  })

  it('upsertRun: does NOT emit when the new run is shallow-equal to the existing one', () => {
    // Production callers always derive the next run from the existing one via
    // { ...existing, foo: x } — the array refs (touchedFiles, recapEntries)
    // carry through the spread. Reproduce that pattern, not a fresh-from-factory
    // re-upsert which would needlessly diff on array identity.
    const run = makeRun()
    store.upsertRun('r1', run)
    changes.length = 0
    store.upsertRun('r1', { ...run })
    expect(changes).toHaveLength(0)
  })

  it('upsertRun: DOES emit when a field changes', () => {
    const run = makeRun()
    store.upsertRun('r1', run)
    changes.length = 0
    store.upsertRun('r1', { ...run, status: 'idle' })
    expect(changes).toHaveLength(1)
  })
})

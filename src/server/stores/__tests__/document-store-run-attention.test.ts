// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DocumentStore, attentionForRunStatus } from '../document-store'
import type { Run } from '../../../domain/types'

function seedRun(store: DocumentStore): Run {
  const run: Run = {
    id: 'r1',
    sessionId: 's1',
    taskId: 't1',
    worktreeId: 'wt1',
    status: 'running',
    initiative: 'i', epic: 'e', task: 't',
    repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null,
    createdAt: '2026-05-27T00:00:00.000Z',
  }
  store.upsertRun(run.id, run)
  return run
}

describe('attentionForRunStatus', () => {
  it('maps needs_attention to urgent', () => {
    expect(attentionForRunStatus('needs_attention')?.level).toBe('urgent')
  })
  it('maps stopped to info', () => {
    expect(attentionForRunStatus('stopped')?.level).toBe('info')
  })
  it('returns null for running/idle/creating', () => {
    expect(attentionForRunStatus('running')).toBeNull()
    expect(attentionForRunStatus('idle')).toBeNull()
    expect(attentionForRunStatus('creating')).toBeNull()
  })
})

describe('updateRunStatus → attention', () => {
  it('transitioning to needs_attention sets urgent attention', () => {
    const store = new DocumentStore()
    seedRun(store)
    store.updateRunStatus('r1', 'needs_attention')
    expect(store.getAllRuns()[0]?.attention?.level).toBe('urgent')
  })

  it('transitioning back to running clears attention', () => {
    const store = new DocumentStore()
    seedRun(store)
    store.updateRunStatus('r1', 'needs_attention')
    store.updateRunStatus('r1', 'running')
    expect(store.getAllRuns()[0]?.attention).toBeUndefined()
  })

  it('does not emit twice when status is unchanged', () => {
    const store = new DocumentStore()
    seedRun(store)
    store.updateRunStatus('r1', 'needs_attention')           // initial transition
    let count = 0
    store.changes.on('change', () => count++)
    store.updateRunStatus('r1', 'needs_attention')           // no-op
    expect(count).toBe(0)
  })
})

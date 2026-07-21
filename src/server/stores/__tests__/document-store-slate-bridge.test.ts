// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../document-store'
import type { Run } from '../../../domain/types'

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1', sessionId: 'r1', taskId: 't1', worktreeId: 'wt1',
    status: 'running', background: false, blocked: false,
    initiative: 'i', epic: 'e', task: 't', repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null, createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

// The reconciliation: store-backed points are the source of truth, but the client
// renders ONE channel (RunData.slate). DocumentStore bridges points -> run.slate
// after every mutation, so the run card reflects points + threads + status without
// subscribing to a second stream.
describe('DocumentStore — Slate points bridge to run.slate', () => {
  it('projects a store point onto run.slate as an open-point surface', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)

    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Which rollback path?' }])

    const slate = store.getRun(run.id)?.slate
    expect(slate).toHaveLength(1)
    expect(slate?.[0]).toMatchObject({ id: 'p1', kind: 'open-point', headline: 'Which rollback path?', status: 'open' })
  })

  it('reflects a reply on run.slate — thread grows and status becomes waiting', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Q?' }])

    store.addSlateReply(run.id, 'p1', { id: 'rep1', author: 'user', text: 'revert', createdAt: 10 })

    const s = store.getRun(run.id)?.slate?.[0]
    expect(s?.thread).toHaveLength(1)
    expect(s?.status).toBe('waiting') // last author = user
  })

  it('reflects an explicit resolve on run.slate and it survives a re-projection', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Q?' }])
    store.resolveSlatePoint(run.id, 'p1')

    expect(store.getRun(run.id)?.slate?.[0]?.status).toBe('resolved')

    // A later file re-projection of the same point (body unchanged) must not revert
    // the store-owned resolve.
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Q?' }])
    expect(store.getRun(run.id)?.slate?.[0]?.status).toBe('resolved')
  })

  it('clears run.slate when the run retracts all its points', () => {
    const store = new DocumentStore()
    const run = makeRun()
    store.upsertRun(run.id, run)
    store.applyRunSlateProjection(run.id, [{ id: 'p1', headline: 'Q?' }])
    expect(store.getRun(run.id)?.slate).toHaveLength(1)

    store.applyRunSlateProjection(run.id, []) // file emptied → retract
    expect(store.getRun(run.id)?.slate).toBeUndefined()
  })
})

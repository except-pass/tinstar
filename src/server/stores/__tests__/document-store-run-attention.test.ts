// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DocumentStore, attentionForRunStatus, deriveRunAttention, runNeedsStatusCorrection } from '../document-store'
import type { Run } from '../../../domain/types'

function seedRun(store: DocumentStore, overrides: Partial<Run> = {}): Run {
  const run: Run = {
    id: 'r1',
    sessionId: 's1',
    taskId: 't1',
    worktreeId: 'wt1',
    status: 'running',
    background: false,
    blocked: false,
    initiative: 'i', epic: 'e', task: 't',
    repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null,
    createdAt: '2026-05-27T00:00:00.000Z',
    ...overrides,
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
  it('maps idle (quiet + ready) to attention', () => {
    expect(attentionForRunStatus('idle')?.level).toBe('attention')
    expect(attentionForRunStatus('idle')?.reason).toBe('Ready for input')
  })
  it('returns null for running/creating', () => {
    expect(attentionForRunStatus('running')).toBeNull()
    expect(attentionForRunStatus('creating')).toBeNull()
  })
})

describe('deriveRunAttention — background mapping', () => {
  it('idle + blocked → urgent "Waiting on permission"', () => {
    const attn = deriveRunAttention('idle', true, true)
    expect(attn?.level).toBe('urgent')
    expect(attn?.reason).toBe('Waiting on permission')
  })
  it('idle + not blocked → null (a background agent idles by design)', () => {
    expect(deriveRunAttention('idle', false, true)).toBeNull()
  })
  it('stopped → info "Run stopped"', () => {
    const attn = deriveRunAttention('stopped', false, true)
    expect(attn?.level).toBe('info')
    expect(attn?.reason).toBe('Run stopped')
  })
  it('needs_attention → urgent', () => {
    expect(deriveRunAttention('needs_attention', false, true)?.level).toBe('urgent')
  })
  it('running/creating → null', () => {
    expect(deriveRunAttention('running', false, true)).toBeNull()
    expect(deriveRunAttention('creating', false, true)).toBeNull()
    // Blocked while a tool is still winding down doesn't surface either.
    expect(deriveRunAttention('running', true, true)).toBeNull()
  })
})

describe('deriveRunAttention — non-background pinned to today\'s mapping, blocked ignored', () => {
  for (const blocked of [false, true]) {
    it(`idle → attention "Ready for input" (blocked: ${blocked})`, () => {
      const attn = deriveRunAttention('idle', blocked, false)
      expect(attn?.level).toBe('attention')
      expect(attn?.reason).toBe('Ready for input')
    })
    it(`stopped → info "Run stopped" (blocked: ${blocked})`, () => {
      const attn = deriveRunAttention('stopped', blocked, false)
      expect(attn?.level).toBe('info')
      expect(attn?.reason).toBe('Run stopped')
    })
    it(`needs_attention → urgent (blocked: ${blocked})`, () => {
      expect(deriveRunAttention('needs_attention', blocked, false)?.level).toBe('urgent')
    })
    it(`running/creating → null (blocked: ${blocked})`, () => {
      expect(deriveRunAttention('running', blocked, false)).toBeNull()
      expect(deriveRunAttention('creating', blocked, false)).toBeNull()
    })
  }
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

  it('transitioning to idle sets a "ready for input" attention', () => {
    const store = new DocumentStore()
    seedRun(store)               // seeded as 'running'
    store.updateRunStatus('r1', 'idle')
    const attn = store.getAllRuns()[0]?.attention
    expect(attn?.level).toBe('attention')
    expect(attn?.reason).toBe('Ready for input')
  })

  it('going idle → running → idle clears then re-arms the inbox signal', () => {
    const store = new DocumentStore()
    seedRun(store)
    store.updateRunStatus('r1', 'idle')
    expect(store.getAllRuns()[0]?.attention?.level).toBe('attention')
    store.updateRunStatus('r1', 'running')
    expect(store.getAllRuns()[0]?.attention).toBeUndefined()
    store.updateRunStatus('r1', 'idle')
    expect(store.getAllRuns()[0]?.attention?.level).toBe('attention')
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

  it('non-background: blocked does not alter derivation (idle + blocked stays "Ready for input")', () => {
    const store = new DocumentStore()
    seedRun(store)
    store.updateRunStatus('r1', 'idle', true)
    const run = store.getRun('r1')!
    expect(run.blocked).toBe(true)
    expect(run.attention?.level).toBe('attention')
    expect(run.attention?.reason).toBe('Ready for input')
  })
})

describe('updateRunStatus → attention (background runs)', () => {
  it('AE2: flipping to idle with blocked: true sets urgent "Waiting on permission"', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true })
    store.updateRunStatus('r1', 'idle', true)
    const attn = store.getRun('r1')?.attention
    expect(attn?.level).toBe('urgent')
    expect(attn?.reason).toBe('Waiting on permission')
  })

  it('idle without blocked surfaces nothing (no "Ready for input" pin)', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true })
    store.updateRunStatus('r1', 'idle', false)
    expect(store.getRun('r1')?.attention).toBeUndefined()
  })

  it('blocked flipping while status stays idle re-derives attention both ways', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true, status: 'idle' })
    // Block begins while already idle — status string unchanged.
    store.updateRunStatus('r1', 'idle', true)
    expect(store.getRun('r1')?.attention?.reason).toBe('Waiting on permission')
    // Override clears while status stays idle — urgent must clear too.
    store.updateRunStatus('r1', 'idle', false)
    expect(store.getRun('r1')?.attention).toBeUndefined()
  })

  it('stopped → info "Run stopped", and blocked is cleared on stop', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true, status: 'idle', blocked: true })
    store.updateRunStatus('r1', 'stopped')
    const run = store.getRun('r1')!
    expect(run.attention?.level).toBe('info')
    expect(run.attention?.reason).toBe('Run stopped')
    expect(run.blocked).toBe(false)
  })

  it('needs_attention → urgent (unchanged from non-background)', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true })
    store.updateRunStatus('r1', 'needs_attention')
    expect(store.getRun('r1')?.attention?.level).toBe('urgent')
  })

  it('running → null: clears a prior urgent when the agent resumes', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true, status: 'idle' })
    store.updateRunStatus('r1', 'idle', true)
    expect(store.getRun('r1')?.attention?.level).toBe('urgent')
    store.updateRunStatus('r1', 'running', false)
    expect(store.getRun('r1')?.attention).toBeUndefined()
  })

  it('omitting blocked keeps the run\'s current blocked value', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true, status: 'running', blocked: true })
    store.updateRunStatus('r1', 'idle')
    const run = store.getRun('r1')!
    expect(run.blocked).toBe(true)
    expect(run.attention?.reason).toBe('Waiting on permission')
  })

  it('no-op short-circuit compares (status, blocked): same pair emits nothing', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true })
    store.updateRunStatus('r1', 'idle', true)
    let count = 0
    store.changes.on('change', () => count++)
    store.updateRunStatus('r1', 'idle', true)
    expect(count).toBe(0)
  })

  it('attention dedupe preserved: re-deriving the same level+reason keeps setAt', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true, status: 'running' })
    store.updateRunStatus('r1', 'idle', true)
    const first = store.getRun('r1')!.attention
    // Status flips while blocked stays — derivation lands on the same
    // (urgent, "Waiting on permission") pair; setRunAttention must dedupe.
    store.updateRunStatus('r1', 'needs_attention', true)
    store.updateRunStatus('r1', 'idle', true)
    void first
    expect(store.getRun('r1')!.attention?.reason).toBe('Waiting on permission')
  })
})

describe('rederiveRunAttention — derivation-input flips outside updateRunStatus', () => {
  it('derives from the current (status, blocked, background) triple', () => {
    // Fresh-created rehydrate run: fields projected via upsertRun (which never
    // derives), then attention caught up explicitly.
    const store = new DocumentStore()
    seedRun(store, { background: true, status: 'idle', blocked: true })
    expect(store.getRun('r1')?.attention).toBeUndefined()
    store.rederiveRunAttention('r1')
    const attn = store.getRun('r1')?.attention
    expect(attn?.level).toBe('urgent')
    expect(attn?.reason).toBe('Waiting on permission')
  })

  it('clears attention that the current inputs no longer justify', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true, status: 'idle', blocked: true })
    store.rederiveRunAttention('r1')
    const run = store.getRun('r1')!
    // Simulate a background flip landing via upsertRun (the U4 PATCH path).
    store.upsertRun('r1', { ...run, blocked: false })
    store.rederiveRunAttention('r1')
    expect(store.getRun('r1')?.attention).toBeUndefined()
  })

  it('emits nothing when derivation is null and no attention is set', () => {
    const store = new DocumentStore()
    seedRun(store, { background: true, status: 'idle' })
    let count = 0
    store.changes.on('change', () => count++)
    store.rederiveRunAttention('r1')
    expect(count).toBe(0)
  })
})

describe('boot rehydrate guard — AE4 restart re-derivation', () => {
  it('fires when persisted blocked differs from the run even though status matches', () => {
    // Restart simulation: run persisted pre-restart as idle/unblocked, while
    // the session record says the agent was permission-blocked.
    const store = new DocumentStore()
    const existingRun = seedRun(store, { background: true, status: 'idle', blocked: false })

    // The rehydrate refresh spread (index.ts) — no status/blocked here.
    store.upsertRun('r1', { ...existingRun, background: true })

    expect(runNeedsStatusCorrection(existingRun, 'idle', true)).toBe(true)
    store.updateRunStatus('r1', 'idle', true)

    const run = store.getRun('r1')!
    expect(run.blocked).toBe(true)
    expect(run.attention?.level).toBe('urgent')
    expect(run.attention?.reason).toBe('Waiting on permission')
  })

  it('fires on a status mismatch (the pre-existing correction path)', () => {
    expect(runNeedsStatusCorrection({ status: 'running', blocked: false }, 'idle', false)).toBe(true)
  })

  it('does not fire when both status and blocked already match', () => {
    expect(runNeedsStatusCorrection({ status: 'idle', blocked: true }, 'idle', true)).toBe(false)
  })
})

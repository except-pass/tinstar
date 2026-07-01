import { describe, it, expect } from 'vitest'
import { reviveFromTombstone, reviveName, type NecroDeps } from '../necro'
import type { Tombstone } from '../../../domain/types'

function tomb(overrides: Partial<Tombstone> = {}): Tombstone {
  return {
    convId: 'conv-xyz',
    sessionName: 'askviktor',
    coversSummary: 'covered the graveyard',
    workspacePath: '/tmp/wt/askviktor',
    retiredAt: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function deps(overrides: Partial<NecroDeps> = {}): NecroDeps & { materialized: unknown[]; resumed: string[] } {
  const materialized: unknown[] = []
  const resumed: string[] = []
  return {
    findTranscript: () => '/home/u/.claude/projects/x/conv-xyz.jsonl',
    hasSnapshot: () => false,
    sessionExists: () => false,
    pathExists: () => true,
    materialize: opts => { materialized.push(opts) },
    resume: name => { resumed.push(name) },
    materialized,
    resumed,
    ...overrides,
  }
}

describe('reviveFromTombstone', () => {
  it('refuses revive when the transcript is gone (AE2)', async () => {
    const d = deps({ findTranscript: () => null })
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(false)
    expect(res.reason).toBe('transcript-unavailable')
    expect(d.materialized).toHaveLength(0)
    expect(d.resumed).toHaveLength(0)
  })

  it('revives from a durable snapshot when the live transcript is gone', async () => {
    const d = deps({ findTranscript: () => null, hasSnapshot: () => true })
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(true)
    expect(res.restoredFromSnapshot).toBe(true)
    expect(d.materialized).toHaveLength(1)
  })

  it('refuses when neither live transcript nor snapshot exists', async () => {
    const d = deps({ findTranscript: () => null, hasSnapshot: () => false })
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(false)
    expect(res.reason).toBe('transcript-unavailable')
  })

  it('materializes with the stored convId and resumes (happy path + fidelity)', async () => {
    const d = deps()
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(true)
    expect(res.sessionName).toBe('askviktor-necro')
    expect(d.materialized[0]).toMatchObject({ convId: 'conv-xyz', workspacePath: '/tmp/wt/askviktor' })
    expect(d.resumed).toEqual(['askviktor-necro'])
  })

  it('resumes against the stored convId even when newer transcripts exist (no mtime scan)', async () => {
    // findTranscript is keyed on the exact convId; assert the id threaded through is the tombstone's.
    let queried = ''
    const d = deps({ findTranscript: (c) => { queried = c; return '/x/conv-xyz.jsonl' } })
    await reviveFromTombstone(tomb({ convId: 'conv-xyz' }), d)
    expect(queried).toBe('conv-xyz')
    expect(d.materialized[0]).toMatchObject({ convId: 'conv-xyz' })
  })

  it('falls back to no cwd when the worktree is gone (AE1)', async () => {
    const d = deps({ pathExists: () => false })
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(true)
    expect(res.workspaceMissing).toBe(true)
    expect(d.materialized[0]).toMatchObject({ workspacePath: null })
  })

  it('picks a non-colliding name when a session already exists (idempotency)', async () => {
    const existing = new Set(['askviktor-necro'])
    const d = deps({ sessionExists: (n) => existing.has(n) })
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.sessionName).toBe('askviktor-necro-2')
  })
})

describe('reviveName', () => {
  it('returns base-necro when free', () => {
    expect(reviveName('foo', () => false)).toBe('foo-necro')
  })
  it('increments on collision', () => {
    const taken = new Set(['foo-necro', 'foo-necro-2'])
    expect(reviveName('foo', n => taken.has(n))).toBe('foo-necro-3')
  })
})

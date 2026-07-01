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

function deps(overrides: Partial<NecroDeps> = {}): NecroDeps & {
  launched: Array<{ name: string; convId: string; workspacePath: string | null }>
  revived: string[]
  rolledBack: string[]
} {
  const launched: Array<{ name: string; convId: string; workspacePath: string | null }> = []
  const revived: string[] = []
  const rolledBack: string[] = []
  return {
    findTranscript: () => '/home/u/.claude/projects/x/conv-xyz.jsonl',
    hasSnapshot: () => false,
    sessionExists: () => false,
    pathExists: () => true,
    launch: opts => { launched.push(opts) },
    onRevived: id => { revived.push(id) },
    onLaunchFailed: name => { rolledBack.push(name) },
    launched,
    revived,
    rolledBack,
    ...overrides,
  }
}

describe('reviveFromTombstone', () => {
  it('refuses revive when neither transcript nor snapshot exists (AE2)', async () => {
    const d = deps({ findTranscript: () => null, hasSnapshot: () => false })
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(false)
    expect(res.reason).toBe('transcript-unavailable')
    expect(d.launched).toHaveLength(0)
    expect(d.revived).toHaveLength(0)
  })

  it('revives from a durable snapshot when the live transcript is gone', async () => {
    const d = deps({ findTranscript: () => null, hasSnapshot: () => true })
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(true)
    expect(res.restoredFromSnapshot).toBe(true)
    expect(d.launched).toHaveLength(1)
  })

  it('launches with the stored convId and consumes the grave on success', async () => {
    const d = deps()
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(true)
    expect(res.sessionName).toBe('askviktor-necro')
    expect(d.launched[0]).toMatchObject({ convId: 'conv-xyz', workspacePath: '/tmp/wt/askviktor' })
    expect(d.revived).toEqual(['conv-xyz']) // grave consumed
    expect(d.rolledBack).toEqual([])
  })

  it('resolves against the stored convId even when newer transcripts exist (no mtime scan)', async () => {
    let queried = ''
    const d = deps({ findTranscript: (c) => { queried = c; return '/x/conv-xyz.jsonl' } })
    await reviveFromTombstone(tomb({ convId: 'conv-xyz' }), d)
    expect(queried).toBe('conv-xyz')
    expect(d.launched[0]).toMatchObject({ convId: 'conv-xyz' })
  })

  it('falls back to no cwd when the worktree is gone (AE1)', async () => {
    const d = deps({ pathExists: () => false })
    const res = await reviveFromTombstone(tomb(), d)
    expect(res.revivable).toBe(true)
    expect(res.workspaceMissing).toBe(true)
    expect(d.launched[0]).toMatchObject({ workspacePath: null })
  })

  it('rolls back and does NOT consume the grave when launch throws', async () => {
    const d = deps({ launch: () => { throw new Error('tmux boom') } })
    await expect(reviveFromTombstone(tomb(), d)).rejects.toThrow('tmux boom')
    expect(d.rolledBack).toEqual(['askviktor-necro']) // half-created session cleaned up
    expect(d.revived).toEqual([]) // grave intact for retry
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

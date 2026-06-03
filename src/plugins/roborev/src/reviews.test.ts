import { describe, it, expect } from 'vitest'
import { sortReviews, resolveRepoPath, pickBootstrapSource, applyOptimisticAction, type Review } from './reviews'

const base = (over: Partial<Review>): Review => ({
  id: 1, status: 'done', verdict: 'P', closed: false, commit_subject: 's', branch: 'b',
  repo_path: '/r', finished_at: null, ...over,
})

describe('sortReviews', () => {
  it('open reviews before closed, then by id descending', () => {
    const out = sortReviews([
      base({ id: 1, closed: true }),
      base({ id: 2, closed: false }),
      base({ id: 3, closed: false }),
    ])
    expect(out.map((r) => r.id)).toEqual([3, 2, 1])
  })
})

describe('resolveRepoPath', () => {
  const state = {
    sessions: [
      { name: 'cockpit-1', cliTemplate: 'roborev-tui', workspace: { path: '/repo/cockpit-wt' } },
      { name: 'work-1', project: 'tinstar', lastActive: '2026-06-03T10:00:00Z', workspace: { path: '/repo/work-wt' } },
    ],
    runs: [{ id: 'run-x', sessionId: 'run-x', worktreeId: 'wt-9' }],
    worktrees: [{ id: 'wt-9', worktreePath: '/repo/from-worktree' }],
  } as never

  it('prefers the cockpit session own workspace path', () => {
    expect(resolveRepoPath(state, 'cockpit-1', undefined)).toBe('/repo/cockpit-wt')
  })
  it('falls back to run→worktree worktreePath when no session match', () => {
    expect(resolveRepoPath(state, 'run-x', undefined)).toBe('/repo/from-worktree')
  })
  it('falls back to the explicit hint when nothing in state matches', () => {
    expect(resolveRepoPath(state, 'unknown', '/explicit/path')).toBe('/explicit/path')
  })
  it('returns null when nothing resolves', () => {
    expect(resolveRepoPath(state, 'unknown', undefined)).toBeNull()
  })
})

describe('pickBootstrapSource', () => {
  it('picks the most-recently-active non-cockpit session with project+path', () => {
    const state = { sessions: [
      { name: 'old', project: 'p', lastActive: '2026-06-01T00:00:00Z', workspace: { path: '/a' } },
      { name: 'new', project: 'q', lastActive: '2026-06-03T00:00:00Z', workspace: { path: '/b' } },
      { name: 'cockpit', project: 'r', cliTemplate: 'roborev-tui', lastActive: '2026-06-04T00:00:00Z', workspace: { path: '/c' } },
    ] } as never
    expect(pickBootstrapSource(state)).toEqual({ project: 'q', worktreePath: '/b' })
  })
  it('returns null when no qualifying session exists', () => {
    expect(pickBootstrapSource({ sessions: [{ name: 'x', cliTemplate: 'roborev-tui', workspace: { path: '/c' }, project: 'r' }] } as never)).toBeNull()
  })
  it('returns null on empty state', () => {
    expect(pickBootstrapSource({} as never)).toBeNull()
  })
})

describe('applyOptimisticAction', () => {
  const rows = [base({ id: 1, closed: false }), base({ id: 2, closed: false })]
  it('close marks the row closed', () => {
    expect(applyOptimisticAction(rows, 1, 'close').find((r) => r.id === 1)!.closed).toBe(true)
  })
  it('reopen marks the row open', () => {
    const closed = applyOptimisticAction(rows, 1, 'close')
    expect(applyOptimisticAction(closed, 1, 'reopen').find((r) => r.id === 1)!.closed).toBe(false)
  })
  it('comment leaves rows unchanged', () => {
    expect(applyOptimisticAction(rows, 1, 'comment')).toEqual(rows)
  })
})

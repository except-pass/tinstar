import { describe, it, expect } from 'vitest'
import { sortReviews, resolveRepoPath, applyOptimisticAction, type Review } from './reviews'

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
    runs: { 's1': { id: 's1', worktree: '/work/tree', repo: '/repo' } },
  } as never

  it('prefers explicit data.repoPath', () => {
    expect(resolveRepoPath(state, 's1', '/explicit')).toBe('/explicit')
  })
  it('falls back to the run worktree for the session', () => {
    expect(resolveRepoPath(state, 's1', undefined)).toBe('/work/tree')
  })
  it('returns null when the session is unknown', () => {
    expect(resolveRepoPath(state, 'nope', undefined)).toBeNull()
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

import { describe, it, expect } from 'vitest'
import { parseReviewList, parseReviewShow, sortReviews, applyOptimisticAction, actionArgv, pickBootstrapSource, sessionIdFromCreate, type Review } from './reviews'

const row = (o: Partial<Review> & { id: number }): Review => ({ status: 'done', verdict: 'P', closed: false, commit_subject: 's', branch: 'b', ...o })

describe('parseReviewList', () => {
  it('returns [] for empty stdout', () => { expect(parseReviewList('  ')).toEqual([]) })
  it('maps fields and defaults missing verdict to null', () => {
    const out = parseReviewList(JSON.stringify([{ id: 5, status: 'done', closed: false, commit_subject: 'x', branch: 'm' }]))
    expect(out[0]).toEqual({ id: 5, status: 'done', verdict: null, closed: false, commit_subject: 'x', branch: 'm' })
  })
})

describe('parseReviewShow', () => {
  it('extracts the output field', () => { expect(parseReviewShow(JSON.stringify({ output: 'No issues found.' }))).toBe('No issues found.') })
  it('returns empty for empty stdout', () => { expect(parseReviewShow('')).toBe('') })
})

describe('sortReviews', () => {
  it('open before closed, then id desc', () => {
    expect(sortReviews([row({ id: 1, closed: true }), row({ id: 2 }), row({ id: 3 })]).map((r) => r.id)).toEqual([3, 2, 1])
  })
})

describe('applyOptimisticAction', () => {
  const rows = [row({ id: 1 }), row({ id: 2 })]
  it('close marks closed', () => { expect(applyOptimisticAction(rows, 1, 'close').find((r) => r.id === 1)!.closed).toBe(true) })
  it('reopen marks open', () => { expect(applyOptimisticAction(applyOptimisticAction(rows, 1, 'close'), 1, 'reopen').find((r) => r.id === 1)!.closed).toBe(false) })
  it('comment unchanged', () => { expect(applyOptimisticAction(rows, 1, 'comment')).toEqual(rows) })
})

describe('actionArgv', () => {
  it('close', () => { expect(actionArgv(5, 'close')).toEqual(['roborev', 'close', '5']) })
  it('reopen', () => { expect(actionArgv(5, 'reopen')).toEqual(['roborev', 'close', '5', '--reopen']) })
  it('comment', () => { expect(actionArgv(5, 'comment', 'hi')).toEqual(['roborev', 'comment', '--job', '5', '-m', 'hi']) })
})

describe('pickBootstrapSource', () => {
  it('picks the most-recently-active non-cockpit session with project+path', () => {
    const state = { sessions: [
      { name: 'old', project: 'p', lastActive: '2026-06-01T00:00:00Z', workspace: { path: '/a' } },
      { name: 'new', project: 'q', lastActive: '2026-06-03T00:00:00Z', workspace: { path: '/b' } },
      { name: 'cockpit', project: 'r', cliTemplate: 'shell', lastActive: '2026-06-04T00:00:00Z', workspace: { path: '/c' } },
    ] } as never
    expect(pickBootstrapSource(state)).toEqual({ project: 'q', worktreePath: '/b' })
  })
  it('returns null when no qualifying session exists', () => {
    expect(pickBootstrapSource({ sessions: [{ name: 'x', cliTemplate: 'shell', workspace: { path: '/c' }, project: 'r' }] } as never)).toBeNull()
  })
  it('returns null on empty state', () => { expect(pickBootstrapSource({} as never)).toBeNull() })
})

describe('sessionIdFromCreate', () => {
  it('reads data.name (Session is keyed by name, not id)', () => {
    expect(sessionIdFromCreate({ ok: true, data: { name: 'roborev-cockpit-split-c', workspace: { path: '/x' } } })).toBe('roborev-cockpit-split-c')
  })
  it('falls back to data.id if present', () => {
    expect(sessionIdFromCreate({ ok: true, data: { id: 'legacy' } })).toBe('legacy')
  })
  it('returns null on a non-ok response', () => {
    expect(sessionIdFromCreate({ ok: false, error: { message: 'nope' } })).toBeNull()
  })
  it('returns null when no name/id', () => {
    expect(sessionIdFromCreate({ ok: true, data: {} })).toBeNull()
  })
})

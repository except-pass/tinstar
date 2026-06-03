import { describe, it, expect } from 'vitest'
import { parseReviewList, parseReviewShow, sortReviews, applyOptimisticAction, actionArgv, type Review } from './reviews'

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

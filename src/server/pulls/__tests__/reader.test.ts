import { describe, expect, it, vi } from 'vitest'
import { PullReader } from '../reader'
import { QueuePullReader } from '../../reconciliation/queuePulls'

const head = 'a'.repeat(40)
const row = (number: number) => ({ number, title: `Change ${number}\nwith multiline text`, html_url: `https://github.com/owner/repo/pull/${number}`, user: { login: 'author' }, draft: false, head: { sha: head }, base: { ref: 'main' }, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' })
describe('read-only PR inventory', () => {
  it('paginates unlinked PRs, deduplicates overlapping requests and caches complete inventory', async () => {
    const read = vi.fn(async (path: string) => path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => row(i + 1)) : [row(101)])
    const reader = new PullReader(read)
    const [one, two] = await Promise.all([reader.inventory(['owner/repo']), reader.inventory(['owner/repo'])])
    expect(one[0]?.pulls).toHaveLength(101)
    expect(one).toEqual(two)
    expect(one[0]?.coverage).toMatchObject({ complete: true, status: 'fresh' })
    await reader.inventory(['owner/repo'])
    expect(read).toHaveBeenCalledTimes(2)
    expect(one[0]?.pulls[0]).toMatchObject({ id: 'owner/repo#1', author: 'author', head, title: 'Change 1\nwith multiline text' })
  })
  it('reports missing CLI immediately and retains prior inventory visibly stale after failure', async () => {
    let now = 0
    const read = vi.fn().mockResolvedValue([row(1)])
    const reader = new PullReader(read, () => now)
    await reader.inventory(['owner/repo'])
    now += 61_000
    read.mockRejectedValue(new Error('GitHub reader unavailable: gh-axi is missing from the server PATH.'))
    const [cached] = await reader.inventory(['owner/repo'])
    expect(cached?.coverage).toMatchObject({ complete: false, status: 'stale', error: expect.stringContaining('gh-axi is missing') })
    expect(cached?.pulls[0]?.freshness).toBe('stale')
    const [empty] = await new PullReader(read).inventory(['owner/repo'])
    expect(empty?.coverage.status).toBe('unavailable')
    expect(empty?.pulls).toEqual([])
  })
  it('keeps successful pages with explicit partial coverage and rejects wrong repository identities', async () => {
    const read = vi.fn(async (path: string) => { if (path.endsWith('page=2')) throw new Error('Rate limit'); return Array.from({ length: 100 }, (_, i) => row(i + 1)) })
    const [result] = await new PullReader(read).inventory(['owner/repo'])
    expect(result?.pulls).toHaveLength(100)
    expect(result?.coverage).toMatchObject({ status: 'partial', complete: false, error: 'Rate limit' })
    const [wrong] = await new PullReader(async () => [row(1)]).inventory(['other/repo'])
    expect(wrong?.coverage).toMatchObject({ status: 'unavailable', error: 'GitHub PR identity mismatch' })
  })
})
it('captures description and exact-head changes, classifies reviews conservatively, and refuses changed heads', async () => {
  const read = vi.fn(async (path: string) => path.includes('/reviews?') ? [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', html_url: 'https://github.com/owner/repo/pull/1#review' }] : { head: { sha: head }, state: 'open', body: 'Actual description\nsecond line', additions: 3, deletions: 1, changed_files: 2 })
  const readiness = new QueuePullReader(async path => path.endsWith('/1') ? { state: 'open', merged: false, draft: false, head, mergeable: null } : path.includes('check-runs') ? { total: 0, returned: 0, pending: 0, failed: 0 } : { total: 0, state: 'pending' })
  const reader = new PullReader(read, Date.now, readiness)
  const detail = await reader.detail('https://github.com/owner/repo/pull/1', head)
  expect(detail).toMatchObject({ body: 'Actual description\nsecond line', additions: 3, deletions: 1, files: 2, checks: 'unknown', review: 'Changes requested', reviewsComplete: true })
  await expect(reader.detail('https://github.com/owner/repo/pull/1', 'b'.repeat(40))).rejects.toThrow('PR head changed')
})

import { describe, expect, it, vi } from 'vitest'
import { ReleasePullReader } from '../pulls'
const day = 24 * 60 * 60_000
const pollInterval = 120_000
const sha = 'a'.repeat(40), url = (number: number) => `https://github.com/owner/repo/pull/${number}`
const merged = { title: 'Real PR', state: 'closed', merged: true, merged_at: '2026-11-06T18:00:00Z', merge_commit_sha: sha }
const row = (number: number, updated: number, state: 'open' | 'closed', mergedAt: string | null = null) => ({
  number, title: 'Linked PR', state, merged_at: mergedAt, merge_commit_sha: sha, updated_at: new Date(updated).toISOString(),
  head: { sha }, base: { ref: 'main' },
})
describe('bounded read-only release PR observations', () => {
  it('uses GitHub effective merge commit, bounds calls, rotates coverage, and reuses stable merged evidence', async () => {
    let now = Date.now()
    const read = vi.fn().mockResolvedValue(merged), list = vi.fn().mockResolvedValue([])
    const reader = new ReleasePullReader(read, () => now, list)
    const urls = Array.from({ length: 8 }, (_, index) => url(index + 1))
    const first = await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(4)
    expect(first.get(url(1))).toMatchObject({ state: 'merged', mergeSha: sha, freshness: 'fresh' })
    now += 20_000
    const second = await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(8)
    expect(second.size).toBe(8)
    now += 601_000
    await reader.get([])
    await reader.get(urls); expect(read).toHaveBeenCalledTimes(8)
    expect(list).toHaveBeenCalledTimes(1)
    expect(read.mock.calls.every(call => !String(call[0]).includes('actions'))).toBe(true)
  })
  it('keeps failures and absent merge SHA unknown; retains a stale successful observation', async () => {
    let now = Date.now()
    const read = vi.fn().mockResolvedValue(merged), reader = new ReleasePullReader(read, () => now)
    const original = (await reader.get([url(1)])).get(url(1))
    now += day; read.mockRejectedValue(new Error('private auth detail'))
    expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ state: 'merged', freshness: 'stale', mergeSha: sha, observedAt: original?.observedAt })
    const invalid = new ReleasePullReader(vi.fn().mockResolvedValue({ ...merged, merge_commit_sha: null }))
    expect((await invalid.get([url(2)])).get(url(2))).toMatchObject({ state: 'unknown', mergeSha: null })
  })
  it('distinguishes a missing executable and failed reads from pending observations, then clears the error on recovery', async () => {
    let now = Date.now()
    const read = vi.fn().mockRejectedValue(Object.assign(new Error('private stderr'), { code: 'ENOENT' }))
    const reader = new ReleasePullReader(read, () => now)
    const initial = (await reader.get([url(1)] )).get(url(1))!
    expect(initial.readError).toContain('gh-axi is unavailable on the server PATH')
    expect(JSON.stringify(initial)).not.toContain('private stderr')
    now += pollInterval; read.mockResolvedValue(merged)
    expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ freshness: 'fresh', state: 'merged' })
    expect((await reader.get([url(1)])).get(url(1))!.readError).toBeUndefined()
    now += day; read.mockRejectedValue(new Error('private access detail'))
    const failed = (await reader.get([url(1)])).get(url(1))!
    expect(failed.freshness).toBe('stale')
    expect(failed.readError).toContain('GitHub read failed')
    expect(JSON.stringify(failed)).not.toContain('private access detail')
  })

  it('uses one retry per inaccessible repository instead of retrying hundreds of historical URLs', async () => {
    let now = Date.now()
    const urls = Array.from({ length: 450 }, (_, index) => url(index + 1))
    const read = vi.fn(), list = vi.fn().mockRejectedValue(new Error('GitHub read failed (HTTP 404)'))
    const reader = new ReleasePullReader(read, () => now, list)
    const [first, concurrent] = await Promise.all([reader.get(urls), reader.get(urls)])
    expect(first.size).toBe(urls.length)
    expect(concurrent).toEqual(first)
    expect(first.get(url(450))).toMatchObject({ state: 'unknown', freshness: 'unknown' })
    expect(read).not.toHaveBeenCalled()
    now += pollInterval - 1
    await reader.get(urls)
    expect(list).toHaveBeenCalledTimes(1)
    now += 1
    list.mockResolvedValue([row(450, now, 'closed', merged.merged_at)])
    read.mockResolvedValue(merged)
    expect((await reader.get(urls)).get(url(450))).toMatchObject({ state: 'merged', freshness: 'fresh', mergeSha: sha })
    expect(list).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('refreshes changed PRs in one list and leaves unchanged and merged PRs off the point-read loop', async () => {
    let now = Date.now()
    const urls = [url(1), url(2), url(3)]
    const read = vi.fn(), list = vi.fn().mockResolvedValue([
      row(1, now, 'closed', merged.merged_at), row(2, now, 'closed'), row(3, now, 'open'),
    ])
    const reader = new ReleasePullReader(read, () => now, list)
    const first = await reader.get(urls)
    expect(first.get(url(1))).toMatchObject({ state: 'merged', mergeSha: sha })
    expect(first.get(url(2))).toMatchObject({ state: 'closed', mergeSha: null })
    now += pollInterval
    const older = Array.from({ length: 99 }, (_, index) => row(index + 4, now - 2 * pollInterval, 'closed'))
    list.mockResolvedValue([row(2, now, 'open'), ...older])
    const refreshed = await reader.get(urls)
    expect(refreshed.get(url(1))).toEqual(first.get(url(1)))
    expect(refreshed.get(url(2))).toMatchObject({ state: 'open', freshness: 'fresh' })
    expect(refreshed.get(url(3))).toMatchObject({ state: 'open', freshness: 'fresh', observedAt: new Date(now).toISOString() })
    expect(list).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledWith('/repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1', expect.any(String))
    expect(read).not.toHaveBeenCalled()
  })

})

it.each(['stack-base', null])('preserves the observed base %s without inferring main', async base => {
  const reader = new ReleasePullReader(vi.fn().mockResolvedValue({ ...merged, head_sha: sha, base_ref: base }))
  expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ head: sha, base })
  expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ head: sha, base })
})

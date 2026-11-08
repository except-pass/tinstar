import { describe, expect, it, vi } from 'vitest'
import { ReleasePullReader } from '../pulls'
const sha = 'a'.repeat(40), url = (number: number) => `https://github.com/owner/repo/pull/${number}`
const merged = { title: 'Real PR', state: 'closed', merged: true, merged_at: '2026-11-06T18:00:00Z', merge_commit_sha: sha }
describe('bounded read-only release PR observations', () => {
  it('uses GitHub effective merge commit, bounds calls, rotates coverage, and reuses stable merged evidence', async () => {
    let now = Date.now()
    const read = vi.fn().mockResolvedValue(merged), reader = new ReleasePullReader(read, () => now)
    const urls = Array.from({ length: 8 }, (_, index) => url(index + 1))
    const first = await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(4)
    expect(first.get(url(1))).toMatchObject({ state: 'merged', mergeSha: sha, freshness: 'fresh' })
    now += 20_000
    const second = await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(8)
    expect(second.size).toBe(8)
    now += 20_000
    await reader.get(urls); expect(read).toHaveBeenCalledTimes(8)
    expect(read.mock.calls.every(call => !String(call[0]).includes('actions'))).toBe(true)
  })
  it('keeps failures and absent merge SHA unknown; retains a stale successful observation', async () => {
    let now = Date.now()
    const read = vi.fn().mockResolvedValue(merged), reader = new ReleasePullReader(read, () => now)
    await reader.get([url(1)])
    now += 601_000; read.mockRejectedValue(new Error('private auth detail'))
    expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ state: 'merged', freshness: 'stale', mergeSha: sha })
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
    now += 61_000; read.mockResolvedValue(merged)
    expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ freshness: 'fresh', state: 'merged' })
    expect((await reader.get([url(1)])).get(url(1))!.readError).toBeUndefined()
    now += 601_000; read.mockRejectedValue(new Error('private access detail'))
    const failed = (await reader.get([url(1)])).get(url(1))!
    expect(failed.freshness).toBe('stale')
    expect(failed.readError).toContain('GitHub read failed')
    expect(JSON.stringify(failed)).not.toContain('private access detail')
  })

})

it.each(['stack-base', null])('preserves the observed base %s without inferring main', async base => {
  const reader = new ReleasePullReader(vi.fn().mockResolvedValue({ ...merged, head_sha: sha, base_ref: base }))
  expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ head: sha, base })
  expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ head: sha, base })
})

import { describe, expect, it, vi } from 'vitest'
import { ReleasePullReader } from '../pulls'
import { GithubResponseError } from '../../pulls/restBudget'
const day = 24 * 60 * 60_000
const pollInterval = 120_000
const sha = 'a'.repeat(40), url = (number: number) => `https://github.com/owner/repo/pull/${number}`
const merged = { title: 'Real PR', state: 'closed', merged: true, merged_at: '2026-11-06T18:00:00Z', merge_commit_sha: sha }
const row = (
  number: number,
  updated: number,
  state: 'open' | 'closed',
  mergedAt: string | null = null,
  mergeSha: string | null = sha,
) => ({
  number, title: `Linked PR ${number}`, state, merged_at: mergedAt, merge_commit_sha: mergeSha, updated_at: new Date(updated).toISOString(),
  head: { sha }, base: { ref: 'main' },
})
const page = (rows: ReturnType<typeof row>[], count = rows.length, oldestUpdatedAt = rows.at(-1)?.updated_at ?? null) => ({
  rows, count, oldestUpdatedAt,
})
describe('bounded read-only release PR observations', () => {
  it('uses GitHub effective merge commit, bounds calls, rotates coverage, and reuses stable merged evidence', async () => {
    let now = Date.now()
    const read = vi.fn().mockResolvedValue(merged), list = vi.fn().mockResolvedValue(page([]))
    const reader = new ReleasePullReader(read, () => now, list)
    const urls = Array.from({ length: 8 }, (_, index) => url(index + 1))
    const first = await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(4)
    expect(first.get(url(1))).toMatchObject({ state: 'merged', mergeSha: sha, freshness: 'fresh' })
    now += 20_000
    await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(4)
    now += pollInterval - 20_000
    const second = await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(8)
    expect(second.size).toBe(8)
    now += 601_000
    await reader.get([])
    await reader.get(urls); expect(read).toHaveBeenCalledTimes(8)
    expect(list).toHaveBeenCalledTimes(2)
    expect(read.mock.calls.every(call => !String(call[0]).includes('actions'))).toBe(true)
  })
  it('shares the exact-read budget with concurrent single-link repositories', async () => {
    let now = Date.now()
    const read = vi.fn().mockResolvedValue(merged)
    const reader = new ReleasePullReader(read, () => now)
    const urls = Array.from({ length: 6 }, (_, index) => `https://github.com/owner/repo-${index}/pull/1`)
    await Promise.all(urls.map(url => reader.get([url])))
    expect(read).toHaveBeenCalledTimes(4)
    now += pollInterval - 1
    expect((await reader.get([urls[4]!])).size).toBe(0)
    now += 1
    expect((await reader.get([urls[4]!])).get(urls[4]!)).toMatchObject({ state: 'merged' })
    expect(read).toHaveBeenCalledTimes(5)
  })

  it.each([
    { exact: merged, listed: 'open', state: 'merged', mergeSha: sha },
    { exact: { ...merged, state: 'open', merged: false }, listed: 'closed', state: 'closed', mergeSha: null },
  ] as const)('keeps $state evidence across an input gap while an older exact read is pending', async ({ exact, listed, state, mergeSha }) => {
    let now = Date.now()
    let finishExact!: () => void, finishList!: () => void, reachedSecondPage!: () => void
    const exactGate = new Promise<void>(resolve => { finishExact = resolve })
    const listGate = new Promise<void>(resolve => { finishList = resolve })
    const secondPage = new Promise<void>(resolve => { reachedSecondPage = resolve })
    const read = vi.fn(async () => { await exactGate; return exact })
    const list = vi.fn()
      .mockImplementationOnce(async () => page([row(1, now, listed)], 100))
      .mockImplementationOnce(async () => { reachedSecondPage(); await listGate; return page([row(2, now, 'open')]) })
    const reader = new ReleasePullReader(read, () => now, list)
    const point = reader.get([url(1)])
    now += 1_000
    const batch = reader.get([url(1), url(2)])
    try {
      await secondPage
      expect((await reader.get([])).size).toBe(0)
      finishExact()
      expect((await point).get(url(1))).toMatchObject({ state, mergeSha, freshness: 'fresh' })
      expect((await reader.get([])).size).toBe(0)
    } finally {
      finishExact()
      finishList()
    }
    expect((await batch).get(url(1))).toMatchObject({ state, mergeSha, freshness: 'fresh' })
    expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ state, mergeSha, freshness: 'fresh' })
  })

  it.each([0, 1_000])('orders later-page rows after an overlapping exact read (elapsed: %s)', async elapsed => {
    let now = Date.now()
    let finishOther!: () => void, finishFirstPage!: () => void
    const otherGate = new Promise<void>(resolve => { finishOther = resolve })
    const firstPageGate = new Promise<void>(resolve => { finishFirstPage = resolve })
    const otherUrl = (number: number) => `https://github.com/owner/other/pull/${number}`
    const read = vi.fn().mockResolvedValue({ ...merged, state: 'open', merged: false })
    const list = vi.fn(async (path: string, _numbers: number[], onStart?: (time: number) => void) => {
      onStart?.(now)
      if (path.includes('/other/')) {
        await otherGate
        return page([row(1, now, 'open'), row(2, now, 'open')])
      }
      if (path.endsWith('&page=1')) {
        await firstPageGate
        return page([row(2, now, 'open')], 100)
      }
      return page([row(1, now, 'closed')])
    })
    const reader = new ReleasePullReader(read, () => now, list)
    const point = reader.get([url(1), otherUrl(1), otherUrl(2)])
    const batch = reader.get([url(1), url(2)])
    now += elapsed
    try {
      finishOther()
      expect((await point).get(url(1))).toMatchObject({ state: 'open', freshness: 'fresh' })
      now += elapsed
    } finally {
      finishOther()
      finishFirstPage()
    }
    expect((await batch).get(url(1))).toMatchObject({
      state: 'closed', freshness: 'fresh', observedAt: new Date(now).toISOString(),
    })
  })

  it.each([
    { exactPending: false, elapsed: 0 }, { exactPending: true, elapsed: 0 },
    { exactPending: false, elapsed: 1_000 }, { exactPending: true, elapsed: 1_000 },
  ])('keeps exact evidence after a page failure (pending: $exactPending, elapsed: $elapsed)', async ({ exactPending, elapsed }) => {
    let now = Date.now()
    let finishOther!: () => void, failPage!: () => void, finishExact!: () => void
    let pageStarted!: () => void, exactStarted!: () => void
    const otherGate = new Promise<void>(resolve => { finishOther = resolve })
    const failedPage = new Promise<void>(resolve => { failPage = resolve })
    const exactGate = new Promise<void>(resolve => { finishExact = resolve })
    const pageInFlight = new Promise<void>(resolve => { pageStarted = resolve })
    const exactInFlight = new Promise<void>(resolve => { exactStarted = resolve })
    const otherUrl = (number: number) => `https://github.com/owner/other/pull/${number}`
    const read = vi.fn(async () => {
      exactStarted()
      await exactGate
      return { ...merged, merged: false }
    })
    const list = vi.fn(async (path: string) => {
      if (path.includes('/other/')) {
        await otherGate
        return page([row(1, now, 'open'), row(2, now, 'open')])
      }
      if (path.endsWith('&page=1')) return page([row(2, now, 'open')], 100)
      pageStarted()
      await failedPage
      throw new Error('HTTP 503')
    })
    const reader = new ReleasePullReader(read, () => now, list)
    const point = reader.get([url(1), otherUrl(1), otherUrl(2)])
    const batch = reader.get([url(1), url(2)])
    try {
      await pageInFlight
      now += elapsed
      finishOther()
      await exactInFlight
      if (exactPending) {
        failPage()
        await new Promise<void>(resolve => setImmediate(resolve))
      } else {
        finishExact()
        await point
      }
    } finally {
      finishOther()
      finishExact()
      failPage()
    }
    for (const observations of [await point, await batch, await reader.get([url(1), url(2)])]) {
      expect(observations.get(url(1))).toMatchObject({ state: 'closed', freshness: 'fresh' })
      expect(observations.get(url(1))?.readError).toBeUndefined()
    }
    expect(read).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('uses a newer mutable row when a linked PR appears on two pages', async () => {
    let now = Date.now()
    const list = vi.fn().mockImplementationOnce(async () => {
      const first = page([row(1, now, 'open')], 100)
      now += 1_000
      return first
    }).mockImplementationOnce(async () => page([row(1, now, 'closed'), row(2, now, 'open')]))
    const read = vi.fn()
    const result = await new ReleasePullReader(read, () => now, list).get([url(1), url(2)])
    expect(result.get(url(1))).toMatchObject({ state: 'closed', freshness: 'fresh', observedAt: new Date(now).toISOString() })
    expect(result.get(url(2))).toMatchObject({ state: 'open', freshness: 'fresh' })
    expect(read).not.toHaveBeenCalled()
  })

  it.each([false, true])('handles overlapping exact failures during pagination (confirmed merge: %s)', async confirmed => {
    let now = Date.now()
    let releaseOther!: () => void, releaseFirst!: () => void, failExact!: () => void, secondStarted!: () => void
    const otherGate = new Promise<void>(resolve => { releaseOther = resolve })
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const exactGate = new Promise<void>(resolve => { failExact = resolve })
    const secondPage = new Promise<void>(resolve => { secondStarted = resolve })
    const otherUrl = (number: number) => `https://github.com/owner/other/pull/${number}`
    const read = vi.fn(async () => { await exactGate; throw new Error('HTTP 503') })
    const list = vi.fn(async (path: string) => {
      if (path.includes('/other/')) {
        await otherGate
        return page([row(1, now, 'open'), row(2, now, 'open')])
      }
      if (path.endsWith('&page=1')) {
        await firstGate
        return page([row(1, now, confirmed ? 'closed' : 'open', confirmed ? merged.merged_at : null)], 100)
      }
      if (path.endsWith('&page=2')) {
        secondStarted()
        await exactGate
        return page([row(2, now, 'open')], 100)
      }
      throw new Error('Page unavailable')
    })
    const reader = new ReleasePullReader(read, () => now, list)
    const exact = reader.get([url(1), otherUrl(1), otherUrl(2)])
    const batch = reader.get([url(1), url(2)])
    try {
      now += 1_000
      releaseOther()
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      releaseFirst()
      await secondPage
      failExact()
      const result = (await exact).get(url(1))
      expect(result).toMatchObject(confirmed ? { state: 'merged', freshness: 'fresh', mergeSha: sha } : { state: 'open', freshness: 'stale' })
    } finally {
      releaseOther()
      releaseFirst()
      failExact()
    }
    const result = (await batch).get(url(1))
    if (confirmed) {
      expect(result).toMatchObject({ state: 'merged', freshness: 'fresh', mergeSha: sha })
      expect(result?.readError).toBeUndefined()
    } else {
      expect(result).toMatchObject({ state: 'open', freshness: 'stale', readError: expect.stringContaining('for owner/repo;') })
    }
    expect(list).toHaveBeenCalledTimes(confirmed ? 3 : 4)
  })

  it('stops after a full page resolves every linked PR', async () => {
    const now = Date.now()
    const list = vi.fn().mockResolvedValue(page([row(1, now, 'open'), row(2, now, 'closed')], 100))
    const read = vi.fn()
    const result = await new ReleasePullReader(read, () => now, list).get([url(1), url(2)])
    expect(result.get(url(1))).toMatchObject({ state: 'open', freshness: 'fresh' })
    expect(result.get(url(2))).toMatchObject({ state: 'closed', freshness: 'fresh' })
    expect(list).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
  })

  it('does not let an older open exact result mask a newer unresolved merge row', async () => {
    let now = Date.now()
    let finishExact!: () => void, finishList!: () => void, reachedSecondPage!: () => void
    const exactGate = new Promise<void>(resolve => { finishExact = resolve })
    const listGate = new Promise<void>(resolve => { finishList = resolve })
    const secondPage = new Promise<void>(resolve => { reachedSecondPage = resolve })
    const read = vi.fn().mockImplementationOnce(async () => {
      await exactGate
      return { ...merged, state: 'open', merged: false }
    }).mockResolvedValue(merged)
    const list = vi.fn()
      .mockImplementationOnce(async () => page([row(1, now, 'closed', merged.merged_at, null)], 100))
      .mockImplementationOnce(async () => { reachedSecondPage(); await listGate; return page([row(2, now, 'open')]) })
    const reader = new ReleasePullReader(read, () => now, list)
    const exact = reader.get([url(1)])
    now += 1_000
    const batch = reader.get([url(1), url(2)])
    try {
      await secondPage
      finishExact()
      expect((await exact).get(url(1))).toMatchObject({ state: 'unknown', freshness: 'unknown' })
    } finally {
      finishExact()
      finishList()
    }
    expect((await batch).get(url(1))).toMatchObject({ state: 'merged', freshness: 'fresh', mergeSha: sha })
  })

  it('uses the shared exact request origin when deciding whether a list cutoff covers it', async () => {
    const origin = Date.now()
    let now = origin + 8_000
    const read = vi.fn().mockImplementationOnce(async (_path, _projection, onStart: (time: number) => void) => {
      onStart(origin)
      return { ...merged, state: 'open', merged: false }
    }).mockResolvedValue(merged)
    const list = vi.fn().mockImplementationOnce(async () =>
      page([row(2, now, 'open')], 100, new Date(origin + 4_000).toISOString())).mockResolvedValue(page([]))
    const reader = new ReleasePullReader(read, () => now, list)
    expect((await reader.get([url(1)])).get(url(1))?.observedAt).toBe(new Date(origin).toISOString())
    now += pollInterval
    expect((await reader.get([url(1), url(2)])).get(url(1))).toMatchObject({ state: 'merged', mergeSha: sha })
  })

  it.each([false, true])('does not renew an exact observation written during the list poll (warm: %s)', async warm => {
    let now = Date.now()
    let finishExact!: () => void, finishList!: () => void
    const exactGate = new Promise<void>(resolve => { finishExact = resolve })
    const listGate = new Promise<void>(resolve => { finishList = resolve })
    const open = { ...merged, state: 'open', merged: false }
    const read = vi.fn(async () => { await exactGate; return open })
    const list = vi.fn(async () => {
      await listGate
      return page([row(2, now, 'open')], 100, cutoff)
    })
    const reader = new ReleasePullReader(read, () => now, list)
    const seededAt = now
    if (warm) {
      read.mockResolvedValueOnce(open)
      await reader.get([url(1)])
      now += pollInterval
    }
    const exactStarted = now
    const cutoff = new Date(warm ? seededAt - 2_000 : exactStarted + 2_000).toISOString()
    const point = reader.get([url(1)])
    now += 5_000
    const batch = reader.get([url(1), url(2)])
    try {
      finishExact()
      await point
    } finally {
      finishList()
    }
    expect((await batch).get(url(1))).toMatchObject({ state: 'open', observedAt: new Date(exactStarted).toISOString() })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('revalidates absent links when a later page reaches the cutoff', async () => {
    let now = Date.now()
    const urls = [url(1), url(2)]
    const read = vi.fn().mockResolvedValue(merged)
    const list = vi.fn().mockResolvedValue(page([row(1, now, 'open'), row(2, now, 'open')]))
    const reader = new ReleasePullReader(read, () => now, list)
    await reader.get(urls)
    now += pollInterval
    list.mockResolvedValueOnce(page([row(2, now, 'open')], 100, new Date(now).toISOString()))
      .mockResolvedValueOnce(page([], 100, new Date(now - 2 * pollInterval).toISOString()))
    const refreshed = await reader.get(urls)
    expect(refreshed.get(url(1))).toMatchObject({ state: 'merged', mergeSha: sha, freshness: 'fresh' })
    expect(read.mock.calls).toEqual([['/repos/owner/repo/pulls/1', expect.any(String), expect.any(Function)]])
  })

  it('preserves fresh rows from successful pages when a later page fails', async () => {
    let now = Date.now()
    const urls = [url(1), url(2)]
    const read = vi.fn()
    const list = vi.fn().mockResolvedValue(page([row(1, now, 'open'), row(2, now, 'open')]))
    const reader = new ReleasePullReader(read, () => now, list)
    await reader.get(urls)
    now += pollInterval
    list.mockResolvedValueOnce(page([row(1, now, 'closed')], 100, new Date(now).toISOString()))
      .mockRejectedValueOnce(new Error('Page unavailable'))
    const [partial, concurrent] = await Promise.all([reader.get(urls), reader.get(urls)])
    expect(partial.get(url(1))).toMatchObject({ state: 'closed', freshness: 'fresh' })
    expect(partial.get(url(1))?.readError).toBeUndefined()
    expect(partial.get(url(2))).toMatchObject({ state: 'open', freshness: 'stale', readError: expect.any(String) })
    expect(concurrent).toEqual(partial)
    expect(await reader.get(urls)).toEqual(partial)
    now += pollInterval
    list.mockResolvedValue(page([row(1, now, 'closed'), row(2, now, 'closed')]))
    expect((await reader.get(urls)).get(url(2))).toMatchObject({ state: 'closed', freshness: 'fresh' })
    expect(read).not.toHaveBeenCalled()
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

  it('uses the exact request start to decide whether page one covers a missing PR', async () => {
    let now = Date.now()
    const started = now
    const read = vi.fn().mockImplementationOnce(async () => {
      now += 8_000
      return { ...merged, state: 'open', merged: false }
    }).mockResolvedValue(merged)
    const list = vi.fn()
    const reader = new ReleasePullReader(read, () => now, list)
    expect((await reader.get([url(1)])).get(url(1))).toMatchObject({
      state: 'open', observedAt: new Date(started).toISOString(),
    })
    now += pollInterval
    list.mockResolvedValueOnce(page([row(2, now, 'open')], 100, new Date(started + 4_000).toISOString()))
      .mockResolvedValueOnce(page([]))
    const result = await reader.get([url(1), url(2)])
    expect(result.get(url(1))).toMatchObject({ state: 'merged', freshness: 'fresh' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('retains the repository poll deadline across an omitted association snapshot', async () => {
    let now = Date.now()
    const urls = [url(1), url(2)]
    const list = vi.fn().mockResolvedValue(page([row(1, now, 'open'), row(2, now, 'open')]))
    const reader = new ReleasePullReader(vi.fn().mockResolvedValue({ ...merged, merged: false }), () => now, list)
    await reader.get(urls)
    now += 20_000
    await reader.get([])
    await reader.get([url(1)])
    await reader.get(urls)
    expect(list).toHaveBeenCalledTimes(1)
    now += pollInterval - 20_000
    await reader.get(urls)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('uses bounded exact recovery after a confirmed list payload failure', async () => {
    let now = Date.now()
    const urls = Array.from({ length: 6 }, (_, index) => url(index + 1))
    const list = vi.fn().mockRejectedValue(new GithubResponseError())
    const read = vi.fn().mockResolvedValue({ ...merged, state: 'open', merged: false })
    const reader = new ReleasePullReader(read, () => now, list)
    const first = await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(4)
    expect(first.get(url(1))).toMatchObject({ state: 'open', freshness: 'fresh' })
    expect(first.get(url(5))).toMatchObject({ state: 'unknown', readError: expect.any(String) })
    expect(await reader.get(urls)).toEqual(first)
    expect(read).toHaveBeenCalledTimes(4)
    now += pollInterval
    expect((await reader.get(urls)).get(url(5))).toMatchObject({ state: 'open', freshness: 'fresh' })
    expect(read).toHaveBeenCalledTimes(8)
  })

  it.each(['GitHub read failed (HTTP 404)', 'GitHub REST rate limited'])(
    'suppresses exact fan-out after %s', async message => {
      let now = Date.now()
      const urls = Array.from({ length: 450 }, (_, index) => url(index + 1))
      const read = vi.fn(), list = vi.fn().mockRejectedValue(new Error(message))
      const reader = new ReleasePullReader(read, () => now, list)
      const [first, concurrent] = await Promise.all([reader.get(urls), reader.get(urls)])
      expect(first.size).toBe(urls.length)
      expect(concurrent).toEqual(first)
      expect(first.get(url(450))).toMatchObject({ state: 'unknown', freshness: 'unknown' })
      expect(read).not.toHaveBeenCalled()
      now += pollInterval - 1
      await reader.get([])
      await reader.get([url(1)])
      await reader.get(urls)
      expect(read).not.toHaveBeenCalled()
      expect(list).toHaveBeenCalledTimes(1)
      now += 1
      list.mockResolvedValue(page([row(450, now, 'closed', merged.merged_at)]))
      read.mockResolvedValue(merged)
      expect((await reader.get(urls)).get(url(450))).toMatchObject({ state: 'merged', freshness: 'fresh', mergeSha: sha })
      expect(list).toHaveBeenCalledTimes(2)
      expect(read).toHaveBeenCalledTimes(4)
    })

  it('uses an exact read when only one linked PR is eligible for a new poll', async () => {
    let now = Date.now()
    const list = vi.fn().mockResolvedValue(page([row(1, now, 'closed', merged.merged_at), row(2, now, 'open')]))
    const read = vi.fn().mockResolvedValue({ ...merged, merged: false })
    const reader = new ReleasePullReader(read, () => now, list)
    const urls = [url(1), url(2)]
    const first = await reader.get(urls)
    now += pollInterval
    const refresh = await reader.get(urls)
    expect(list).toHaveBeenCalledTimes(1)
    expect(read.mock.calls.map(([path]) => path)).toEqual(['/repos/owner/repo/pulls/2'])
    expect(refresh.get(url(1))).toEqual(first.get(url(1)))
    expect(refresh.get(url(2))).toMatchObject({ state: 'closed', freshness: 'fresh' })
  })

  it.each(['success', 'unavailable', 'unreadable', 'all resolved'])(
    'retains page-one renewals when older evidence is %s', async outcome => {
      let now = Date.now()
      const read = vi.fn().mockResolvedValueOnce({ ...merged, state: 'open', merged: false }).mockResolvedValue(merged)
      const list = vi.fn()
      const reader = new ReleasePullReader(read, () => now, list)
      await reader.get([url(1)])
      const older = now
      now += pollInterval / 2
      list.mockResolvedValueOnce(page([row(2, now, 'open'), row(3, now, 'open')]))
      await reader.get([url(1), url(2), url(3)])
      read.mockClear()

      now += pollInterval
      const oldestUpdatedAt = new Date(older + 2_000).toISOString()
      const olderRow = outcome === 'all resolved' ? [row(1, now, 'closed')] : []
      list.mockResolvedValueOnce(page(olderRow, 100, oldestUpdatedAt))
      if (outcome === 'unavailable') list.mockRejectedValueOnce(new Error('HTTP 503'))
      else if (outcome === 'unreadable') list.mockResolvedValueOnce(null)
      else if (outcome === 'success') list.mockResolvedValueOnce(page([]))

      const result = await reader.get([url(1), url(2), url(3)])
      expect(list).toHaveBeenCalledTimes(outcome === 'all resolved' ? 2 : 3)
      if (outcome === 'unavailable') {
        expect(read).not.toHaveBeenCalled()
        expect(result.get(url(1))).toMatchObject({ state: 'open', freshness: 'stale', readError: expect.any(String) })
      } else if (outcome === 'all resolved') {
        expect(read).not.toHaveBeenCalled()
        expect(result.get(url(1))).toMatchObject({ state: 'closed', freshness: 'fresh' })
      } else {
        expect(read.mock.calls.map(([path]) => path)).toEqual(['/repos/owner/repo/pulls/1'])
        expect(result.get(url(1))).toMatchObject({ state: 'merged', freshness: 'fresh' })
      }
      for (const number of [2, 3]) {
        expect(result.get(url(number))).toMatchObject({ state: 'open', freshness: 'fresh', observedAt: new Date(now).toISOString() })
        expect(result.get(url(number))?.readError).toBeUndefined()
      }
    })

  it('keeps all exact-read slots available after renewing an unchanged PR outside page one', async () => {
    let now = Date.now()
    const list = vi.fn().mockResolvedValue(page([row(1, now, 'open'), row(2, now, 'open')]))
    const read = vi.fn().mockResolvedValue(merged)
    const reader = new ReleasePullReader(read, () => now, list)
    await reader.get([url(1), url(2)])

    now += pollInterval
    list.mockResolvedValueOnce(page([row(2, now, 'open')], 100, new Date(now - 2 * pollInterval).toISOString()))
    const unresolved = [3, 4, 5, 6]
    const result = await reader.get([url(1), url(2), ...unresolved.map(url)])

    expect(result.get(url(1))).toMatchObject({ state: 'open', freshness: 'fresh', observedAt: new Date(now).toISOString() })
    expect(read.mock.calls.map(([path]) => path)).toEqual(unresolved.map(number => `/repos/owner/repo/pulls/${number}`))
    for (const number of unresolved) expect(result.get(url(number))).toMatchObject({ state: 'merged', freshness: 'fresh' })
  })

  it('refreshes changed PRs in one list and leaves unchanged and merged PRs off the point-read loop', async () => {
    let now = Date.now()
    const urls = [url(1), url(2), url(3)]
    const read = vi.fn(), list = vi.fn().mockResolvedValue(page([
      row(1, now, 'closed', merged.merged_at), row(2, now, 'closed'), row(3, now, 'open'),
    ]))
    const reader = new ReleasePullReader(read, () => now, list)
    const first = await reader.get(urls)
    expect(first.get(url(1))).toMatchObject({ state: 'merged', mergeSha: sha })
    expect(first.get(url(2))).toMatchObject({ state: 'closed', mergeSha: null })
    now += pollInterval
    list.mockResolvedValue(page([row(2, now, 'open')], 100, new Date(now - 2 * pollInterval).toISOString()))
    const refreshed = await reader.get(urls)
    expect(refreshed.get(url(1))).toEqual(first.get(url(1)))
    expect(refreshed.get(url(2))).toMatchObject({ state: 'open', freshness: 'fresh' })
    expect(refreshed.get(url(3))).toMatchObject({ state: 'open', freshness: 'fresh', observedAt: new Date(now).toISOString() })
    expect(list).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledWith('/repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1', [2, 3], expect.any(Function))
    expect(read).not.toHaveBeenCalled()
  })

})

it.each(['stack-base', null])('preserves the observed base %s without inferring main', async base => {
  const reader = new ReleasePullReader(vi.fn().mockResolvedValue({ ...merged, head_sha: sha, base_ref: base }))
  expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ head: sha, base })
  expect((await reader.get([url(1)])).get(url(1))).toMatchObject({ head: sha, base })
})

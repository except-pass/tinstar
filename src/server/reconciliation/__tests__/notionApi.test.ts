import { afterEach, expect, it, vi } from 'vitest'
import { NotionApi } from '../notionApi'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('starts a foreground read ahead of 50 queued background reads', async () => {
  vi.useFakeTimers()
  const url = 'https://api.notion.com/v1/pages/card'
  const starts: Array<{ input: string; at: number }> = []
  const api = new NotionApi(async input => {
    starts.push({ input: String(input), at: Date.now() })
    if (input === url) await new Promise(resolve => setTimeout(resolve, 200))
    return new Response('{}')
  })
  const priming = api.backgroundFetch('https://api.notion.com/v1/comments')
  const background = Array.from({ length: 50 }, () => api.backgroundFetch('https://api.notion.com/v1/blocks/card/children'))
  const requestedAt = Date.now()
  const foreground = api.fetch(url, undefined, 5_000)
  await vi.advanceTimersByTimeAsync(550)
  expect((await foreground).ok).toBe(true)
  expect(Date.now() - requestedAt).toBeLessThan(1_000)
  expect(starts[1]).toEqual({ input: url, at: requestedAt + 350 })
  await vi.runAllTimersAsync()
  await Promise.all([priming, ...background])
  expect(starts).toHaveLength(52)
})

it('starts the HTTP timeout at send after shared backoff', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('HTTP deadline exceeded', 'TimeoutError')), ms)
    return controller.signal
  })
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '6' } }))
    .mockImplementation((_input, init) => new Promise((_resolve, reject) =>
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })))
  const api = new NotionApi(fetcher)
  await api.backgroundFetch('https://api.notion.com/v1/comments')
  const foreground = api.fetch('https://api.notion.com/v1/pages/card', undefined, 5_000)
  const rejected = expect(foreground).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(5_999)
  expect(timeout).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(timeout).toHaveBeenCalledOnce()
  expect(timeout).toHaveBeenCalledWith(5_000)
  await vi.advanceTimersByTimeAsync(5_000)
  await rejected
  expect(api.diagnostics.requests).toEqual({ 'GET comments': 1, 'GET pages': 1 })
})

it.each(['foreground', 'background'] as const)('rechecks backoff for a sleeping %s request after a delayed history 429', async mode => {
  vi.useFakeTimers()
  let release!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
    .mockResolvedValue(Response.json({ id: 'card' }))
  const api = new NotionApi(fetcher, 350)
  const history = api.backgroundFetch('https://api.notion.com/v1/comments')
  const next = mode === 'foreground' ? api.fetch('https://api.notion.com/v1/pages/card') : api.backgroundFetch('https://api.notion.com/v1/comments')
  await vi.advanceTimersByTimeAsync(100)
  release(new Response('', { status: 429, headers: { 'Retry-After': '3' } }))
  await history
  await vi.advanceTimersByTimeAsync(2999)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect((await next).ok).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('paces property reads without blocking them behind an unfinished background history response', async () => {
  vi.useFakeTimers()
  let release!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
    .mockResolvedValue(Response.json({ id: 'card' }))
  const api = new NotionApi(fetcher, 350)
  const history = api.backgroundFetch('https://api.notion.com/v1/comments')
  const card = api.fetch('https://api.notion.com/v1/pages/card')
  await vi.advanceTimersByTimeAsync(349)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect((await card).ok).toBe(true)
  release(new Response('', { status: 429, headers: { 'Retry-After': '3' } }))
  await history
  const next = api.backgroundFetch('https://api.notion.com/v1/comments')
  await vi.advanceTimersByTimeAsync(2999)
  expect(fetcher).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  await next
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('backs off all queued traffic for Retry-After on a history 429', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '3' } }))
    .mockResolvedValue(Response.json({ results: [] }))
  const api = new NotionApi(fetcher, 350)
  expect((await api.fetch('https://api.notion.com/v1/comments')).status).toBe(429)
  const next = api.fetch('https://api.notion.com/v1/blocks/card/children')
  await vi.advanceTimersByTimeAsync(2999)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect((await next).ok).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(api.diagnostics.rateLimits).toBe(1)
})

it.each(['fetch', 'backgroundFetch'] as const)('expires queued %s reads without bypassing the active request or pacing', async lane => {
  vi.useFakeTimers()
  let release!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
    .mockResolvedValue(new Response('{}'))
  const api = new NotionApi(fetcher, 350)
  const active = api.fetch('https://api.notion.com/v1/comments')
  const expired = expect(api[lane]('https://api.notion.com/v1/pages/expired')).rejects.toThrow('Notion queue deadline exceeded')
  const controller = new AbortController()
  const cancelled = api[lane]('https://api.notion.com/v1/pages/cancelled', { signal: controller.signal })
  let failure: unknown
  void cancelled.catch(error => { failure = error })
  await vi.advanceTimersByTimeAsync(5000)
  const timeout = new DOMException('Timed out', 'TimeoutError')
  controller.abort(timeout)
  await vi.advanceTimersByTimeAsync(0)
  expect(failure).toBe(timeout)
  await vi.advanceTimersByTimeAsync(25_000)
  await expired
  const next = api.fetch('https://api.notion.com/v1/pages/current')
  await vi.advanceTimersByTimeAsync(1000)
  expect(fetcher).toHaveBeenCalledTimes(1)
  release(new Response('{}'))
  await active
  await vi.advanceTimersByTimeAsync(349)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await next
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1]![0]).toBe('https://api.notion.com/v1/pages/current')
})


it.each([35_000, 121_000])('honors a 120-second Desk deadline through %i ms of shared backoff', async backoff => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': String(backoff / 1_000) } }))
    .mockResolvedValue(new Response('{}'))
  const api = new NotionApi(fetcher)
  await api.fetch('https://api.notion.com/v1/pages/other')
  const caller = new AbortController()
  const reason = new DOMException('Desk deadline elapsed', 'TimeoutError')
  const deadline = setTimeout(() => caller.abort(reason), 120_000)
  const renewal = api.backgroundFetch('https://api.notion.com/v1/pages/ready', { signal: caller.signal }, 5_000)
  const result = backoff < 120_000 ? expect(renewal).resolves.toMatchObject({ ok: true }) : expect(renewal).rejects.toBe(reason)
  await vi.advanceTimersByTimeAsync(backoff)
  await result
  expect(fetcher).toHaveBeenCalledTimes(backoff < 120_000 ? 2 : 1)
  clearTimeout(deadline)
})

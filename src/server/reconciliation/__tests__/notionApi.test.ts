import { afterEach, expect, it, vi } from 'vitest'
import { NotionApi } from '../notionApi'

afterEach(() => vi.useRealTimers())

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

it('expires queued reads promptly without letting later requests bypass the active request or pacing', async () => {
  vi.useFakeTimers()
  let release!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
    .mockResolvedValue(new Response('{}'))
  const api = new NotionApi(fetcher, 350)
  const active = api.fetch('https://api.notion.com/v1/comments')
  const controller = new AbortController()
  const cancelled = api.fetch('https://api.notion.com/v1/pages/cancelled', { signal: controller.signal })
  let failure: unknown
  void cancelled.catch(error => { failure = error })
  await vi.advanceTimersByTimeAsync(5000)
  const timeout = new DOMException('Timed out', 'TimeoutError')
  controller.abort(timeout)
  await vi.advanceTimersByTimeAsync(0)
  expect(failure).toBe(timeout)
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

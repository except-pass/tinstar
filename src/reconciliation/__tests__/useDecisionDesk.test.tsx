import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDecisionDesk } from '../useDecisionDesk'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it.each(['history retry', 'configuration lookup'] as const)('refreshes after %s completes without claiming again', async scenario => {
  vi.useFakeTimers()
  sessionStorage.clear()
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  const started = Date.now(), delay = scenario === 'history retry' ? 10_000 : 6000
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('/').pop(), complete = Date.now() - started >= delay
    let data: unknown
    if (path === 'sessions') data = init?.body
      ? { session: { id: 'review' }, review_session_token: 'review-token' }
      : { sessions: [{ id: 'review', expires_at: new Date(Date.now() + 60_000).toISOString() }] }
    else if (path === 'submission-state') data = { submissions: [] }
    else if (path === 'claim') data = { outcome: 'no-prepared-decisions' }
    else if (path === 'policy') data = { version: 0, values: { automatic_replenishment: false } }
    else if (path === 'snapshot') data = {
      counts: { ready: 0, leased: 0, preparing: 0, requests: 1 }, ready: [],
      history: [{ card_id: 'card', state: scenario === 'history retry' && !complete ? 'unavailable' : 'available',
        retry_at: scenario === 'history retry' && !complete ? new Date(started + delay).toISOString() : null }],
      runner: { configured: scenario === 'history retry' || complete, explanation: complete ? 'Configured.' : 'Checking preparer configuration.' },
    }
    else throw new Error(`Unexpected request ${path}`)
    return Response.json({ ok: true, data })
  })
  vi.stubGlobal('fetch', fetcher)
  const { result, unmount } = renderHook(() => useDecisionDesk())
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(result.current.snapshot).not.toBeNull()
  if (scenario === 'history retry') expect(result.current.snapshot?.history?.[0]?.state).toBe('unavailable')
  else expect(result.current.snapshot?.runner.configured).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(delay + 2000) })
  expect(result.current.snapshot?.history?.[0]?.state).toBe('available')
  expect(result.current.snapshot?.runner.configured).toBe(true)
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/claim'))).toHaveLength(1)
  unmount()
  const calls = fetcher.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(fetcher).toHaveBeenCalledTimes(calls)
})

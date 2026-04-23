// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { useCcQuota, __resetCcQuotaSingletonForTests } from '../useCcQuota'

function Probe({ onSnap }: { onSnap: (x: unknown) => void }) {
  const { snapshot, lastRefreshedAt, refresh } = useCcQuota()
  onSnap({ snapshot, lastRefreshedAt, refresh })
  return null
}

describe('useCcQuota', () => {
  beforeEach(() => {
    __resetCcQuotaSingletonForTests()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fetches once on mount and exposes snapshot', async () => {
    const body = { fetchedAt: '2026-04-23T10:00:00Z', data: { five_hour: null, seven_day: null }, error: null }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))

    const states: unknown[] = []
    render(<Probe onSnap={(s) => states.push(s)} />)

    await waitFor(() => expect((states.at(-1) as { snapshot: unknown }).snapshot).not.toBeNull())
    const last = states.at(-1) as { snapshot: typeof body, lastRefreshedAt: string | null }
    expect(last.snapshot).toEqual(body)
    expect(last.lastRefreshedAt).toBe('2026-04-23T10:00:00Z')
  })

  it('re-polls every 5 minutes', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ fetchedAt: '2026', data: null, error: null }), { status: 200 })
    }))

    render(<Probe onSnap={() => {}} />)
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1))
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000) })
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2))
  })

  it('refresh() triggers an additional GET /api/cc-quota call', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ fetchedAt: '2026', data: null, error: null }), { status: 200 })
    }))

    let refresh: (() => void) | null = null
    render(<Probe onSnap={(s) => { refresh = (s as { refresh: () => void }).refresh }} />)
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1))
    const countBefore = calls.length
    act(() => { refresh!() })
    await waitFor(() => expect(calls.length).toBeGreaterThan(countBefore))
    // Refresh uses the same endpoint as polling; no force param anymore since
    // the server just serves the cached push state.
    expect(calls.every(u => u === '/api/cc-quota')).toBe(true)
  })
})

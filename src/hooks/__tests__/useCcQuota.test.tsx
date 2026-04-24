// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { useCcQuota, __resetCcQuotaSingletonForTests } from '../useCcQuota'

function Probe({ onSnap }: { onSnap: (x: unknown) => void }) {
  const { snapshot } = useCcQuota()
  onSnap({ snapshot })
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
    expect((states.at(-1) as { snapshot: typeof body }).snapshot).toEqual(body)
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
})

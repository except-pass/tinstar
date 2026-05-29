// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const apiFetchMock = vi.fn()
vi.mock('../../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiUrl: (p: string) => p,
}))

import { useNatsStatus } from '../useNatsStatus'

function statusResponse(connection: string, subscriptions: string[]) {
  return { ok: true, status: 200, json: async () => ({ ok: true, data: { connection, subscriptions } }) }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue(statusResponse('open', ['x']))
})
afterEach(() => { vi.useRealTimers() })

describe('useNatsStatus', () => {
  it('probes on mount and exposes the observed status', async () => {
    const { result } = renderHook(() => useNatsStatus('s1'))
    await waitFor(() => expect(result.current.status?.connection).toBe('open'))
    expect(apiFetchMock).toHaveBeenCalledWith('/api/sessions/s1/nats-status')
  })

  it('re-probes periodically so an open panel stays fresh', async () => {
    vi.useFakeTimers()
    renderHook(() => useNatsStatus('s1'))
    // initial mount probe
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    const before = apiFetchMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(apiFetchMock.mock.calls.length).toBeGreaterThan(before)
  })

  it('refresh() re-probes on demand', async () => {
    const { result } = renderHook(() => useNatsStatus('s1'))
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    act(() => { result.current.refresh() })
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThan(1))
  })
})

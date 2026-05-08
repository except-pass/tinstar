// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  global.fetch = vi.fn() as unknown as typeof fetch
})
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('useBackendReachable', () => {
  it('reports reachable=true when fetch succeeds', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({ ok: true, status: 200 })
    const { useBackendReachable } = await import('../../src/hooks/useBackendReachable')
    const { result } = renderHook(() => useBackendReachable())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('reports reachable=false when fetch rejects', async () => {
    ;(global.fetch as any).mockRejectedValue(new Error('econnrefused'))
    const { useBackendReachable } = await import('../../src/hooks/useBackendReachable')
    const { result } = renderHook(() => useBackendReachable())
    await waitFor(() => expect(result.current).toBe(false))
  })
})

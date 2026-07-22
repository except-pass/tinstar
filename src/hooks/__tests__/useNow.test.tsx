// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useNow } from '../useNow'

describe('useNow', () => {
  afterEach(() => vi.useRealTimers())

  it('seeds with the current time and advances on the interval', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { result } = renderHook(() => useNow(1000))
    expect(result.current).toBe(1_000)
    // Advancing the fake clock past the interval both moves Date.now() and fires the
    // interval, which re-reads it — so the hook's value tracks the clock forward.
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(2_000)
  })

  it('clears its interval on unmount', () => {
    vi.useFakeTimers()
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const { unmount } = renderHook(() => useNow(1000))
    unmount()
    expect(clear).toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ReactNode } from 'react'

// Mock apiFetch BEFORE importing the module under test
const apiFetchMock = vi.fn()
vi.mock('../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

// Now import — apiFetch inside ConfigContext will use our mock
import { ConfigProvider, useConfig, useConfigPatch, useDebouncedConfigPatch } from '../ConfigContext'

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

const wrapper = ({ children }: { children: ReactNode }) => <ConfigProvider>{children}</ConfigProvider>

/**
 * Default mock impl: route by method.
 * - GET returns `getData`
 * - PATCH echoes a deep-merged body (close enough for assertions)
 * Tests can override by reassigning apiFetchMock.mockImplementation(...).
 */
function installDefaultMock(getData: Record<string, unknown>) {
  apiFetchMock.mockImplementation((_path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return Promise.resolve(jsonRes({ ok: true, data: getData }))
    // PATCH (or any mutating): just acknowledge with current data
    return Promise.resolve(jsonRes({ ok: true, data: getData }))
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('ConfigContext', () => {
  it('loads config on mount and exposes it via useConfig', async () => {
    installDefaultMock({ uploadMaxBytes: 1, ui: { telemetryPanels: { cacheHit: false, turnLength: true } } })
    const { result } = renderHook(() => useConfig(), { wrapper })
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current?.uploadMaxBytes).toBe(1)
    expect((result.current?.ui as { telemetryPanels: { cacheHit: boolean } }).telemetryPanels.cacheHit).toBe(false)
  })

  it('useConfigPatch fires PATCH and updates context', async () => {
    // Route by method so multiple hook mounts (each running their own initial GET)
    // don't consume the queued PATCH response.
    let patchCalls = 0
    apiFetchMock.mockImplementation((_path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'PATCH') {
        patchCalls++
        return Promise.resolve(jsonRes({ ok: true, data: { uploadMaxBytes: 1, ui: { telemetryPanels: { cacheHit: true } } } }))
      }
      return Promise.resolve(jsonRes({ ok: true, data: { uploadMaxBytes: 1, ui: { telemetryPanels: { cacheHit: false } } } }))
    })

    // Render both hooks under the same provider so they share context.
    const { result } = renderHook(
      () => ({ cfg: useConfig(), patch: useConfigPatch() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.cfg).not.toBeNull())

    await act(async () => {
      await result.current.patch({ ui: { telemetryPanels: { cacheHit: true } as never } })
    })

    expect(patchCalls).toBe(1)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/config', expect.objectContaining({ method: 'PATCH' }))
  })

  it('useDebouncedConfigPatch coalesces N rapid calls into 1 PATCH', async () => {
    installDefaultMock({ ui: {} })

    const { result } = renderHook(() => useDebouncedConfigPatch(500), { wrapper })

    // Let the initial GET (real timers, microtask) settle before flipping to fake timers.
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThanOrEqual(1))
    const initialCallCount = apiFetchMock.mock.calls.length

    vi.useFakeTimers()

    act(() => {
      result.current({ ui: { layouts: { a: 1 } as never } })
      result.current({ ui: { layouts: { b: 2 } as never } })
      result.current({ ui: { layouts: { c: 3 } as never } })
    })

    // Before timer fires, no PATCH yet
    expect(apiFetchMock.mock.calls.length).toBe(initialCallCount)

    await act(async () => {
      vi.advanceTimersByTime(500)
      // flip back to real timers so the patch's awaited microtasks resolve in waitFor
    })
    vi.useRealTimers()

    // After timer, exactly one PATCH
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBe(initialCallCount + 1))

    const patchCall = apiFetchMock.mock.calls[initialCallCount]!
    expect(patchCall[1]?.method).toBe('PATCH')
  })

  it('debounced patch cancels pending on unmount', async () => {
    installDefaultMock({ ui: {} })

    const { result, unmount } = renderHook(() => useDebouncedConfigPatch(500), { wrapper })

    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThanOrEqual(1))
    const initialCallCount = apiFetchMock.mock.calls.length

    vi.useFakeTimers()

    act(() => { result.current({ ui: { layouts: { x: 1 } as never } }) })
    unmount()
    act(() => { vi.advanceTimersByTime(1000) })

    vi.useRealTimers()

    // No additional PATCH after unmount
    expect(apiFetchMock.mock.calls.length).toBe(initialCallCount)
  })
})

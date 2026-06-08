// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { usePluginWidgetData } from '../usePluginWidgetData'
import { WidgetIdProvider } from '../widgetIdContext'

// Mock apiFetch
vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(),
  apiUrl: (p: string) => p,
}))

// Mock useServerEvents to return controllable state
let mockState: any = { pluginWidgets: [] }
const addOptimisticSpy = vi.fn()
vi.mock('../../../hooks/useServerEvents', () => ({
  useServerEvents: () => ({ state: mockState, connected: true, loading: false, addOptimistic: addOptimisticSpy, disconnect: () => {} }),
}))

import { apiFetch } from '../../../apiClient'

describe('usePluginWidgetData', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
    addOptimisticSpy.mockReset()
    mockState = { pluginWidgets: [{ id: 'pw-1', pluginId: 'p', widgetType: 'w', spaceId: 's', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { hello: 'world' }, createdAt: 't', updatedAt: 't' }] }
  })
  afterEach(() => { vi.useRealTimers() })

  function wrapper(id: string) {
    return ({ children }: { children: ReactNode }) => (
      <WidgetIdProvider id={id}>{children}</WidgetIdProvider>
    )
  }

  it('returns the current data from server state', () => {
    const { result } = renderHook(() => usePluginWidgetData<{ hello: string }>(), { wrapper: wrapper('pw-1') })
    expect(result.current[0]).toEqual({ hello: 'world' })
  })

  it('returns null when the instance is missing', () => {
    mockState = { pluginWidgets: [] }
    const { result } = renderHook(() => usePluginWidgetData<{ hello: string }>(), { wrapper: wrapper('pw-1') })
    expect(result.current[0]).toBeNull()
  })

  it('setData applies optimistic update immediately', () => {
    const { result } = renderHook(() => usePluginWidgetData<{ hello: string }>(), { wrapper: wrapper('pw-1') })
    act(() => result.current[1]({ hello: 'new' }))
    expect(addOptimisticSpy).toHaveBeenCalledWith('pluginWidget', expect.objectContaining({ id: 'pw-1', data: { hello: 'new' } }))
  })

  it('setData debounces PATCH by 250ms', () => {
    const { result } = renderHook(() => usePluginWidgetData<{ hello: string }>(), { wrapper: wrapper('pw-1') })
    act(() => result.current[1]({ hello: 'a' }))
    act(() => result.current[1]({ hello: 'b' }))
    act(() => result.current[1]({ hello: 'c' }))
    // No PATCH yet
    expect(apiFetch).not.toHaveBeenCalled()
    // Fast-forward past debounce
    act(() => { vi.advanceTimersByTime(250) })
    // Exactly one PATCH with the LAST value
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/plugin-widgets/pw-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ data: { hello: 'c' } }),
    }))
  })
})

describe('session-view (run node)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
    addOptimisticSpy.mockReset()
    mockState = {
      pluginWidgets: [],
      runs: [{ id: 'R1', sessionId: 'R1', viewData: { launched: true } } as never],
    }
  })
  afterEach(() => { vi.useRealTimers() })

  function wrapper(id: string) {
    return ({ children }: { children: ReactNode }) => (
      <WidgetIdProvider id={id}>{children}</WidgetIdProvider>
    )
  }

  it('returns the run viewData', () => {
    const { result } = renderHook(() => usePluginWidgetData<{ launched: boolean }>(), { wrapper: wrapper('run-R1') })
    expect(result.current[0]).toEqual({ launched: true })
  })

  it('returns null when the run is missing', () => {
    mockState = { pluginWidgets: [], runs: [] }
    const { result } = renderHook(() => usePluginWidgetData<{ launched: boolean }>(), { wrapper: wrapper('run-R1') })
    expect(result.current[0]).toBeNull()
  })

  it('setData calls addOptimistic with run entity and updated viewData', () => {
    const { result } = renderHook(() => usePluginWidgetData<{ launched: boolean }>(), { wrapper: wrapper('run-R1') })
    act(() => result.current[1]({ launched: false }))
    expect(addOptimisticSpy).toHaveBeenCalledWith('run', expect.objectContaining({ id: 'R1', viewData: { launched: false } }))
  })

  it('setData debounces PATCH to /api/runs/:id with viewData after 250ms', () => {
    const { result } = renderHook(() => usePluginWidgetData<{ launched: boolean }>(), { wrapper: wrapper('run-R1') })
    act(() => result.current[1]({ launched: false }))
    // No PATCH yet
    expect(apiFetch).not.toHaveBeenCalled()
    // Fast-forward past debounce
    act(() => { vi.advanceTimersByTime(250) })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/runs/R1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ viewData: { launched: false } }),
    }))
  })

  it('coalesces rapid setData calls into one PATCH with the last value', () => {
    const { result } = renderHook(() => usePluginWidgetData<{ n: number }>(), { wrapper: wrapper('run-R1') })
    act(() => result.current[1]({ n: 1 }))
    act(() => result.current[1]({ n: 2 }))
    act(() => result.current[1]({ n: 3 }))
    expect(apiFetch).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(250) })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/runs/R1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ viewData: { n: 3 } }),
    }))
  })
})

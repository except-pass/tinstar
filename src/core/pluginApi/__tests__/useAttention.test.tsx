// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useAttention } from '../useAttention'
import { WidgetIdProvider } from '../widgetIdContext'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(),
  apiUrl: (p: string) => p,
}))

let mockState: any = { pluginWidgets: [] }
const addOptimisticSpy = vi.fn()
vi.mock('../../../hooks/useServerEvents', () => ({
  useServerEvents: () => ({ state: mockState, connected: true, loading: false, addOptimistic: addOptimisticSpy, disconnect: () => {} }),
}))

import { apiFetch } from '../../../apiClient'

const baseInstance = {
  id: 'pw-1', pluginId: 'p', widgetType: 'w', spaceId: 's',
  position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
  data: null, createdAt: 't', updatedAt: 't',
}

describe('useAttention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
    addOptimisticSpy.mockReset()
    mockState = { pluginWidgets: [baseInstance] }
  })
  afterEach(() => { vi.useRealTimers() })

  function wrapper(id: string) {
    return ({ children }: { children: ReactNode }) => (
      <WidgetIdProvider id={id}>{children}</WidgetIdProvider>
    )
  }

  it('returns null when attention is not set', () => {
    const { result } = renderHook(() => useAttention(), { wrapper: wrapper('pw-1') })
    expect(result.current[0]).toBeNull()
  })

  it('returns current attention from server state', () => {
    mockState = { pluginWidgets: [{ ...baseInstance, attention: { level: 'urgent', reason: 'r', setAt: '2026-05-27T00:00:00.000Z' } }] }
    const { result } = renderHook(() => useAttention(), { wrapper: wrapper('pw-1') })
    expect(result.current[0]?.level).toBe('urgent')
  })

  it('setAttention applies optimistic update', () => {
    const { result } = renderHook(() => useAttention(), { wrapper: wrapper('pw-1') })
    act(() => result.current[1]({ level: 'urgent', reason: 'Build failed' }))
    expect(addOptimisticSpy).toHaveBeenCalledWith('pluginWidget', expect.objectContaining({
      id: 'pw-1',
      attention: expect.objectContaining({ level: 'urgent', reason: 'Build failed' }),
    }))
  })

  it('setAttention debounces PATCH by 250ms', () => {
    const { result } = renderHook(() => useAttention(), { wrapper: wrapper('pw-1') })
    act(() => result.current[1]({ level: 'urgent', reason: 'a' }))
    act(() => result.current[1]({ level: 'attention', reason: 'b' }))
    expect(apiFetch).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(250) })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith('/api/plugin-widgets/pw-1', expect.objectContaining({
      method: 'PATCH',
      body: expect.stringContaining('"level":"attention"'),
    }))
  })

  it('setAttention(null) PATCHes attention: null', () => {
    const { result } = renderHook(() => useAttention(), { wrapper: wrapper('pw-1') })
    act(() => result.current[1](null))
    act(() => { vi.advanceTimersByTime(250) })
    expect(apiFetch).toHaveBeenCalledWith('/api/plugin-widgets/pw-1', expect.objectContaining({
      body: '{"attention":null}',
    }))
  })
})

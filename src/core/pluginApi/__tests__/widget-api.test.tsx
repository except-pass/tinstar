// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useDeletePluginWidget } from '../useDeletePluginWidget'
import { useInitialContext } from '../useInitialContext'
import { WidgetIdProvider } from '../widgetIdContext'

vi.mock('../../../apiClient', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../../../apiClient'

function wrapper(id: string) {
  return ({ children }: { children: ReactNode }) => (
    <WidgetIdProvider id={id}>{children}</WidgetIdProvider>
  )
}

describe('useDeletePluginWidget', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
  })

  it('issues DELETE /api/plugin-widgets/:id when called', async () => {
    const { result } = renderHook(() => useDeletePluginWidget(), { wrapper: wrapper('pw-42') })
    await act(async () => {
      await result.current()
    })
    expect(apiFetch).toHaveBeenCalledWith('/api/plugin-widgets/pw-42', expect.objectContaining({ method: 'DELETE' }))
  })

  it('throws on non-OK response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 500 }))
    const { result } = renderHook(() => useDeletePluginWidget(), { wrapper: wrapper('pw-42') })
    await expect(result.current()).rejects.toThrow(/500/)
  })
})

describe('useInitialContext', () => {
  it('returns null in V5.1 (palette-only spawns)', () => {
    const { result } = renderHook(() => useInitialContext<{ sessionId?: string }>(), { wrapper: wrapper('pw-42') })
    expect(result.current).toBeNull()
  })
})

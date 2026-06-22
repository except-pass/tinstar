import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const apiFetchMock = vi.fn()
vi.mock('../../apiClient', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }))

import { usePluginServerStatus } from '../usePluginServerStatus'

const jsonRes = (data: unknown) => ({ json: async () => ({ ok: true, data }) }) as Response

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); apiFetchMock.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('usePluginServerStatus', () => {
  it('fetches status on mount and exposes it keyed by pluginId', async () => {
    apiFetchMock.mockResolvedValue(jsonRes({ who: { status: 'down', startable: true, checkedAt: 1 } }))
    const { result } = renderHook(() => usePluginServerStatus())
    await waitFor(() => expect(result.current.statuses.who?.status).toBe('down'))
    expect(apiFetchMock).toHaveBeenCalledWith('/api/plugin-servers/status')
  })

  it('start() POSTs the start route and triggers a refetch', async () => {
    apiFetchMock.mockResolvedValue(jsonRes({ who: { status: 'down', startable: true, checkedAt: 1 } }))
    const { result } = renderHook(() => usePluginServerStatus())
    await waitFor(() => expect(result.current.statuses.who).toBeDefined())
    apiFetchMock.mockClear()
    apiFetchMock.mockResolvedValue(jsonRes({ who: { status: 'up', startable: true, checkedAt: 2 } }))
    await act(async () => { await result.current.start('who') })
    expect(apiFetchMock).toHaveBeenCalledWith('/api/plugin-servers/who/start', { method: 'POST' })
  })
})

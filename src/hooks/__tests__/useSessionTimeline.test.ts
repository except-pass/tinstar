import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSessionTimeline } from '../useSessionTimeline'
import { DEFAULT_WINDOW_SEC } from '../../server/sessions/timeline/types'

vi.mock('../../apiClient', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../../apiClient'

const payload = {
  ok: true,
  data: { t0: 0, t1: 100, bands: [], marks: [], turns: [], partial: false, windowSec: 3600 },
}

const respond = (body: unknown): Response =>
  ({ ok: true, json: async () => body } as unknown as Response)

beforeEach(() => {
  vi.mocked(apiFetch).mockResolvedValue(respond(payload))
})
afterEach(() => { vi.clearAllMocks() })

describe('useSessionTimeline', () => {
  it('requests the default window when none is given (R9a)', async () => {
    renderHook(() => useSessionTimeline('s'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(String(vi.mocked(apiFetch).mock.calls[0]![0])).toContain(`windowSec=${DEFAULT_WINDOW_SEC}`)
  })

  it('requests an explicit window when given one', async () => {
    renderHook(() => useSessionTimeline('s', 900))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(String(vi.mocked(apiFetch).mock.calls[0]![0])).toContain('windowSec=900')
  })

  it('encodes the session name into the path', async () => {
    renderHook(() => useSessionTimeline('a/b'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(String(vi.mocked(apiFetch).mock.calls[0]![0])).toContain('/api/sessions/a%2Fb/timeline')
  })

  it('exposes null without throwing when the session has no transcript (R18)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(respond({ ok: true, data: null }))
    const { result } = renderHook(() => useSessionTimeline('marshal'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.timeline).toBeNull()
  })

  it('keeps the last good reconstruction when a poll throws', async () => {
    const { result } = renderHook(() => useSessionTimeline('s', undefined, { intervalMs: 20 }))
    await waitFor(() => expect(result.current.timeline).not.toBeNull())
    vi.mocked(apiFetch).mockRejectedValue(new Error('network'))
    await new Promise(r => setTimeout(r, 60))
    expect(result.current.timeline).not.toBeNull()
  })

  it('stops polling after unmount', async () => {
    const { unmount } = renderHook(() => useSessionTimeline('s', undefined, { intervalMs: 20 }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    unmount()
    const seen = vi.mocked(apiFetch).mock.calls.length
    await new Promise(r => setTimeout(r, 80))
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(seen)
  })

  it('does not fetch without a session name', async () => {
    const { result } = renderHook(() => useSessionTimeline(null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSaloonStream } from '../useSaloonStream'

function fireTraffic(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('tinstar:nats_traffic', { detail }))
}

describe('useSaloonStream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('captures events whose subject matches one of the subscriptions', async () => {
    const { result } = renderHook(() =>
      useSaloonStream({ subscriptions: ['tinstar.a.b.c'] }),
    )
    act(() => {
      fireTraffic({ timestamp: '2026-04-24T12:00:00Z', subject: 'tinstar.a.b.c', data: 'hi', direction: 'inbound' })
      fireTraffic({ timestamp: '2026-04-24T12:00:01Z', subject: 'tinstar.other',  data: 'no', direction: 'inbound' })
    })
    // Flush rAF batch
    await act(async () => { vi.runAllTimers() })
    expect(result.current).toHaveLength(1)
    expect(result.current[0].subject).toBe('tinstar.a.b.c')
  })

  it('caps event retention at 200 (FIFO)', async () => {
    const { result } = renderHook(() =>
      useSaloonStream({ subscriptions: ['tinstar.x'] }),
    )
    act(() => {
      for (let i = 0; i < 250; i++) {
        fireTraffic({ timestamp: `t${i}`, subject: 'tinstar.x', data: `m${i}`, direction: 'inbound' })
      }
    })
    await act(async () => { vi.runAllTimers() })
    expect(result.current).toHaveLength(200)
    expect(result.current[0].data).toBe('m50')      // first 50 dropped
    expect(result.current[199].data).toBe('m249')
  })

  it('captures events whose subject matches a wildcard subscription', async () => {
    const { result } = renderHook(() =>
      useSaloonStream({ subscriptions: ['tinstar.myspace.>'] }),
    )
    act(() => {
      fireTraffic({ timestamp: 't', subject: 'tinstar.myspace.init.epic.task.sess', data: 'yes', direction: 'inbound' })
      fireTraffic({ timestamp: 't2', subject: 'tinstar.elsewhere.foo', data: 'no', direction: 'inbound' })
    })
    await act(async () => { vi.runAllTimers() })
    expect(result.current).toHaveLength(1)
    expect(result.current[0].data).toBe('yes')
  })

  it('reacts to subscription list changes', async () => {
    const { result, rerender } = renderHook(
      ({ subs }: { subs: string[] }) => useSaloonStream({ subscriptions: subs }),
      { initialProps: { subs: ['tinstar.a'] } },
    )
    act(() => {
      fireTraffic({ timestamp: 't', subject: 'tinstar.b', data: 'bbb', direction: 'inbound' })
    })
    await act(async () => { vi.runAllTimers() })
    expect(result.current).toHaveLength(0)

    rerender({ subs: ['tinstar.a', 'tinstar.b'] })
    act(() => {
      fireTraffic({ timestamp: 't2', subject: 'tinstar.b', data: 'yes', direction: 'inbound' })
    })
    await act(async () => { vi.runAllTimers() })
    expect(result.current).toHaveLength(1)
    expect(result.current[0].data).toBe('yes')
  })
})

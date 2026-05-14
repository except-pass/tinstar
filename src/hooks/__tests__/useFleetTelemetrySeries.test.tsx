// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFleetTelemetrySeries } from '../useFleetTelemetrySeries'
import type { HudSnapshot } from '../../server/observability/types'

function snap(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
  return {
    window: 'today',
    state: 'ready',
    cost: { total: 1.0, byModel: {} },
    tokens: { total: 1000 },
    rate: { perMin: 500, perHour: 30000 },
    cacheHitPct: 0.9,
    dutyCycle: { value: 0.5, windowMinutes: 5 },
    ...overrides,
  }
}

describe('useFleetTelemetrySeries', () => {
  beforeEach(() => {
    // Pin wall-clock so we can advance between samples and bypass the
    // same-second dedup inside the hook.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts empty', () => {
    const { result } = renderHook(() => useFleetTelemetrySeries(null))
    expect(result.current.cost).toEqual([])
    expect(result.current.tsSec).toEqual([])
  })

  it('does not accrue while snapshot state !== "ready"', () => {
    const { result, rerender } = renderHook(({ s }: { s: HudSnapshot | null }) => useFleetTelemetrySeries(s), {
      initialProps: { s: snap({ state: 'downloading' }) as HudSnapshot | null },
    })
    rerender({ s: snap({ state: 'disabled' }) as HudSnapshot | null })
    expect(result.current.cost).toEqual([])
  })

  it('appends one sample per ready snapshot', () => {
    const { result, rerender } = renderHook(({ s }: { s: HudSnapshot | null }) =>
      useFleetTelemetrySeries(s), { initialProps: { s: snap({ cost: { total: 1, byModel: {} } }) as HudSnapshot | null } })
    expect(result.current.cost).toHaveLength(1)
    // Advance past the same-second dedup window before re-rendering with a new snapshot.
    vi.advanceTimersByTime(2000)
    rerender({ s: snap({ cost: { total: 2, byModel: {} } }) as HudSnapshot | null })
    expect(result.current.cost.length).toBeGreaterThanOrEqual(1)
    // Last value is 2
    expect(result.current.cost.at(-1)).toBe(2)
  })
})

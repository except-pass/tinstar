import { describe, it, expect } from 'vitest'
import type { ObservabilityState, HudSnapshot } from '../types'

describe('observability types', () => {
  it('ObservabilityState enumerates expected states', () => {
    const states: ObservabilityState[] = ['idle', 'downloading', 'starting', 'ready', 'degraded', 'download-failed', 'disabled']
    expect(states).toHaveLength(7)
  })

  it('HudSnapshot includes required fields', () => {
    const snap: HudSnapshot = {
      window: 'today',
      state: 'ready',
      cost: { total: 0, byModel: {} },
      tokens: { total: 0 },
      rate: { perMin: 0, perHour: 0 },
      cacheHitPct: 0,
      dutyCycle: { value: 0, windowMinutes: 5 },
    }
    expect(snap.state).toBe('ready')
  })
})

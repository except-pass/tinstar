import { describe, it, expect } from 'vitest'
import { makeFakeSeries } from '../fast-sim'

describe('makeFakeSeries', () => {
  it('returns 4 series of (windowSec / stepSec) samples', () => {
    const out = makeFakeSeries({ endSec: 1000, windowSec: 60, stepSec: 5 })
    // 60/5 + 1 = 13 samples spanning [940, 1000]
    expect(out.series.cost).toHaveLength(13)
    expect(out.series.tokens).toHaveLength(13)
    expect(out.series.cache).toHaveLength(13)
    expect(out.series.duty).toHaveLength(13)
    expect(out.series.cost[0]![0]).toBe(940)
    expect(out.series.cost[12]![0]).toBe(1000)
    expect(out.stepSec).toBe(5)
  })

  it('cost is monotonically non-decreasing', () => {
    const out = makeFakeSeries({ endSec: 1000, windowSec: 300, stepSec: 5 })
    const values = out.series.cost.map(p => p[1] as number)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i-1]!)
    }
  })

  it('cache and duty are within [0, 1]', () => {
    const out = makeFakeSeries({ endSec: 1000, windowSec: 300, stepSec: 5 })
    for (const [, v] of out.series.cache) {
      if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
    }
    for (const [, v] of out.series.duty) {
      if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
    }
  })
})

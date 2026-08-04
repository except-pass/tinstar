import { describe, expect, it } from 'vitest'
import { providerSessionTokenTotal } from './provider-capabilities'

describe('providerSessionTokenTotal', () => {
  it('falls back to latest-turn input/output when cumulative has only cache counters', () => {
    expect(providerSessionTokenTotal({
      cumulativeTokens: { cacheRead: 500 },
      latestTurnTokens: { input: 7, output: 3 },
    })).toBe(10)
  })

  it('prefers a derivable cumulative total over the latest turn', () => {
    expect(providerSessionTokenTotal({
      cumulativeTokens: { input: 70, output: 30 },
      latestTurnTokens: { total: 10 },
    })).toBe(100)
  })
})

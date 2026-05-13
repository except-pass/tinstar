import { describe, it, expect } from 'vitest'
import { computeDeltaChip } from '../computeDeltaChip'

describe('computeDeltaChip', () => {
  it('returns null when series is empty', () => {
    expect(computeDeltaChip('cost', [])).toBeNull()
    expect(computeDeltaChip('tokens', [])).toBeNull()
  })

  it('returns null until ~60s of history has accrued (need 12 samples at 5s)', () => {
    const series = Array.from({ length: 5 }, (_, i) => [i * 5, 1] as [number, number])
    expect(computeDeltaChip('tokens', series)).toBeNull()
  })

  it('cost: rate under $1/min renders as cents/min, neutral tone', () => {
    // 13 samples at 5s steps spanning 60s. Cost rises $0.10 → $0.22 → rate = $0.12/min.
    const series: [number, number][] = Array.from({ length: 13 }, (_, i) => [i * 5, 0.10 + i * 0.01])
    const chip = computeDeltaChip('cost', series)
    expect(chip).not.toBeNull()
    expect(chip!.tone).toBe('flat')
    expect(chip!.text).toBe('+12¢/min')
  })

  it('cost: rate at or above $1/min renders as $X.XX/min', () => {
    // Cost rises $0.00 → $1.20 over 60s → rate = $1.20/min.
    const series: [number, number][] = Array.from({ length: 13 }, (_, i) => [i * 5, i * 0.10])
    const chip = computeDeltaChip('cost', series)
    expect(chip).not.toBeNull()
    expect(chip!.tone).toBe('flat')
    expect(chip!.text).toBe('+$1.20/min')
  })

  it('tokens: positive rate-of-change vs 1-min mean → up/green', () => {
    // Mean over last 12 samples ≈ 1000; latest = 1500 → +500 vs mean.
    const series: [number, number][] = [
      ...Array.from({ length: 11 }, (_, i) => [i * 5, 1000] as [number, number]),
      [55, 1000], [60, 1500],
    ]
    const chip = computeDeltaChip('tokens', series)
    expect(chip!.tone).toBe('up')
    expect(chip!.text).toMatch(/^\+/)
    expect(chip!.text).toMatch(/k$/)
  })

  it('cache: drop vs 1-min mean → down/red, in pp', () => {
    const series: [number, number][] = [
      ...Array.from({ length: 11 }, (_, i) => [i * 5, 0.95] as [number, number]),
      [55, 0.95], [60, 0.85],
    ]
    const chip = computeDeltaChip('cache', series)
    expect(chip!.tone).toBe('dn')
    expect(chip!.text).toMatch(/^−/)
    expect(chip!.text).toMatch(/pp$/)
  })

  it('duty: tiny change → flat tone', () => {
    const series: [number, number][] = Array.from({ length: 13 }, (_, i) => [i * 5, 0.5 + (i === 12 ? 0.001 : 0)])
    const chip = computeDeltaChip('duty', series)
    expect(chip!.tone).toBe('flat')
  })

  it('skips null samples when computing the mean', () => {
    const series: [number, number | null][] = [
      ...Array.from({ length: 11 }, (_, i) => [i * 5, null] as [number, null]),
      [55, 1000], [60, 1100],
    ]
    const chip = computeDeltaChip('tokens', series)
    expect(chip).not.toBeNull()
  })
})

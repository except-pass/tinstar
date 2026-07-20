import { describe, it, expect } from 'vitest'
import { relativeAge, isStale, STALE_AFTER_MS } from '../age'

const NOW = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('relativeAge', () => {
  it('reads "just now" under a minute', () => {
    expect(relativeAge(NOW, NOW)).toBe('just now')
    expect(relativeAge(NOW - 59_000, NOW)).toBe('just now')
  })

  it('counts minutes, hours, days, weeks, and years, each rounded down', () => {
    expect(relativeAge(NOW - MIN, NOW)).toBe('1m ago')
    expect(relativeAge(NOW - 59 * MIN, NOW)).toBe('59m ago')
    expect(relativeAge(NOW - HOUR, NOW)).toBe('1h ago')
    expect(relativeAge(NOW - 23 * HOUR, NOW)).toBe('23h ago')
    expect(relativeAge(NOW - DAY, NOW)).toBe('1d ago')
    expect(relativeAge(NOW - 3 * DAY - 5 * HOUR, NOW)).toBe('3d ago')
    expect(relativeAge(NOW - 6 * DAY, NOW)).toBe('6d ago')
    expect(relativeAge(NOW - 7 * DAY, NOW)).toBe('1w ago')
    expect(relativeAge(NOW - 40 * DAY, NOW)).toBe('5w ago')
    expect(relativeAge(NOW - 400 * DAY, NOW)).toBe('1y ago')
  })

  it('crosses each boundary exactly at the boundary, not before', () => {
    expect(relativeAge(NOW - (HOUR - 1), NOW)).toBe('59m ago')
    expect(relativeAge(NOW - HOUR, NOW)).toBe('1h ago')
    expect(relativeAge(NOW - (DAY - 1), NOW)).toBe('23h ago')
    expect(relativeAge(NOW - DAY, NOW)).toBe('1d ago')
  })

  it('reads a future timestamp as "just now" rather than a negative age (clock skew)', () => {
    expect(relativeAge(NOW + 10 * MIN, NOW)).toBe('just now')
  })

  it('returns an empty string for a non-finite timestamp instead of "NaNd ago"', () => {
    expect(relativeAge(Number.NaN, NOW)).toBe('')
    expect(relativeAge(Number.POSITIVE_INFINITY, NOW)).toBe('')
    expect(relativeAge(NOW, Number.NaN)).toBe('')
  })
})

describe('isStale', () => {
  it('is false below the threshold and true at or past it', () => {
    expect(isStale(NOW - 23 * HOUR, NOW)).toBe(false)
    expect(isStale(NOW - STALE_AFTER_MS + 1, NOW)).toBe(false)
    expect(isStale(NOW - STALE_AFTER_MS, NOW)).toBe(true)
    expect(isStale(NOW - 30 * DAY, NOW)).toBe(true)
  })

  it('defaults the threshold to one day and accepts an override', () => {
    expect(STALE_AFTER_MS).toBe(DAY)
    expect(isStale(NOW - 2 * HOUR, NOW, HOUR)).toBe(true)
    expect(isStale(NOW - 2 * HOUR, NOW, 3 * HOUR)).toBe(false)
  })

  it('never calls an unreadable timestamp stale', () => {
    expect(isStale(Number.NaN, NOW)).toBe(false)
    expect(isStale(NOW, Number.NaN)).toBe(false)
  })
})

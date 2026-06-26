// src/plugins/nats-traffic/src/canClear.test.ts
import { describe, it, expect } from 'vitest'
import { canClear } from './canClear'

describe('canClear', () => {
  it('empty array → false (nothing to clear)', () => {
    expect(canClear([])).toBe(false)
  })

  it('one event → true', () => {
    expect(canClear(['evt'])).toBe(true)
  })

  it('many events → true', () => {
    expect(canClear(['a', 'b', 'c', 'd'])).toBe(true)
  })
})

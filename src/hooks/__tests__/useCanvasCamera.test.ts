import { describe, it, expect } from 'vitest'
import { canConsumeWheel, type ScrollMetrics } from '../useCanvasCamera'

const M = (p: Partial<ScrollMetrics>): ScrollMetrics => ({
  scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  scrollLeft: 0, scrollWidth: 0, clientWidth: 0,
  ...p,
})

describe('canConsumeWheel', () => {
  it('is false when there is no overflow', () => {
    expect(canConsumeWheel(M({ scrollHeight: 100, clientHeight: 100 }), 0, 50)).toBe(false)
  })

  it('consumes a downward wheel when not yet at the bottom', () => {
    expect(canConsumeWheel(M({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }), 0, 50)).toBe(true)
  })

  it('does NOT consume a downward wheel when pinned at the bottom (boundary → canvas pans)', () => {
    expect(canConsumeWheel(M({ scrollTop: 200, scrollHeight: 400, clientHeight: 200 }), 0, 50)).toBe(false)
  })

  it('does NOT consume an upward wheel when pinned at the top', () => {
    expect(canConsumeWheel(M({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }), 0, -50)).toBe(false)
  })

  it('consumes an upward wheel when scrolled down', () => {
    expect(canConsumeWheel(M({ scrollTop: 120, scrollHeight: 400, clientHeight: 200 }), 0, -50)).toBe(true)
  })

  it('consumes horizontal overflow on a horizontal wheel', () => {
    expect(canConsumeWheel(M({ scrollLeft: 0, scrollWidth: 400, clientWidth: 200 }), 50, 0)).toBe(true)
  })

  it('does NOT consume horizontal at the right edge', () => {
    expect(canConsumeWheel(M({ scrollLeft: 200, scrollWidth: 400, clientWidth: 200 }), 50, 0)).toBe(false)
  })

  it('consumes when either axis can scroll (diagonal wheel into vertical overflow)', () => {
    // No horizontal overflow, but vertical can scroll → consumable.
    expect(canConsumeWheel(M({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }), 10, 50)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { moveAskGesture as move, placeSwipeRail, releaseAskGesture as release, startAskGesture as start, SWIPE_RAIL_HEIGHT, SWIPE_RAIL_WIDTH } from '../gesture'

const rail = (allowInspect = true) => start(100, 100, false, false, allowInspect)

describe('shared Ask and Inspector rail', () => {
  it('leaves a short move tracking and releases nothing', () => {
    const moved = move(rail(), 91, 103)
    expect(moved.phase).toBe('tracking')
    expect(release(moved)).toBeNull()
    expect(release(null)).toBeNull()
  })

  it('locks a horizontal move without arming, then arms at 72 and disarms at 58', () => {
    const locked = move(rail(), 87, 102)
    expect(locked.phase).toBe('neutral')
    expect(release(locked)).toBeNull()
    const armed = move(locked, 28, 100)
    expect(armed.phase).toBe('ask')
    expect(release(move(armed, 42, 100))).toBe('ask')
    expect(move(armed, 43, 100).phase).toBe('neutral')
    const right = move(rail(), 172, 100)
    expect(right.phase).toBe('inspect')
    expect(release(move(right, 158, 100))).toBe('inspect')
    expect(move(right, 157, 100).phase).toBe('neutral')
  })

  it('keeps vertical and diagonal movement native', () => {
    for (const [x, y] of [[100, 130], [84, 116]]) {
      const locked = move(rail(), x!, y!)
      expect(locked.phase).toBe('native')
      expect(release(locked)).toBeNull()
    }
  })

  it('stays native when that horizontal direction can still scroll', () => {
    expect(move(start(100, 100, true, false, true), 20, 100).phase).toBe('native')
    expect(move(start(100, 100, false, true, true), 180, 100).phase).toBe('native')
    expect(release(move(start(100, 100, false, false, true), 20, 100))).toBe('ask')
  })

  it('does not arm Inspector or keep a stale Ask when Inspect is absent', () => {
    expect(move(start(100, 100), 180, 100).phase).toBe('native')
    const crossed = move(move(start(100, 100), 20, 100), 180, 100)
    expect(crossed.phase).toBe('neutral')
    expect(release(crossed)).toBeNull()
  })

  it('clears Ask before the origin and releases only the phase at the end', () => {
    const ask = move(rail(), 20, 100)
    expect(ask.phase).toBe('ask')
    const disarmed = move(ask, 50, 100)
    expect(disarmed.phase).toBe('neutral')
    expect(disarmed.dx).toBeLessThan(0)
    const past = move(disarmed, 130, 100)
    expect(past.phase).toBe('neutral')
    expect(release(past)).toBeNull()
    expect(release(move(past, 180, 100))).toBe('inspect')
  })

  it('crosses either way in one stroke and holds hysteresis while dithering', () => {
    expect(release(move(move(rail(), 20, 100), 180, 100))).toBe('inspect')
    expect(release(move(move(rail(), 180, 100), 20, 100))).toBe('ask')
    let state = move(rail(), 20, 100)
    for (const x of [40, 22, 41, 25]) state = move(state, x, 100)
    expect(state.phase).toBe('ask')
    expect(release(state)).toBe('ask')
    let quiet = move(rail(), 40, 100)
    for (const x of [45, 35, 48]) quiet = move(quiet, x, 100)
    expect(quiet.phase).toBe('neutral')
    expect(release(quiet)).toBeNull()
  })
})

describe('swipe rail placement', () => {
  const covers = (origin: { x: number; y: number }, placed: { left: number; top: number }) =>
    origin.x >= placed.left && origin.x <= placed.left + SWIPE_RAIL_WIDTH && origin.y >= placed.top && origin.y <= placed.top + SWIPE_RAIL_HEIGHT

  it('sits above the thumb and inside a 390px viewport', () => {
    const origin = { x: 200, y: 640 }
    const placed = placeSwipeRail(origin, 'touch', { width: 390, height: 700 })
    expect(placed.left).toBeGreaterThanOrEqual(8)
    expect(placed.left + SWIPE_RAIL_WIDTH).toBeLessThanOrEqual(382)
    expect(placed.top).toBeGreaterThanOrEqual(8)
    expect(placed.top + SWIPE_RAIL_HEIGHT).toBeLessThan(origin.y)
  })

  it('keeps an edge touch on screen', () => {
    const placed = placeSwipeRail({ x: 12, y: 16 }, 'pen', { width: 390, height: 700 })
    expect(placed.left).toBeGreaterThanOrEqual(8)
    expect(placed.top).toBeGreaterThanOrEqual(8)
    expect(placed.left + SWIPE_RAIL_WIDTH).toBeLessThanOrEqual(382)
    expect(placed.top + SWIPE_RAIL_HEIGHT).toBeLessThanOrEqual(692)
  })

  it('offsets the mouse rail off the pointer, including at the desktop edge', () => {
    for (const origin of [{ x: 400, y: 300 }, { x: 1420, y: 860 }]) {
      const placed = placeSwipeRail(origin, 'mouse', { width: 1440, height: 900 })
      expect(placed.left).toBeGreaterThanOrEqual(8)
      expect(placed.top).toBeGreaterThanOrEqual(8)
      expect(placed.left + SWIPE_RAIL_WIDTH).toBeLessThanOrEqual(1432)
      expect(placed.top + SWIPE_RAIL_HEIGHT).toBeLessThanOrEqual(892)
      expect(covers(origin, placed)).toBe(false)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { moveAskGesture as move, swipeTravel, releaseAskGesture as release, startAskGesture as start } from '../gesture'

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

describe('in-place card travel', () => {
  it('tracks the drag up to arming and resists travel past it in both directions', () => {
    for (const direction of [-1, 1]) {
      expect(swipeTravel(direction * 40)).toBe(direction * 40)
      expect(swipeTravel(direction * 72)).toBe(direction * 72)
      const beyond = Math.abs(swipeTravel(direction * 100))
      expect(beyond).toBeGreaterThan(72)
      expect(beyond).toBeLessThan(100)
      expect(Math.abs(swipeTravel(direction * 10000))).toBeLessThanOrEqual(104)
    }
  })

})

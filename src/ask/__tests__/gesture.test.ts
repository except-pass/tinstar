import { describe, expect, it } from 'vitest'
import { moveAskGesture as move, releaseAskGesture as release, startAskGesture as start } from '../gesture'

describe('Ask text direction lock', () => {
  it('leaves taps and slight motion alone and requires release distance', () => {
    expect(release(move(start(100, 100), 91, 103))).toBe(false)
    const locked = move(start(100, 100), 87, 102)
    expect(locked.lock).toBe('text')
    expect(release(locked)).toBe(false)
    expect(release(move(locked, 52, 105))).toBe(true)
    expect(release(move(locked, 53, 105))).toBe(false)
  })
  it('keeps vertical, diagonal, and rightward movement native once locked', () => {
    for (const [x, y] of [[97, 120], [84, 116], [115, 100]]) {
      const locked = move(start(100, 100), x!, y!)
      expect(locked.lock).toBe('native')
      expect(release(move(locked, 10, 100))).toBe(false)
    }
  })
  it('does not open if reversed before release, cancelled, or in horizontal overflow', () => {
    const locked = move(start(100, 100), 30, 100)
    expect(release(move(locked, 90, 100))).toBe(false)
    expect(release(null)).toBe(false)
    expect(release(move(start(100, 100, true), 20, 100))).toBe(false)
    expect(release(move(start(100, 100, false), 20, 100))).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { classifyPointerUp, clamp01, localToNormalized } from '../pinGestures'

describe('pinGestures', () => {
  it('clamp01 bounds to [0,1]', () => {
    expect(clamp01(-0.2)).toBe(0)
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(0.3)).toBe(0.3)
  })
  it('localToNormalized divides by box size', () => {
    expect(localToNormalized(50, 100, 200, 400)).toEqual({ nx: 0.25, ny: 0.25 })
  })
  it('localToNormalized guards divide-by-zero independently per axis', () => {
    expect(localToNormalized(50, 100, 0, 400)).toEqual({ nx: 0, ny: 0.25 })
    expect(localToNormalized(50, 100, 200, 0)).toEqual({ nx: 0.25, ny: 0 })
    expect(localToNormalized(50, 100, 0, 0)).toEqual({ nx: 0, ny: 0 })
  })
  it('classifyPointerUp returns "click" under threshold', () => {
    expect(classifyPointerUp({ dx: 2, dy: 2 }, 5)).toBe('click')
  })
  it('classifyPointerUp returns "drag" past threshold', () => {
    expect(classifyPointerUp({ dx: 6, dy: 0 }, 5)).toBe('drag')
  })
  it('classifyPointerUp treats exactly-at-threshold as "drag" (>=)', () => {
    expect(classifyPointerUp({ dx: 5, dy: 0 }, 5)).toBe('drag')
  })
})

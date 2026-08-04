import { describe, expect, it } from 'vitest'
import { focusCycleDirection, resolveFocusLayout } from '../focusCanvas'

describe('resolveFocusLayout', () => {
  it('fills the measured canvas while reserving the expanded sidebar', () => {
    expect(resolveFocusLayout({ width: 1440, height: 900 }, 320)).toEqual({
      x: 0,
      y: 0,
      width: 1120,
      height: 900,
    })
  })

  it('never returns negative dimensions on a very small viewport', () => {
    expect(resolveFocusLayout({ width: 240, height: 120 }, 320)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 120,
    })
  })
})

describe('focusCycleDirection', () => {
  it('uses the dominant wheel axis and ignores a stationary wheel', () => {
    expect(focusCycleDirection(0, 80)).toBe('next')
    expect(focusCycleDirection(-90, 10)).toBe('previous')
    expect(focusCycleDirection(0, 0)).toBeNull()
  })
})

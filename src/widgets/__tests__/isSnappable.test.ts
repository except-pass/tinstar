import { describe, it, expect } from 'vitest'
import { isSnappable } from '../widgetComponentRegistry'

describe('isSnappable', () => {
  it('containers never snap', () => {
    expect(isSnappable({ isContainer: true })).toBe(false)
    expect(isSnappable({ isContainer: true, snappable: true })).toBe(false)
  })
  it('non-container leaves snap by default', () => {
    expect(isSnappable({ isContainer: false })).toBe(true)
    expect(isSnappable({ isContainer: false, snappable: undefined })).toBe(true)
  })
  it('snappable:false opts a non-container out', () => {
    expect(isSnappable({ isContainer: false, snappable: false })).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { parseAttach } from '../anchorAttach'

describe('parseAttach', () => {
  it('parses a valid attach with default anchor names', () => {
    expect(parseAttach({ to: 'w1', anchors: 'top-left/top-right' }))
      .toEqual({ to: 'w1', targetAnchor: 'top-left', newAnchor: 'top-right' })
  })
  it('rejects unknown anchor names', () => {
    expect(parseAttach({ to: 'w1', anchors: 'center/top-right' })).toBeNull()
  })
  it('rejects a malformed string', () => {
    expect(parseAttach({ to: 'w1', anchors: 'top-left' })).toBeNull()
    expect(parseAttach({ to: '', anchors: 'top-left/top-right' })).toBeNull()
  })
  it('returns undefined when no attach is present', () => {
    expect(parseAttach(undefined)).toBeUndefined()
  })
})

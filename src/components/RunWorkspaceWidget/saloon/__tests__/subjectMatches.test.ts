import { describe, it, expect } from 'vitest'
import { subjectMatches } from '../subjectMatches'

describe('subjectMatches', () => {
  it('matches exact subjects', () => {
    expect(subjectMatches('tinstar.a.b', 'tinstar.a.b')).toBe(true)
  })

  it('rejects non-matching exact subjects', () => {
    expect(subjectMatches('tinstar.a.b', 'tinstar.a.c')).toBe(false)
  })

  it('> tail matches one more segment', () => {
    expect(subjectMatches('tinstar.a.b', 'tinstar.a.>')).toBe(true)
  })

  it('> tail matches many more segments', () => {
    expect(subjectMatches('tinstar.a.b.c.d', 'tinstar.a.>')).toBe(true)
  })

  it('> does NOT match zero more segments (NATS spec)', () => {
    expect(subjectMatches('tinstar.a', 'tinstar.a.>')).toBe(false)
  })

  it('* matches exactly one segment', () => {
    expect(subjectMatches('tinstar.x.b', 'tinstar.*.b')).toBe(true)
  })

  it('* does not match multiple segments', () => {
    expect(subjectMatches('tinstar.x.y.b', 'tinstar.*.b')).toBe(false)
  })

  it('length mismatch without > fails', () => {
    expect(subjectMatches('tinstar.a.b.c', 'tinstar.a.b')).toBe(false)
  })
})

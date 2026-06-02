import { describe, it, expect } from 'vitest'
import { subjectMatches, subjectMatchesAny } from './subjectMatches'

describe('subjectMatches (NATS token semantics)', () => {
  it('exact match', () => {
    expect(subjectMatches('tinstar.a.b.c', 'tinstar.a.b.c')).toBe(true)
    expect(subjectMatches('tinstar.a.b.c', 'tinstar.a.b.d')).toBe(false)
  })
  it('* matches exactly one token', () => {
    expect(subjectMatches('tinstar.a.b', 'tinstar.*.b')).toBe(true)
    expect(subjectMatches('tinstar.a.x.b', 'tinstar.*.b')).toBe(false)
  })
  it('> matches one-or-more trailing tokens', () => {
    expect(subjectMatches('tinstar.a.b.c', 'tinstar.>')).toBe(true)
    expect(subjectMatches('tinstar.a', 'tinstar.>')).toBe(true)
    expect(subjectMatches('tinstar', 'tinstar.>')).toBe(false)
  })
  it('length mismatch without > fails', () => {
    expect(subjectMatches('tinstar.a.b', 'tinstar.a')).toBe(false)
  })
  it('> is rejected unless it is the final token', () => {
    expect(subjectMatches('tinstar.a.b', 'tinstar.>.b')).toBe(false)
    expect(subjectMatches('tinstar.a.b', 'a.>.b')).toBe(false)
    expect(subjectMatches('tinstar.anything', 'tinstar.>.foo')).toBe(false)
  })
})

describe('subjectMatchesAny', () => {
  it('true if any pattern matches', () => {
    expect(subjectMatchesAny('tinstar.a.b', ['x.>', 'tinstar.*.b'])).toBe(true)
    expect(subjectMatchesAny('tinstar.a.b', ['x.>', 'y.z'])).toBe(false)
    expect(subjectMatchesAny('tinstar.a.b', [])).toBe(false)
  })
})

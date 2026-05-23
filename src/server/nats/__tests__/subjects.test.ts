import { describe, it, expect } from 'vitest'
import { buildAgentSubject, parseSubject, BREAKOUT_PREFIX, TINSTAR_PREFIX } from '../subjects'

describe('buildAgentSubject', () => {
  it('builds the canonical tinstar.<space>.<init>.<epic>.<task>.<session> shape', () => {
    expect(buildAgentSubject({ space: 's', init: 'i', epic: 'e', task: 't', session: 'demo' }))
      .toBe('tinstar.s.i.e.t.demo')
  })

  it('builds the broadcast (no session) form when session is omitted', () => {
    expect(buildAgentSubject({ space: 's', init: 'i', epic: 'e', task: 't' }))
      .toBe('tinstar.s.i.e.t')
  })
})

describe('parseSubject', () => {
  it('recognizes broadcast (5 parts)', () => {
    expect(parseSubject('tinstar.s.i.e.t')).toEqual({
      kind: 'broadcast', space: 's', init: 'i', epic: 'e', task: 't',
    })
  })

  it('recognizes dm (6 parts)', () => {
    expect(parseSubject('tinstar.s.i.e.t.demo')).toEqual({
      kind: 'dm', space: 's', init: 'i', epic: 'e', task: 't', session: 'demo',
    })
  })

  it('recognizes breakout rooms', () => {
    expect(parseSubject('tinstar.room.abc12345')).toEqual({
      kind: 'breakout', room: 'abc12345',
    })
  })

  it('returns null for non-tinstar subjects', () => {
    expect(parseSubject('foo.bar')).toBeNull()
    expect(parseSubject('')).toBeNull()
  })

  it('returns null for malformed tinstar subjects (wrong part count)', () => {
    expect(parseSubject('tinstar.s')).toBeNull()
    expect(parseSubject('tinstar.s.i.e.t.demo.extra')).toBeNull()
  })

  it('returns null for empty breakout room', () => {
    expect(parseSubject('tinstar.room.')).toBeNull()
  })
})

describe('constants', () => {
  it('BREAKOUT_PREFIX is the documented value', () => {
    expect(BREAKOUT_PREFIX).toBe('tinstar.room.')
  })

  it('TINSTAR_PREFIX is the documented value', () => {
    expect(TINSTAR_PREFIX).toBe('tinstar.')
  })
})

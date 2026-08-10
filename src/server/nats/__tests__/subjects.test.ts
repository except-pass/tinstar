import { describe, it, expect } from 'vitest'
import { buildAgentSubject, parseSubject, BREAKOUT_PREFIX, TINSTAR_PREFIX } from '../subjects'

describe('buildAgentSubject', () => {
  it('builds the canonical tinstar.<space>.<project>.<worktree>.<session> shape', () => {
    expect(buildAgentSubject({ space: 's', project: 'p', worktree: 'w', session: 'demo' }))
      .toBe('tinstar.s.p.w.demo')
  })

  it('builds the broadcast (no session) form when session is omitted', () => {
    expect(buildAgentSubject({ space: 's', project: 'p', worktree: 'w' }))
      .toBe('tinstar.s.p.w')
  })
})

describe('parseSubject', () => {
  it('recognizes broadcast (4 parts)', () => {
    expect(parseSubject('tinstar.s.p.w')).toEqual({
      kind: 'broadcast', space: 's', project: 'p', worktree: 'w',
    })
  })

  it('recognizes dm (5 parts)', () => {
    expect(parseSubject('tinstar.s.p.w.demo')).toEqual({
      kind: 'dm', space: 's', project: 'p', worktree: 'w', session: 'demo',
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
    expect(parseSubject('tinstar.s.p.w.demo.extra')).toBeNull()
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

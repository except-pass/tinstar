import { describe, it, expect } from 'vitest'
import { reconnectIntent, reconnectTooltip } from './reconnectIntent'

describe('reconnectIntent', () => {
  it('no bound sessions (e.g. all-traffic mode) → bounce the observer', () => {
    expect(reconnectIntent([])).toEqual({ kind: 'bounce-observer' })
  })

  it('bound sessions, none orphaned → bounce the observer', () => {
    const intent = reconnectIntent([
      { sessionId: 'a', orphanedAt: null },
      { sessionId: 'b', orphanedAt: undefined },
    ])
    expect(intent).toEqual({ kind: 'bounce-observer' })
  })

  it('recovers only the orphaned sessions', () => {
    const intent = reconnectIntent([
      { sessionId: 'a', orphanedAt: null },
      { sessionId: 'b', orphanedAt: '2026-06-03T00:00:00Z' },
      { sessionId: 'c', orphanedAt: '2026-06-03T00:01:00Z' },
    ])
    expect(intent).toEqual({ kind: 'recover-sessions', sessionIds: ['b', 'c'] })
  })

  it('tooltip reflects the intent honestly', () => {
    expect(reconnectTooltip({ kind: 'bounce-observer' })).toBe('Re-sync NATS traffic view')
    expect(reconnectTooltip({ kind: 'recover-sessions', sessionIds: ['b'] }))
      .toContain('orphaned')
  })
})

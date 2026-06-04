// src/plugins/nats-traffic/src/subscribedLabel.test.ts
import { describe, it, expect } from 'vitest'
import { subscribedLabel } from './subscribedLabel'

describe('subscribedLabel', () => {
  it('all-traffic mode → firehose label', () => {
    expect(subscribedLabel({ mode: 'all', subjects: [], resolved: false }))
      .toBe('tinstar.> (all sessions)')
  })

  it('runs mode with subjects → dot-joined subject list', () => {
    expect(subscribedLabel({ mode: 'runs', subjects: ['a.broadcast', 'a.broadcast.sess'], resolved: true }))
      .toBe('a.broadcast  ·  a.broadcast.sess')
  })

  it('runs mode, not yet resolved → resolving…', () => {
    expect(subscribedLabel({ mode: 'runs', subjects: [], resolved: false }))
      .toBe('resolving…')
  })

  // Regression: a bound session with NATS disabled resolves to an empty
  // subject list. This must read as a terminal "nothing to show" state, not
  // the transient "resolving…" — otherwise the header looks stuck forever.
  it('runs mode, resolved but no subjects → no-subjects state, NOT resolving…', () => {
    const label = subscribedLabel({ mode: 'runs', subjects: [], resolved: true })
    expect(label).not.toBe('resolving…')
    expect(label).toBe('no subjects — NATS not enabled')
  })
})

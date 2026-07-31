import { describe, expect, it } from 'vitest'
import { sessionNatsProjection } from '../index'

describe('sessionNatsProjection', () => {
  it('does not rehydrate historical subjects for a disabled session', () => {
    expect(sessionNatsProjection({
      nats: {
        enabled: false,
        subscriptions: ['tinstar.old.broadcast', 'tinstar.old.direct'],
      },
    })).toEqual({
      natsEnabled: false,
      natsSubject: undefined,
      natsSubscriptions: undefined,
    })
  })

  it('projects enabled subscriptions and prefers the direct subject', () => {
    expect(sessionNatsProjection({
      nats: {
        enabled: true,
        subscriptions: ['tinstar.broadcast', 'tinstar.direct'],
      },
    })).toEqual({
      natsEnabled: true,
      natsSubject: 'tinstar.direct',
      natsSubscriptions: ['tinstar.broadcast', 'tinstar.direct'],
    })
  })
})

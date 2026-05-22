import { describe, it, expect } from 'vitest'
import { EventBus } from '../event-bus'
import type { BusEvent, ManagedSessionNatsOrphanedPayload } from '../types'

describe('BusEvent — managed_session.nats_orphaned', () => {
  it('flows through the typed bus with a typed payload', () => {
    const bus = new EventBus()
    const received: BusEvent[] = []
    bus.on('managed_session.nats_orphaned', (e) => received.push(e))

    const payload: ManagedSessionNatsOrphanedPayload = {
      name: 'demo',
      orphanedAt: '2026-05-22T00:00:00.000Z',
      reason: 'breakout_subscribe_failed',
      restartRecommended: true,
    }

    bus.emit({
      type: 'managed_session.nats_orphaned',
      timestamp: '2026-05-22T00:00:00.000Z',
      payload,
    })

    expect(received).toHaveLength(1)
    expect(received[0]!.payload).toEqual(payload)
  })
})

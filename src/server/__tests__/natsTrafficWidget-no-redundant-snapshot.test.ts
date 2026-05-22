import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../stores/document-store'
import type { NatsTrafficWidget } from '../../domain/types'

describe('NatsTrafficWidget upsert', () => {
  it('emits exactly one change event per upsert (no snapshot fallback needed)', () => {
    const store = new DocumentStore()
    const events: unknown[] = []
    store.changes.on('change', (e) => events.push(e))

    const widget: NatsTrafficWidget = {
      id: 'nats-1',
      sessionId: 'demo',
      subscriptions: ['tinstar.>'],
      color: '#ff7700',
    }
    store.upsertNatsTrafficWidget(widget.id, widget)
    expect(events).toHaveLength(1)
  })
})

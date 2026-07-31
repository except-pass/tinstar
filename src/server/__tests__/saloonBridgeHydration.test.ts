// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { rehydrateSaloonSubs } from '../api/saloonBridge'

describe('saloon bridge hydration on server boot', () => {
  it('registers only NATS-enabled persisted sessions on restart', () => {
    const bridge = { updateWidgetSubscriptions: vi.fn(), removeWidget: vi.fn() }
    const sessions = [
      { name: 'alpha', nats: { enabled: true,  subscriptions: ['tinstar.a'] } },
      { name: 'beta',  nats: { enabled: false, subscriptions: ['tinstar.b'] } },
      { name: 'gamma', nats: null },
    ]
    for (const s of sessions) {
      rehydrateSaloonSubs(bridge as any, s as any)
    }
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledTimes(1)
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledWith('saloon:alpha', ['tinstar.a'])
  })
})

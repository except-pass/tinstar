// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { registerSaloonSubs } from '../api/saloonBridge'

describe('saloon bridge hydration on server boot', () => {
  it('registers every session with the bridge using saloon:<name>', () => {
    const bridge = { updateWidgetSubscriptions: vi.fn(), removeWidget: vi.fn() }
    const sessions = [
      { name: 'alpha', nats: { enabled: true,  subscriptions: ['tinstar.a'] } },
      { name: 'beta',  nats: { enabled: false, subscriptions: ['tinstar.b'] } },
      { name: 'gamma', nats: null },
    ]
    for (const s of sessions) {
      registerSaloonSubs(bridge as any, s.name, s.nats?.subscriptions ?? [])
    }
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledTimes(3)
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledWith('saloon:alpha', ['tinstar.a'])
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledWith('saloon:beta',  ['tinstar.b'])
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledWith('saloon:gamma', [])
  })
})

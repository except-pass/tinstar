// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

/**
 * Thin contract test — validates that the helper we extract calls the bridge
 * with the saloon-scoped key and the session's current subscriptions.
 */
import { registerSaloonSubs, unregisterSaloonSubs } from '../api/saloonBridge'

describe('saloon bridge registration', () => {
  it('registers subscriptions under saloon:<sessionName>', () => {
    const bridge = { updateWidgetSubscriptions: vi.fn(), removeWidget: vi.fn() }
    registerSaloonSubs(bridge as any, 'natsViz', ['tinstar.a.b.c', 'tinstar.a.b.c.natsViz'])
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledWith(
      'saloon:natsViz',
      ['tinstar.a.b.c', 'tinstar.a.b.c.natsViz'],
    )
  })

  it('unregisters the saloon key on session stop', () => {
    const bridge = { updateWidgetSubscriptions: vi.fn(), removeWidget: vi.fn() }
    unregisterSaloonSubs(bridge as any, 'natsViz')
    expect(bridge.removeWidget).toHaveBeenCalledWith('saloon:natsViz')
  })

  it('no-ops when bridge is undefined (NATS disabled)', () => {
    expect(() => registerSaloonSubs(undefined, 'x', [])).not.toThrow()
    expect(() => unregisterSaloonSubs(undefined, 'x')).not.toThrow()
  })
})

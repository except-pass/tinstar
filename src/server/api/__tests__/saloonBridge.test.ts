// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  registerSaloonSubs,
  unregisterSaloonSubs,
  registerFirehose,
  unregisterFirehose,
} from '../saloonBridge'

function makeBridge() {
  return {
    updateWidgetSubscriptions: vi.fn(),
    removeWidget: vi.fn(),
  }
}

describe('saloonBridge', () => {
  it('registerSaloonSubs keys subjects by session name', () => {
    const bridge = makeBridge()
    registerSaloonSubs(bridge as never, 'alpha', ['tinstar.a.b'])
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledWith('saloon:alpha', ['tinstar.a.b'])
  })

  it('unregisterSaloonSubs removes the session-keyed widget', () => {
    const bridge = makeBridge()
    unregisterSaloonSubs(bridge as never, 'alpha')
    expect(bridge.removeWidget).toHaveBeenCalledWith('saloon:alpha')
  })

  it('registerFirehose subscribes a widget-keyed entry to the whole bus', () => {
    const bridge = makeBridge()
    registerFirehose(bridge as never, 'saloon-w1')
    expect(bridge.updateWidgetSubscriptions).toHaveBeenCalledWith('firehose:saloon-w1', ['tinstar.>'])
  })

  it('unregisterFirehose removes the widget-keyed firehose entry', () => {
    const bridge = makeBridge()
    unregisterFirehose(bridge as never, 'saloon-w1')
    expect(bridge.removeWidget).toHaveBeenCalledWith('firehose:saloon-w1')
  })

  it('all helpers no-op safely when the bridge is undefined', () => {
    // No throw == pass; the bridge is optional when NATS isn't configured.
    expect(() => {
      registerSaloonSubs(undefined, 'a', ['x'])
      unregisterSaloonSubs(undefined, 'a')
      registerFirehose(undefined, 'w')
      unregisterFirehose(undefined, 'w')
    }).not.toThrow()
  })
})

import type { NatsTrafficBridge } from '../nats-traffic'

export type BounceErrorCode = 'BRIDGE_UNAVAILABLE' | 'BOUNCE_FAILED'

export class BounceError extends Error {
  constructor(public code: BounceErrorCode, message: string) {
    super(message)
    this.name = 'BounceError'
  }
}

/**
 * Stop and restart the NATS observer connection. `widgetSubscriptions` on the
 * bridge is preserved across the call, so all Saloon panels resume observing
 * automatically once start() resyncs.
 *
 * Throws BounceError('BRIDGE_UNAVAILABLE') if the bridge is undefined (NATS
 * disabled in tinstar config), or BounceError('BOUNCE_FAILED') if either
 * stop() or start() throws.
 */
export async function bounceNatsTraffic(bridge: NatsTrafficBridge | undefined): Promise<void> {
  if (!bridge) {
    throw new BounceError('BRIDGE_UNAVAILABLE', 'NATS bridge is disabled in tinstar config')
  }
  try {
    await bridge.stop()
    await bridge.start()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new BounceError('BOUNCE_FAILED', msg)
  }
}

import type { NatsTrafficBridge } from '../nats-traffic'

function saloonKey(sessionName: string): string {
  return `saloon:${sessionName}`
}

export function registerSaloonSubs(
  bridge: NatsTrafficBridge | undefined,
  sessionName: string,
  subjects: string[],
): void {
  if (!bridge) return
  bridge.updateWidgetSubscriptions(saloonKey(sessionName), subjects)
}

export function unregisterSaloonSubs(
  bridge: NatsTrafficBridge | undefined,
  sessionName: string,
): void {
  if (!bridge) return
  bridge.removeWidget(saloonKey(sessionName))
}

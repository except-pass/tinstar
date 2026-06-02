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

// Full-bus wildcard. NATS `>` matches one-or-more trailing tokens, so this
// captures every tinstar subject regardless of space/init/epic/task/session.
const FIREHOSE_SUBJECT = 'tinstar.>'

function firehoseKey(widgetId: string): string {
  return `firehose:${widgetId}`
}

/** An unsnapped Saloon in 'all' mode asks the bridge to subscribe to the whole
 *  bus so its "all traffic" label is truthful. Keyed per widget; the bridge
 *  unions+dedupes subjects, so N firehose widgets share a single tinstar.> sub. */
export function registerFirehose(bridge: NatsTrafficBridge | undefined, widgetId: string): void {
  if (!bridge) return
  bridge.updateWidgetSubscriptions(firehoseKey(widgetId), [FIREHOSE_SUBJECT])
}

export function unregisterFirehose(bridge: NatsTrafficBridge | undefined, widgetId: string): void {
  if (!bridge) return
  bridge.removeWidget(firehoseKey(widgetId))
}

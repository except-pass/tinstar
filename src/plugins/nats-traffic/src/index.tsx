import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { NatsTrafficWidget } from './NatsTrafficWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('nats-traffic plugin activating')
  return [
    api.widgets.register({
      type: 'nats-traffic',
      component: NatsTrafficWidget,
      isContainer: false,
      defaultSize: { width: 1200, height: 600 },
      minSize: { width: 400, height: 200 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}

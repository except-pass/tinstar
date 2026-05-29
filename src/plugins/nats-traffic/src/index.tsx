// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
// Lone exception: `import type` from src/domain/types for widget data shapes.
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeNatsTrafficWidget } from './NatsTrafficWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('nats-traffic plugin activating')
  return [
    api.widgets.register({
      type: 'nats-traffic',
      component: makeNatsTrafficWidget(api) as ComponentType<WidgetProps>,
      isContainer: false,
      defaultSize: { width: 1200, height: 600 },
      minSize: { width: 400, height: 200 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}

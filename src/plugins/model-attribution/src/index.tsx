// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeModelAttributionWidget } from './ModelAttributionWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('model-attribution plugin activating')
  const component = makeModelAttributionWidget(api) as ComponentType<WidgetProps>
  return [
    api.widgets.register({
      type: 'model-attribution',
      component,
      isContainer: false,
      defaultSize: { width: 420, height: 340 },
      minSize: { width: 240, height: 180 },
      dragHandleSelector: '.widget-drag-handle',
      capabilities: ['spawnable'],
    }),
  ]
}

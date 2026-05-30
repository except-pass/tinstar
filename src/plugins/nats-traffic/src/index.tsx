// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeSaloonWidget } from './Saloon'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('saloon plugin activating')
  return [
    api.widgets.register({
      type: 'saloon',
      component: makeSaloonWidget(api) as ComponentType<WidgetProps>,
      isContainer: false,
      defaultSize: { width: 1200, height: 600 },
      minSize: { width: 400, height: 200 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}

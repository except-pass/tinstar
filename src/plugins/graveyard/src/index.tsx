// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeGraveyardWidget } from './GraveyardWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('graveyard plugin activating')
  const component = makeGraveyardWidget(api) as ComponentType<WidgetProps>
  return [
    api.widgets.register({
      type: 'graveyard',
      component,
      isContainer: false,
      defaultSize: { width: 900, height: 640 },
      minSize: { width: 380, height: 240 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}

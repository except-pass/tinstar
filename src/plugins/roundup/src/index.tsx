// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeRoundupWidget } from './RoundupWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('roundup plugin activating')
  const component = makeRoundupWidget(api) as ComponentType<WidgetProps>
  return [
    api.widgets.register({
      type: 'roundup',
      component,
      isContainer: false,
      defaultSize: { width: 720, height: 620 },
      minSize: { width: 340, height: 240 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}

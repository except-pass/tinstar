// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeCannedPromptsWidget } from './CannedPromptsWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('canned-prompts plugin activating')
  return [
    api.widgets.register({
      type: 'canned-prompts',
      component: makeCannedPromptsWidget(api) as ComponentType<WidgetProps>,
      isContainer: false,
      defaultSize: { width: 240, height: 180 },
      minSize: { width: 200, height: 120 },
      dragHandleSelector: '.widget-drag-handle',
      supportsMinimize: false,
    }),
  ]
}

import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { BrowserWidget } from './BrowserWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('browser plugin activating')
  return [
    api.widgets.register({
      type: 'browser-widget',
      component: BrowserWidget,
      isContainer: false,
      defaultSize: { width: 800, height: 600 },
      minSize: { width: 320, height: 240 },
      dragHandleSelector: '.widget-drag-handle',
      supportsMinimize: false,
    }),
  ]
}

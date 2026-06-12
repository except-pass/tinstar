// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
// Lone exception: `import type` from src/domain/types for widget data shapes.
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeBrowserWidget } from './BrowserWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('browser plugin activating')
  return [
    api.widgets.register({
      type: 'browser-widget',
      component: makeBrowserWidget(api) as ComponentType<WidgetProps>,
      isContainer: false,
      defaultSize: { width: 800, height: 600 },
      minSize: { width: 320, height: 240 },
      dragHandleSelector: '.widget-drag-handle',
      supportsMinimize: false,
      // Pins glue to scrolling page content, so the browser self-renders its pin
      // markers/bubbles (positioned in document coords minus iframe scroll). The
      // host still owns placement (corner affordance → onCreatePin) and the store.
      rendersOwnPinMarkers: true,
    }),
  ]
}

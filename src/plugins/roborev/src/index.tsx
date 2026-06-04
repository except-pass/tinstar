// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { makeCockpitAccessory } from './CockpitAccessory'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('roborev cockpit plugin activating')
  return [
    api.primitives.registerTerminalWidget({
      type: 'roborev-cockpit',
      creator: 'session-backed',
      defaultSize: { width: 1100, height: 720 },
      minSize: { width: 520, height: 320 },
      accessory: {
        placement: 'right',
        size: 320,
        component: makeCockpitAccessory(api),
      },
    }),
  ]
}

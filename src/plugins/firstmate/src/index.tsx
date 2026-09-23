// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
//
// Card-only view for OBSERVED first mate workers. The server-side observer
// (src/server/firstmate/) mirrors each worker as a docstore-only Run with
// `view: 'firstmate-worker'`; the host renders that run with this widget. It is
// deliberately not palette-spawnable (no `contributes.widgets`): a card only makes
// sense for a run the observer created.
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { FirstmateCard } from './FirstmateCard'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('firstmate plugin activating')
  return [
    api.widgets.register({
      type: 'firstmate-worker',
      component: FirstmateCard as ComponentType<WidgetProps>,
      isContainer: false,
      defaultSize: { width: 420, height: 320 },
      minSize: { width: 300, height: 200 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}

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
import { FirstmateCard, type SetConversation } from './FirstmateCard'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('firstmate plugin activating')
  const setConversation: SetConversation = async (runId, conversationId) => {
    try {
      const res = await api.http.fetch(`/api/firstmate/runs/${encodeURIComponent(runId)}/conversation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      })
      return res.ok
    } catch {
      return false
    }
  }
  const Card: ComponentType<WidgetProps> = props => <FirstmateCard {...props} setConversation={setConversation} />
  return [
    api.widgets.register({
      type: 'firstmate-worker',
      component: Card,
      isContainer: false,
      defaultSize: { width: 420, height: 320 },
      minSize: { width: 300, height: 200 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}

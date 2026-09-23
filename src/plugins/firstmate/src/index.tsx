// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
//
// View for OBSERVED first mate workers. The server-side observer
// (src/server/firstmate/) mirrors each worker as a docstore-only Run with
// `view: 'firstmate-worker'`; the host renders that run with this widget: a live,
// typeable terminal on the worker's real tmux window (served by the observer's own
// ttyd through the host's /s/<runId>/ proxy) with the read-only card as its
// right-hand accessory. Deliberately NOT palette-spawnable (creator stays
// 'standalone'): a card only makes sense for a run the observer created.
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
  function FirstmateAccessory() {
    // The run's viewData (+ sessionId), injected by the host.
    const [data] = api.widget.useData<Record<string, unknown>>()
    return <FirstmateCard {...({ data: data ?? undefined } as unknown as WidgetProps)} setConversation={setConversation} />
  }
  return [
    api.primitives.registerTerminalWidget({
      type: 'firstmate-worker',
      defaultSize: { width: 1000, height: 560 },
      minSize: { width: 520, height: 260 },
      accessory: { placement: 'right', size: 300, component: FirstmateAccessory as ComponentType },
    }),
  ]
}

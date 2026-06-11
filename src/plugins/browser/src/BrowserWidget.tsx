// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
// Lone exception: `import type` from src/domain/types for widget data shapes.
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { BrowserWidget } from '../../../domain/types'
import { makeBrowserPrimitive } from './BrowserPrimitive'

export function makeBrowserWidget(api: TinstarPluginAPI) {
  const BrowserPrimitive = makeBrowserPrimitive(api)

  function BrowserWidget({ data, isSelected, isDragging, isHovered }: WidgetProps<BrowserWidget>) {
    const widget = data
    const accent = api.theme.accent.resolve(widget.color)
    // The canonical node id (no manual prefixing — `widget.id` already carries
    // the `browser-` prefix, so `browser-${widget.id}` would double it up).
    const myNodeId = api.constellations.useMyNodeId()
    const { slotsForNode, nodesInSlot } = api.constellations.useContext()
    const mySlots = slotsForNode(myNodeId)

    // Page-notes need a session to submit to. An explicit `sessionId` (e.g. an
    // agent's artifact push) wins; otherwise a browser snapped into a run's
    // constellation slot is treated as attached to that run's session — so
    // "snap to the run" == "attach", matching what the user expects. Run node
    // ids are `run-<sessionId>` (run.id === sessionId), so strip the prefix.
    // Computed inline (not memoized): `mySlots`/`nodesInSlot` are fresh each
    // render, so a useMemo would never hit its cache — and the loop is cheap.
    let effectiveSessionId = widget.sessionId
    if (!effectiveSessionId) {
      for (const slot of mySlots) {
        const runPeer = nodesInSlot(slot).find(id => id !== myNodeId && id.startsWith('run-'))
        if (runPeer) { effectiveSessionId = runPeer.slice('run-'.length); break }
      }
    }

    const persist = (patch: Partial<Pick<BrowserWidget, 'url' | 'headers' | 'notes'>>) => {
      api.http.fetch(`/api/browser-widgets/${widget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => {})
    }

    return (
      <BrowserPrimitive
        nodeId={widget.id}
        hotkeyId={widget.id}
        url={widget.url}
        headers={widget.headers}
        title={widget.title}
        accent={accent}
        slots={mySlots}
        isSelected={isSelected}
        isDragging={isDragging}
        isHovered={isHovered}
        onNavigate={(url) => persist({ url })}
        onHeadersChange={(headers) => persist({ headers })}
        sessionId={effectiveSessionId}
        notes={widget.notes}
        onNotesChange={(notes) => persist({ notes })}
        onClose={() => api.http.fetch(`/api/browser-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})}
      />
    )
  }

  return BrowserWidget
}

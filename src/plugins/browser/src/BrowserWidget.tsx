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
    const { slotsForNode } = api.constellations.useContext()
    const mySlots = slotsForNode(myNodeId)

    // Page-notes need a session to submit to. An explicit `sessionId` (e.g. an
    // agent's artifact push) wins; otherwise a browser snapped into a run's
    // constellation slot is treated as attached to that run's session — so
    // "snap to the run" == "attach", matching what the user expects. The host
    // resolves the backing session from constellation membership via the plugin
    // API (kept off host internals per ADR-0002); `useBackingSession` is a hook,
    // so call it unconditionally before the `??` precedence below.
    const backingSession = api.constellations.useBackingSession(myNodeId)
    const effectiveSessionId = widget.sessionId ?? backingSession ?? undefined

    // `widget.notes` is LEGACY: page annotations now live in the host-wide pin
    // system (api.pins), self-rendered by the browser primitive. The browser no
    // longer writes `notes`; the field is kept read-only on the type for the
    // Task 9 migration that backfills old notes into pins. Only url/headers are
    // persisted here.
    const persist = (patch: Partial<Pick<BrowserWidget, 'url' | 'headers'>>) => {
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
        onClose={() => api.http.fetch(`/api/browser-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})}
      />
    )
  }

  return BrowserWidget
}

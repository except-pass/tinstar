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
    const { slotsForNode } = api.constellations.useContext()

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
        slots={slotsForNode(`browser-${widget.id}`)}
        isSelected={isSelected}
        isDragging={isDragging}
        isHovered={isHovered}
        onNavigate={(url) => persist({ url })}
        onHeadersChange={(headers) => persist({ headers })}
        sessionId={widget.sessionId}
        notes={widget.notes}
        onNotesChange={(notes) => persist({ notes })}
        onClose={() => api.http.fetch(`/api/browser-widgets/${widget.id}`, { method: 'DELETE' }).catch(() => {})}
      />
    )
  }

  return BrowserWidget
}

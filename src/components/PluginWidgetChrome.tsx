import type { ComponentType } from 'react'
import { apiFetch } from '../apiClient'
import type { PluginWidgetInstance } from '../domain/types'

/**
 * Host-owned chrome wrapper for plugin widgets.
 *
 * Plugin widget authors register a component that renders only the widget
 * body. The host wraps that body in this chrome to provide:
 *  - a draggable header (.widget-drag-handle) so the widget can be moved,
 *  - a label so the widget is identifiable on the canvas,
 *  - a close button that deletes the instance via the standard endpoint.
 *
 * Built-in widgets (run, file-editor, browser, image, nats) all render their
 * own header today; only plugin widgets get this auto-chrome. The shape
 * matches those built-in headers so the canvas feels consistent.
 */

interface CanvasWidgetProps {
  data: unknown
  zoom: number
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
  isDropTarget: boolean
}

interface ChromeProps extends CanvasWidgetProps {
  data: PluginWidgetInstance
}

/** Wrap a plugin's inner component in a host header + body container. */
export function withPluginChrome(InnerComponent: ComponentType<CanvasWidgetProps>): ComponentType<CanvasWidgetProps> {
  function PluginWidgetChrome(props: ChromeProps) {
    const { data: instance } = props
    const title = instance.widgetType
    const subtitle = instance.pluginId

    const onClose = () => {
      apiFetch(`/api/plugin-widgets/${instance.id}`, { method: 'DELETE' }).catch(err => {
        console.warn('[plugin-widget] delete failed:', err)
      })
    }

    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div
          className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab active:cursor-grabbing select-none"
          data-testid={`plugin-widget-header-${instance.id}`}
        >
          <span className="text-2xs font-mono uppercase tracking-wider text-slate-400 truncate flex-1">
            <span className="text-slate-200">{title}</span>
            <span className="text-slate-500"> · {subtitle}</span>
          </span>
          <button
            className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-red-400 rounded hover:bg-white/5 transition-colors"
            onClick={(e) => { e.stopPropagation(); onClose() }}
            title="Remove widget"
            data-testid={`plugin-widget-close-${instance.id}`}
            aria-label="Remove widget"
          >
            <span className="material-symbols-outlined text-sm" style={{ fontSize: '14px' }}>close</span>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <InnerComponent {...props} />
        </div>
      </div>
    )
  }
  return PluginWidgetChrome as ComponentType<CanvasWidgetProps>
}

/**
 * Per-widget-type wrapper cache. CanvasWidgetShell uses the component
 * reference as part of React's reconciliation identity — if we created a new
 * wrapper function on every render, React would remount the inner plugin
 * component (and the plugin would lose all internal state) on every parent
 * re-render. The cache keeps one wrapper per widget type for the session.
 */
const wrapperCache = new Map<string, ComponentType<CanvasWidgetProps>>()

export function getOrCreatePluginChromeWrapper(
  widgetType: string,
  innerComponent: ComponentType<CanvasWidgetProps>,
): ComponentType<CanvasWidgetProps> {
  let cached = wrapperCache.get(widgetType)
  if (!cached) {
    cached = withPluginChrome(innerComponent)
    wrapperCache.set(widgetType, cached)
  }
  return cached
}

import { useState } from 'react'
import { usePluginWidgetRegistry, type PaletteWidgetEntry } from '../../hooks/usePluginWidgetRegistry'
import { isIconUrl } from '../agentIcon'

export function WidgetsPalette() {
  const { entries, error } = usePluginWidgetRegistry()
  const [expanded, setExpanded] = useState(true)

  // Group by pluginId, preserving plugin order from the registry response
  const groups: Array<{ pluginId: string; pluginDisplayName: string; widgets: PaletteWidgetEntry[] }> = []
  for (const e of entries ?? []) {
    let g = groups.find(g => g.pluginId === e.pluginId)
    if (!g) {
      g = { pluginId: e.pluginId, pluginDisplayName: e.pluginDisplayName, widgets: [] }
      groups.push(g)
    }
    g.widgets.push(e)
  }

  return (
    <div className="border-t border-white/5 pt-2 pb-2 flex-shrink-0 flex flex-col min-h-0" data-testid="widgets-palette">
      <button
        className="w-full flex items-center gap-1 px-3 py-1 text-2xs font-mono uppercase tracking-wider text-slate-500 hover:text-primary flex-shrink-0"
        onClick={() => setExpanded(v => !v)}
        data-testid="widgets-palette-toggle"
      >
        <span className="material-symbols-outlined text-xs">{expanded ? 'expand_more' : 'chevron_right'}</span>
        WIDGETS
      </button>

      {/* Bounded so a long widget list scrolls within the palette instead of pushing it off-screen. */}
      <div className="overflow-y-auto scrollbar-thin min-h-0" style={{ maxHeight: '40vh' }}>
      {expanded && error && (
        <div className="px-3 py-2 text-xs text-red-300" data-testid="widgets-palette-error">
          Failed to load widgets: {error}
        </div>
      )}

      {expanded && !error && entries === null && (
        <div className="px-3 py-2 text-xs text-slate-500">loading…</div>
      )}

      {expanded && !error && entries !== null && entries.length === 0 && (
        <div className="px-3 py-3 text-xs text-slate-400 space-y-2">
          <div>No widget plugins active.</div>
          <button
            className="text-primary underline hover:text-primary-bright"
            onClick={() => window.dispatchEvent(new CustomEvent('tinstar:open-settings', { detail: { section: 'plugins' } }))}
            data-testid="widgets-palette-open-settings"
          >
            Open Settings → Plugins
          </button>
        </div>
      )}

      {expanded && !error && entries !== null && entries.length > 0 && groups.map(g => (
        <div key={g.pluginId} className="px-3 py-1">
          <div className="text-2xs font-mono uppercase text-slate-400 mb-1">{g.pluginDisplayName}</div>
          {g.widgets.map(w => <PaletteEntry key={`${g.pluginId}/${w.widgetType}`} entry={w} />)}
        </div>
      ))}
      </div>
    </div>
  )
}

function PaletteEntry({ entry }: { entry: PaletteWidgetEntry }) {
  const isContextOnly = entry.spawn === 'palette+context'

  return (
    <div
      data-testid={`palette-entry-${entry.pluginId}-${entry.widgetType}`}
      draggable={!isContextOnly}
      onDragStart={(e) => {
        if (isContextOnly) return
        const size = entry.defaultSize ?? { width: 360, height: 280 }
        e.dataTransfer.setData(
          'application/tinstar-plugin-widget',
          JSON.stringify({ pluginId: entry.pluginId, widgetType: entry.widgetType, defaultSize: size }),
        )
        e.dataTransfer.effectAllowed = 'copy'
        // Notify the ghost overlay (Task 11) — harmless if no listener
        window.dispatchEvent(new CustomEvent('tinstar:palette-drag-start', {
          detail: { width: size.width, height: size.height, label: entry.label },
        }))
      }}
      className={
        'flex items-start gap-2 px-2 py-1.5 mb-0.5 rounded text-xs '
        + (isContextOnly
          ? 'opacity-50 cursor-not-allowed'
          : 'cursor-grab hover:bg-white/5 active:cursor-grabbing')
      }
      title={isContextOnly ? 'Available from a Run (V5.2+)' : entry.description}
    >
      {entry.icon && isIconUrl(entry.icon)
        ? <img src={entry.icon} className="w-4 h-4 mt-0.5" alt="" />
        : <span className="w-4 h-4 mt-0.5 inline-flex items-center justify-center text-2xs font-mono text-slate-400">{entry.label[0]}</span>}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-200 truncate">{entry.label}</div>
        {entry.description && <div className="text-2xs text-slate-500 truncate">{entry.description}</div>}
      </div>
    </div>
  )
}

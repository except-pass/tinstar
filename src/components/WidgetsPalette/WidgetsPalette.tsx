import { useState } from 'react'
import { usePluginWidgetRegistry, type PaletteWidgetEntry } from '../../hooks/usePluginWidgetRegistry'
import { isIconUrl } from '../agentIcon'

export function WidgetsPalette() {
  const { entries, error } = usePluginWidgetRegistry()
  const [expanded, setExpanded] = useState(true)

  const total = entries?.length ?? 0

  return (
    <div className="border-t border-white/5 pt-2 pb-2 flex-shrink-0 flex flex-col min-h-0" data-testid="widgets-palette">
      <button
        className="group w-full flex items-center gap-1.5 px-3 py-1 text-2xs font-mono uppercase tracking-wider text-slate-500 hover:text-primary flex-shrink-0 transition-colors"
        onClick={() => setExpanded(v => !v)}
        data-testid="widgets-palette-toggle"
      >
        <span className="material-symbols-outlined text-xs">{expanded ? 'expand_more' : 'chevron_right'}</span>
        <span>WIDGETS</span>
        {total > 0 && (
          <span className="ml-auto rounded-full bg-white/5 px-1.5 py-px text-[10px] font-mono text-slate-400 group-hover:bg-primary/15 group-hover:text-primary transition-colors">
            {total}
          </span>
        )}
      </button>

      {/* Bounded so a long widget list scrolls within the palette instead of pushing it off-screen. */}
      {expanded && (
        <div className="overflow-y-auto scrollbar-thin min-h-0 px-2 pt-1.5" style={{ maxHeight: '40vh' }}>
          {error && (
            <div className="px-1 py-2 text-xs text-red-300" data-testid="widgets-palette-error">
              Failed to load widgets: {error}
            </div>
          )}

          {!error && entries === null && (
            <div className="px-1 py-2 text-xs text-slate-500">loading…</div>
          )}

          {!error && entries !== null && entries.length === 0 && (
            <div className="px-1 py-3 text-xs text-slate-400 space-y-2">
              <div>No widget plugins active.</div>
              <button
                className="text-primary underline hover:text-white"
                onClick={() => window.dispatchEvent(new CustomEvent('tinstar:open-settings', { detail: { section: 'plugins' } }))}
                data-testid="widgets-palette-open-settings"
              >
                Open Settings → Plugins
              </button>
            </div>
          )}

          {!error && entries !== null && entries.length > 0 && (
            <div className="grid grid-cols-2 gap-2 px-1 pb-1">
              {entries.map(w => <PaletteTile key={`${w.pluginId}/${w.widgetType}`} entry={w} />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PaletteTile({ entry }: { entry: PaletteWidgetEntry }) {
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
        // Notify the ghost overlay — harmless if no listener
        window.dispatchEvent(new CustomEvent('tinstar:palette-drag-start', {
          detail: { width: size.width, height: size.height, label: entry.label },
        }))
      }}
      className={
        'group relative flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-center select-none transition-all duration-150 '
        + (isContextOnly
          ? 'border-white/5 bg-surface-raised/50 opacity-40 cursor-not-allowed'
          : 'border-white/10 bg-surface-raised cursor-grab hover:-translate-y-0.5 hover:border-primary/50 hover:bg-surface-hover hover:shadow-[0_0_0_1px_rgba(0,240,255,0.25),0_8px_18px_-8px_rgba(0,240,255,0.4)] active:scale-95 active:translate-y-0')
      }
      title={
        isContextOnly
          ? 'Available from a Run (V5.2+)'
          : `${entry.pluginDisplayName}${entry.description ? ` — ${entry.description}` : ''}`
      }
    >
      <TileIcon entry={entry} />
      <div className="text-2xs font-medium leading-tight text-slate-200 truncate w-full">{entry.label}</div>
      {isContextOnly && (
        <span className="material-symbols-outlined absolute top-1 right-1 text-[13px] leading-none text-slate-500" title="Available from a Run (V5.2+)">lock</span>
      )}
    </div>
  )
}

/**
 * Tile glyph. Resolution order:
 *   1. registry-provided icon (manifest `icon`, inlined/served by the host)
 *   2. by-convention web-root asset `/widget-icons/<widgetType>.svg` — lets built-in
 *      widgets show an icon even before a server-bundle rebuild carries their manifest
 *      `icon` through the registry
 *   3. a monogram chip (first letter), if neither image loads
 */
function TileIcon({ entry }: { entry: PaletteWidgetEntry }) {
  const registryIcon = isIconUrl(entry.icon) ? entry.icon : undefined
  const [src, setSrc] = useState<string | undefined>(registryIcon ?? `/widget-icons/${entry.widgetType}.svg`)

  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setSrc(undefined)}
        className="w-8 h-8 rounded-md object-contain transition-transform duration-150 group-hover:scale-110"
      />
    )
  }
  return (
    <span className="w-8 h-8 inline-flex items-center justify-center rounded-md bg-white/5 text-xs font-mono font-semibold text-slate-300 transition-transform duration-150 group-hover:scale-110">
      {entry.label[0]?.toUpperCase()}
    </span>
  )
}

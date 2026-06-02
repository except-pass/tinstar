import { useMemo } from 'react'
import { usePluginWidgetRegistry, type PaletteWidgetEntry } from './usePluginWidgetRegistry'
import { listWidgetRegistrations, type WidgetRegistration } from '../widgets/widgetComponentRegistry'

export interface CatalogEntry {
  /** Widget type string used by the renderer + create endpoints. */
  type: string
  /** Plugin id when this is a plugin widget; undefined for host widgets. */
  pluginId?: string
  label: string
  icon?: string
  defaultSize: { width: number; height: number }
  capabilities: string[]
  creator: 'standalone' | 'session-backed'
}

/** Human labels for host widgets that have no manifest label. */
const HOST_LABELS: Record<string, string> = {
  'run-workspace': 'Run workspace',
}

const DEFAULT_SIZE = { width: 640, height: 480 }

function isSpawnable(caps?: string[]): boolean {
  return Array.isArray(caps) && caps.includes('spawnable')
}

export function mergeCatalog(
  host: WidgetRegistration[],
  plugin: PaletteWidgetEntry[],
): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const r of host) {
    if (r.isContainer || !isSpawnable(r.capabilities)) continue
    out.push({
      type: r.type,
      label: HOST_LABELS[r.type] ?? r.type,
      defaultSize: r.defaultSize ?? DEFAULT_SIZE,
      capabilities: r.capabilities ?? [],
      creator: r.creator ?? 'standalone',
    })
  }
  for (const p of plugin) {
    // A palette-installable plugin widget (spawn: 'palette') is a standalone
    // widget by nature, so it's [+]-spawnable by default — installed plugins
    // (e.g. stretchplan) need not adopt the capability field. An explicit
    // 'spawnable' capability can still opt in a non-palette widget.
    // 'palette+context' widgets (file-editor/image-viewer) stay excluded.
    if (p.spawn !== 'palette' && !isSpawnable(p.capabilities)) continue
    out.push({
      type: p.widgetType,
      pluginId: p.pluginId,
      label: p.label,
      icon: p.icon,
      defaultSize: p.defaultSize ?? DEFAULT_SIZE,
      capabilities: p.capabilities ?? [],
      creator: p.creator ?? 'standalone',
    })
  }
  return out
}

export function useWidgetCatalog(): { entries: CatalogEntry[]; loading: boolean; error: string | null } {
  const { entries: pluginEntries, error } = usePluginWidgetRegistry()
  return useMemo(() => {
    if (pluginEntries === null) {
      // Host widgets are available synchronously. While the plugin list is still
      // in flight (no entries, no error) we're loading; once the fetch fails
      // (error set, entries still null) we're settled on host-only entries —
      // otherwise loading would stay true forever on a failed registry fetch.
      return { entries: mergeCatalog(listWidgetRegistrations(), []), loading: error === null, error }
    }
    return { entries: mergeCatalog(listWidgetRegistrations(), pluginEntries), loading: false, error }
  }, [pluginEntries, error])
}

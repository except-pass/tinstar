import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../apiClient'

export interface PaletteWidgetEntry {
  pluginId: string
  pluginDisplayName: string
  widgetType: string
  label: string
  description?: string
  /** Resolved icon: a URL, web-root path, or data: URI (relative plugin paths are inlined server-side). */
  icon?: string
  defaultSize?: { width: number; height: number }
  singleton: boolean
  spawn: 'palette' | 'palette+context'
  capabilities?: string[]
  creator?: 'standalone' | 'session-backed'
  tags?: string[]
}

export interface UsePluginWidgetRegistryResult {
  entries: PaletteWidgetEntry[] | null
  error: string | null
  /** widgetType → icon, for surfaces (hierarchy, palette) that render a plugin widget's icon. */
  iconByType: Map<string, string>
}

/**
 * Fetch the plugin widget registry (the palette's source of truth) once. Shared by the
 * widgets palette and the hierarchy sidebar so a plugin's icon shows consistently in both.
 */
export function usePluginWidgetRegistry(): UsePluginWidgetRegistryResult {
  const [entries, setEntries] = useState<PaletteWidgetEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/plugin-widgets/registry')
      .then(r => r.json())
      .then((j: { ok: boolean; data?: PaletteWidgetEntry[]; error?: { message: string } }) => {
        if (cancelled) return
        if (j.ok && j.data) setEntries(j.data)
        else setError(j.error?.message ?? 'unknown error')
      })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [])

  const iconByType = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entries ?? []) if (e.icon) m.set(e.widgetType, e.icon)
    return m
  }, [entries])

  return { entries, error, iconByType }
}

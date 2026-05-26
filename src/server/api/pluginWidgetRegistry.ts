import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest, ManifestError } from '../../core/pluginHost/manifest'
import { readPluginsConfig } from '../../core/pluginHost/pluginsConfig'

export interface ResolvedWidgetType {
  pluginId: string
  pluginDisplayName: string
  widgetType: string
  label: string
  description?: string
  icon?: string
  defaultSize?: { width: number; height: number }
  singleton: boolean
  spawn: 'palette' | 'palette+context'
}

let cachedRegistry: ResolvedWidgetType[] | null = null
let cacheStamp = 0
const CACHE_TTL_MS = 5000

export function resolveWidgetRegistry(configRoot: string): ResolvedWidgetType[] {
  if (cachedRegistry && Date.now() - cacheStamp < CACHE_TTL_MS) return cachedRegistry

  const config = readPluginsConfig(configRoot)
  const disabled = new Set(config.disabled)
  const out: ResolvedWidgetType[] = []

  for (const entry of config.external) {
    if (disabled.has(entry.name)) continue
    if (!entry.path) continue  // npm-resolved plugins are V5.1+; skip silently

    let pkgJson: unknown
    try {
      pkgJson = JSON.parse(readFileSync(join(entry.path, 'package.json'), 'utf8'))
    } catch {
      continue  // plugin's package.json missing or malformed; skip
    }

    let parsed
    try {
      parsed = parseManifest(pkgJson)
    } catch (e) {
      if (!(e instanceof ManifestError)) throw e
      continue  // malformed manifest; skip
    }

    const widgets = parsed.manifest.contributes?.widgets ?? []
    for (const w of widgets) {
      out.push({
        pluginId: parsed.name,
        pluginDisplayName: parsed.manifest.displayName,
        widgetType: w.type,
        label: w.label,
        description: w.description,
        icon: w.icon,
        defaultSize: w.defaultSize,
        singleton: w.singleton === true,
        spawn: w.spawn ?? 'palette',
      })
    }
  }

  cachedRegistry = out
  cacheStamp = Date.now()
  return out
}

export function invalidateWidgetRegistryCache(): void {
  cachedRegistry = null
}

import { readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { parseManifest, ManifestError } from '../../core/pluginHost/manifest'
import { readPluginsConfig } from '../../core/pluginHost/pluginsConfig'
import { BUILTIN_PLUGIN_PKGS } from './builtinPluginManifests'

const ICON_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const MAX_INLINE_ICON_BYTES = 256 * 1024

/**
 * Resolve a plugin widget's declared icon into something the browser can render.
 * Absolute URLs, data: URIs, and web-root paths (`/foo.svg`) pass through unchanged.
 * A path relative to the plugin's package.json is read off disk and inlined as a data: URI
 * so external (filesystem) plugins don't have to publish their icon under the host's web root.
 * Returns undefined when the file is missing, unreadable, an unknown type, or too large
 * (the palette then falls back to the label's first letter).
 */
export function resolvePluginIcon(pluginDir: string, icon: string | undefined): string | undefined {
  if (!icon) return undefined
  if (icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:') || icon.startsWith('/')) {
    return icon
  }
  const mime = ICON_MIME[extname(icon).toLowerCase()]
  if (!mime) return undefined
  try {
    const buf = readFileSync(join(pluginDir, icon))
    if (buf.byteLength > MAX_INLINE_ICON_BYTES) return undefined
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

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
  capabilities?: string[]
  creator?: 'standalone' | 'session-backed'
  snappable?: boolean
  tags?: string[]
}

let cachedRegistry: ResolvedWidgetType[] | null = null
let cacheStamp = 0
const CACHE_TTL_MS = 5000

export function resolveWidgetRegistry(configRoot: string): ResolvedWidgetType[] {
  if (cachedRegistry && Date.now() - cacheStamp < CACHE_TTL_MS) return cachedRegistry

  const config = readPluginsConfig(configRoot)
  const disabled = new Set(config.disabled)
  const out: ResolvedWidgetType[] = []

  // Bundled built-in plugins (browser, file-editor, image-viewer, saloon).
  // Their components are loaded on the client via core/pluginHost/bundled.ts;
  // here we list them in the palette like externals. A built-in widget opts
  // into the palette by setting `spawn` explicitly — widgets that omit it stay
  // out (they're spawned via their own affordances, e.g. opening a file), so
  // only deliberately-palette-draggable built-ins (the Saloon) surface.
  for (const pkg of BUILTIN_PLUGIN_PKGS) {
    let parsed
    try {
      parsed = parseManifest(pkg)
    } catch (e) {
      if (!(e instanceof ManifestError)) throw e
      continue
    }
    if (disabled.has(parsed.name)) continue
    for (const w of parsed.manifest.contributes?.widgets ?? []) {
      if (!w.spawn) continue  // built-in opt-in: no spawn → not palette-listed
      out.push({
        pluginId: parsed.name,
        pluginDisplayName: parsed.manifest.displayName,
        widgetType: w.type,
        label: w.label,
        description: w.description,
        icon: resolvePluginIcon('', w.icon),
        defaultSize: w.defaultSize,
        singleton: w.singleton === true,
        spawn: w.spawn,
        capabilities: w.capabilities,
        creator: w.creator,
        snappable: w.snappable,
        tags: w.tags,
      })
    }
  }

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
        icon: resolvePluginIcon(entry.path, w.icon),
        defaultSize: w.defaultSize,
        singleton: w.singleton === true,
        spawn: w.spawn ?? 'palette',
        capabilities: w.capabilities,
        creator: w.creator,
        snappable: w.snappable,
        tags: w.tags,
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

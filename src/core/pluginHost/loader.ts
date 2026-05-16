import { parseManifest, ManifestError } from './manifest'
import type { BundledEntry } from './bundled'
import type { PluginRecord, PluginRegistry } from './registry'
import { createPluginApi } from '../pluginApi/createApi'
import type { PluginsConfig } from './pluginsConfig'
import type { ImportExternalFn } from './externalLoader'

/**
 * Boot every bundled plugin: parse manifest, build a per-plugin API, call
 * activate(). Continues past individual failures and logs them to the console.
 */
export async function bootBundledPlugins(
  bundle: Record<string, BundledEntry>,
  registry: PluginRegistry,
): Promise<void> {
  for (const [key, entry] of Object.entries(bundle)) {
    let parsed
    try {
      parsed = parseManifest(entry.pkg)
    } catch (e) {
      const msg = e instanceof ManifestError ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.error(`[plugin-host] bundled plugin "${key}" rejected: ${msg}`)
      continue
    }

    const record: PluginRecord = {
      name: parsed.name,
      version: parsed.version,
      manifest: parsed.manifest,
      state: 'pending',
      disposables: [],
    }

    try {
      await registry.activate(record, entry.module, createPluginApi)
    } catch (e) {
      // registry.activate's own try/catch handles activate throws; this
      // catches the re-activation guard throw (duplicate plugin name) so the
      // boot loop continues past it instead of aborting.
      const msg = e instanceof Error ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.error(`[plugin-host] activate failed for "${key}": ${msg}`)
    }
  }
}

/**
 * Boot all plugins: bundled (honoring `disabled[]`) then external.
 * Sequential per-plugin so the browser-widget shows up before papershore.
 */
export async function bootAllPlugins(
  bundle: Record<string, BundledEntry>,
  config: PluginsConfig,
  registry: PluginRegistry,
  importExternalFn: ImportExternalFn,
): Promise<void> {
  const disabled = new Set(config.disabled)
  for (const [key, entry] of Object.entries(bundle)) {
    let parsed
    try {
      parsed = parseManifest(entry.pkg)
    } catch (e) {
      const msg = e instanceof ManifestError ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.error(`[plugin-host] bundled plugin "${key}" rejected: ${msg}`)
      continue
    }
    if (disabled.has(parsed.name)) continue
    const record: PluginRecord = {
      name: parsed.name,
      version: parsed.version,
      manifest: parsed.manifest,
      state: 'pending',
      disposables: [],
    }
    try {
      await registry.activate(record, entry.module, createPluginApi)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[plugin-host] activate failed for "${key}": ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const { bootExternalPlugins } = await import('./externalLoader')
  await bootExternalPlugins(config, registry, importExternalFn)
}

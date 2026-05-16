import { parseManifest, ManifestError } from './manifest'
import type { BundledEntry } from './bundled'
import type { PluginRecord, PluginRegistry } from './registry'
import { createPluginApi } from '../pluginApi/createApi'

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

    await registry.activate(record, entry.module, createPluginApi)
  }
}

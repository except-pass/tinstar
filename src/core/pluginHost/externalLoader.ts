import type { Plugin } from '@tinstar/plugin-api'
import { parseManifest, ManifestError } from './manifest'
import type { PluginRegistry, PluginRecord } from './registry'
import { createPluginApi } from '../pluginApi/createApi'
import type { PluginsConfig, ExternalPluginEntry } from './pluginsConfig'
import { apiFetch, apiUrl } from '../../apiClient'

export interface ImportedExternalPlugin {
  module: Plugin
  pkg: unknown
}

export type ImportExternalFn = (entry: ExternalPluginEntry) => Promise<ImportedExternalPlugin>

/**
 * Boot every enabled external plugin from config. `importFn` is injected so
 * tests can stub the dynamic-import path; production uses `defaultImportExternalFn`.
 */
export async function bootExternalPlugins(
  config: PluginsConfig,
  registry: PluginRegistry,
  importFn: ImportExternalFn,
): Promise<void> {
  const disabled = new Set(config.disabled)
  for (const entry of config.external) {
    if (disabled.has(entry.name)) continue

    let imported: ImportedExternalPlugin
    try {
      imported = await importFn(entry)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[plugin-host] external import failed for "${entry.name}":`, e instanceof Error ? e.message : String(e))
      continue
    }

    let parsed
    try {
      parsed = parseManifest(imported.pkg)
    } catch (e) {
      const msg = e instanceof ManifestError ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.error(`[plugin-host] external plugin "${entry.name}" rejected: ${msg}`)
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
      await registry.activate(record, imported.module, createPluginApi)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[plugin-host] external activate failed for "${entry.name}":`, e instanceof Error ? e.message : String(e))
    }
  }
}

/**
 * Production import function. Fetches package.json then dynamic-imports
 * the entry from the served plugin-runtime route.
 */
export const defaultImportExternalFn: ImportExternalFn = async (entry) => {
  if (entry.path) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 10_000)
    try {
      const pkgRes = await apiFetch(`/api/plugin-runtime/local/${entry.name}/package.json`, { signal: ctl.signal })
      if (!pkgRes.ok) throw new Error(`could not fetch package.json: ${pkgRes.status}`)
      const pkg = await pkgRes.json()
      const main = typeof pkg.main === 'string' ? pkg.main : 'index.js'
      const moduleUrl = apiUrl(`/api/plugin-runtime/local/${entry.name}/${main}`)
      // Note: dynamic import() does not respect AbortSignal in any browser as of 2026.
      // We accept that the import itself can hang past the 10s budget. The package.json
      // fetch has the AbortController guarding the first leg.
      const mod = await import(/* @vite-ignore */ moduleUrl) as Plugin
      return { module: mod, pkg }
    } finally {
      clearTimeout(t)
    }
  }
  if (entry.npm) {
    throw new Error('npm externals not yet supported in plan 2')
  }
  throw new Error(`external entry "${entry.name}" has neither path nor npm`)
}

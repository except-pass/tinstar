import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginServerSpec } from '@tinstar/plugin-api'
import { parseManifest, ManifestError } from '../../core/pluginHost/manifest'
import { readPluginsConfig, type PluginsConfig } from '../../core/pluginHost/pluginsConfig'

export interface PluginServerEntry {
  pluginId: string
  displayName: string
  spec: PluginServerSpec
  /** Absolute working dir = join(plugin package dir, spec.cwd ?? '.'). */
  cwd: string
}

export interface PluginServerStatus {
  status: 'up' | 'down' | 'unknown'
  startable: boolean
  checkedAt: number
}

/** Thrown when a start is requested for an unknown plugin or one with no `start` command. */
export class NoStartError extends Error {}

type ReadPkg = (pluginDir: string) => unknown

/** Pure: map a plugins config + a package.json reader into server entries.
 *  External plugins only (the host tracks their dir via plugins.json). */
export function buildServerEntries(config: PluginsConfig, readPkg: ReadPkg): PluginServerEntry[] {
  const disabled = new Set(config.disabled)
  const out: PluginServerEntry[] = []
  for (const entry of config.external) {
    if (disabled.has(entry.name) || !entry.path) continue
    let pkgJson: unknown
    try { pkgJson = readPkg(entry.path) } catch { continue }
    let parsed
    try { parsed = parseManifest(pkgJson) } catch (e) {
      if (!(e instanceof ManifestError)) throw e
      continue
    }
    const spec = parsed.manifest.server
    if (!spec) continue
    out.push({
      pluginId: parsed.name,
      displayName: parsed.manifest.displayName,
      spec,
      cwd: join(entry.path, spec.cwd ?? '.'),
    })
  }
  return out
}

export function resolvePluginServers(configRoot: string): PluginServerEntry[] {
  const config = readPluginsConfig(configRoot)
  return buildServerEntries(config, (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
}


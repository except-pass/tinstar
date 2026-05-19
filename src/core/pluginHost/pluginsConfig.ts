import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ExternalPluginEntry {
  name: string
  path?: string
  npm?: string
}

export interface PluginsConfig {
  disabled: string[]
  external: ExternalPluginEntry[]
}

export function readPluginsConfig(configRoot: string): PluginsConfig {
  const path = join(configRoot, 'plugins.json')
  if (!existsSync(path)) return { disabled: [], external: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[plugin-host] plugins.json malformed at ${path}; using empty config:`, e instanceof Error ? e.message : String(e))
    return { disabled: [], external: [] }
  }
  if (!parsed || typeof parsed !== 'object') return { disabled: [], external: [] }
  const obj = parsed as Record<string, unknown>

  const disabledRaw = obj.disabled
  const disabled = Array.isArray(disabledRaw)
    ? disabledRaw.filter((x): x is string => typeof x === 'string')
    : []

  const externalRaw = obj.external
  const external: ExternalPluginEntry[] = []
  if (Array.isArray(externalRaw)) {
    for (let i = 0; i < externalRaw.length; i++) {
      const e = externalRaw[i]
      if (!e || typeof e !== 'object') {
        // eslint-disable-next-line no-console
        console.warn(`[plugin-host] plugins.json external[${i}] rejected: not an object`)
        continue
      }
      const r = e as Record<string, unknown>
      if (typeof r.name !== 'string' || r.name === '') {
        // eslint-disable-next-line no-console
        console.warn(`[plugin-host] plugins.json external[${i}] rejected: missing or empty 'name'`)
        continue
      }
      const hasPath = typeof r.path === 'string'
      const hasNpm = typeof r.npm === 'string'
      if (!hasPath && !hasNpm) {
        // eslint-disable-next-line no-console
        console.warn(`[plugin-host] plugins.json external[${i}] rejected: needs 'path' or 'npm'`)
        continue
      }
      external.push(r as unknown as ExternalPluginEntry)
    }
  }

  return { disabled, external }
}

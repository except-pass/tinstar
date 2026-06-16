import { exec, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
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

const CACHE_TTL_MS = 4000
const statusCache = new Map<string, PluginServerStatus>()
const inFlight = new Map<string, Promise<'up' | 'down'>>()

/** Run the health command once; exit 0 → 'up', any error (non-zero/timeout) → 'down'. */
export function checkHealthOnce(entry: PluginServerEntry): Promise<'up' | 'down'> {
  return new Promise((resolve) => {
    exec(entry.spec.health, {
      cwd: entry.cwd,
      timeout: entry.spec.healthTimeoutMs ?? 3000,
      windowsHide: true,
    }, (err) => resolve(err ? 'down' : 'up'))
  })
}

async function refreshStatus(entry: PluginServerEntry, now: number): Promise<void> {
  let p = inFlight.get(entry.pluginId)
  if (!p) {
    p = checkHealthOnce(entry)
    inFlight.set(entry.pluginId, p)
    void p.finally(() => inFlight.delete(entry.pluginId))
  }
  const status = await p
  statusCache.set(entry.pluginId, { status, startable: !!entry.spec.start, checkedAt: now })
}

/** Per-plugin backend status. Cached ~4s; concurrent calls share one in-flight probe. */
export async function getStatuses(
  configRoot: string,
  now: number = Date.now(),
): Promise<Record<string, PluginServerStatus>> {
  const entries = resolvePluginServers(configRoot)
  await Promise.all(entries.map((e) => {
    const cached = statusCache.get(e.pluginId)
    if (cached && now - cached.checkedAt < CACHE_TTL_MS) return Promise.resolve()
    return refreshStatus(e, now)
  }))
  const out: Record<string, PluginServerStatus> = {}
  for (const e of entries) {
    out[e.pluginId] = statusCache.get(e.pluginId)
      ?? { status: 'unknown', startable: !!e.spec.start, checkedAt: now }
  }
  return out
}

/** Test-only: clear the module-level status cache. */
export function __resetStatusCacheForTests(): void {
  statusCache.clear()
  inFlight.clear()
}

/** Fire the plugin's start command fire-and-forget; stdout/stderr → a truncated
 *  per-plugin log under <configRoot>/plugin-servers/<id>.log. Returns immediately. */
export function startServer(configRoot: string, pluginId: string): { started: true } {
  const entry = resolvePluginServers(configRoot).find((e) => e.pluginId === pluginId)
  if (!entry) throw new NoStartError(`unknown plugin server: ${pluginId}`)
  if (!entry.spec.start) throw new NoStartError(`plugin ${pluginId} declares no start command`)

  const logDir = join(configRoot, 'plugin-servers')
  mkdirSync(logDir, { recursive: true })
  const fd = openSync(join(logDir, `${pluginId}.log`), 'w') // truncate

  const child = spawn(entry.spec.start, {
    cwd: entry.cwd,
    shell: true,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  child.unref()
  closeSync(fd) // child keeps its own dup; don't leak the parent fd
  statusCache.delete(pluginId) // force a fresh probe on the next poll
  return { started: true }
}

/** Tail of a plugin's start log (most-recent bytes), or '' when absent. */
export function readServerLog(configRoot: string, pluginId: string, maxBytes = 64 * 1024): string {
  try {
    const buf = readFileSync(join(configRoot, 'plugin-servers', `${pluginId}.log`))
    return buf.length > maxBytes ? buf.subarray(buf.length - maxBytes).toString('utf8') : buf.toString('utf8')
  } catch {
    return ''
  }
}

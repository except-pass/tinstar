import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reach persistence — two records, deliberately.
 *
 * The **preference** is the operator's opt-in. The **mapping** is the live
 * provider configuration. Revoke clears the mapping and never the preference:
 * a clean shutdown revokes, and if that also erased the opt-in then reach would
 * silently fail to come back after any restart or reboot — inverting the whole
 * reason for keeping durable state instead of owning a foreground process.
 *
 * Shaped after the local telemetry receiver's state file (versioned payload,
 * write-to-temp-then-rename, 0600) rather than the supervised-child machinery,
 * which assumes a process to own. `tailscale serve` mutates daemon config and
 * exits; there is no pid and no port to supervise.
 */

export const REACH_STATE_VERSION = 1

export interface ReachPreference {
  version: number
  enabled: boolean
  /** Which adapter the operator opted in to. */
  provider: string
}

export interface ReachMapping {
  version: number
  provider: string
  /** Which Tinstar instance owns this mapping — see {@link reachInstanceId}. */
  instanceId: string
  url: string
  /** The port the listener actually bound, not the one that was configured. */
  port: number
  establishedAt: string
}

function reachDir(configRoot: string): string {
  return join(configRoot, 'reach')
}

/**
 * A per-instance discriminator derived from the config root.
 *
 * `TINSTAR_CONFIG_HOME` makes a second backend on one host a supported
 * configuration, so "which instance wrote this" has to be answerable. Without
 * it a rehearsal harness could tear down the primary's mapping and quietly
 * redirect the operator's remote URL at itself.
 */
export function reachInstanceId(configRoot: string): string {
  return createHash('sha256').update(configRoot).digest('hex').slice(0, 16)
}

function readRecord<T extends { version: number }>(path: string): T | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as T
    // A record from a future version is not ours to interpret. Treating it as
    // absent is safe here: the worst case is re-establishing a mapping.
    if (!parsed || typeof parsed !== 'object' || parsed.version !== REACH_STATE_VERSION) {
      return null
    }
    return parsed
  } catch {
    // Missing, unreadable, or corrupt — all "no state", never a boot failure.
    return null
  }
}

function writeRecord(path: string, payload: object): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 })
  renameSync(temporary, path)
}

export function readReachPreference(configRoot: string): ReachPreference | null {
  const record = readRecord<ReachPreference>(join(reachDir(configRoot), 'preference.json'))
  return record && typeof record.enabled === 'boolean' ? record : null
}

export function writeReachPreference(
  configRoot: string,
  preference: Omit<ReachPreference, 'version'>,
): void {
  writeRecord(join(reachDir(configRoot), 'preference.json'), {
    version: REACH_STATE_VERSION,
    ...preference,
  })
}

export function readReachMapping(configRoot: string): ReachMapping | null {
  const record = readRecord<ReachMapping>(join(reachDir(configRoot), 'mapping.json'))
  return record && typeof record.url === 'string' && typeof record.port === 'number'
    ? record
    : null
}

export function writeReachMapping(
  configRoot: string,
  mapping: Omit<ReachMapping, 'version'>,
): void {
  writeRecord(join(reachDir(configRoot), 'mapping.json'), {
    version: REACH_STATE_VERSION,
    ...mapping,
  })
}

export function clearReachMapping(configRoot: string): void {
  rmSync(join(reachDir(configRoot), 'mapping.json'), { force: true })
}

export function mappingIsOurs(
  mapping: ReachMapping | null,
  instanceId: string,
): boolean {
  return mapping?.instanceId === instanceId
}

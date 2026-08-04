import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

let cachedLinuxBootId: string | null = null

export type ProcessLiveness =
  | { state: 'alive' }
  | { state: 'gone' }
  | { state: 'invalid'; reason: string }
  | { state: 'unknown'; code?: string; reason: string }

/** Node's process APIs require a positive signed 32-bit integer PID. */
export function isSupportedProcessId(pid: unknown): pid is number {
  return typeof pid === 'number'
    && Number.isSafeInteger(pid)
    && pid > 0
    && pid <= 0x7fff_ffff
}

function describeProcessId(pid: unknown): string {
  try {
    return String(pid)
  } catch {
    return '<unprintable>'
  }
}

/**
 * Probe without signalling. ESRCH is the only proof that a process is gone;
 * permission and unexpected OS errors remain unknown so ownership gates fail
 * closed instead of starting a competing process.
 */
export function probeProcessLiveness(pid: unknown): ProcessLiveness {
  if (!isSupportedProcessId(pid)) {
    return { state: 'invalid', reason: `unsupported process id ${describeProcessId(pid)}` }
  }
  try {
    process.kill(pid, 0)
    return { state: 'alive' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code
    if (code === 'ESRCH') return { state: 'gone' }
    return {
      state: 'unknown',
      ...(code ? { code } : {}),
      reason: code ? `process probe failed with ${code}` : 'process probe failed without an OS error code',
    }
  }
}

export function processMayBeAlive(pid: number): boolean {
  const state = probeProcessLiveness(pid).state
  return state === 'alive' || state === 'unknown'
}

/** Parse Linux procfs identity data; starttime is field 22 in `/proc/<pid>/stat`. */
export function linuxProcessIdentity(stat: string, bootId: string): string | null {
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0) return null
  // The remainder begins at field 3 (`state`), so field 22 (`starttime`)
  // appears at zero-based index 19. `lastIndexOf` handles `)` inside comm.
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/)
  const startTicks = fields[19]
  const boot = bootId.trim()
  return startTicks && boot ? `linux:${boot}:${startTicks}` : null
}

export type ProcessIdentityComparison = 'same' | 'different' | 'legacy-unscoped'

/**
 * Compare identities without treating pre-boot-id Linux tokens as proof of
 * replacement. The mixed-version comparison is symmetric for durable records
 * inspected during upgrades or rollbacks, even though this reader emits only
 * boot-scoped Linux identities.
 */
export function compareProcessIdentity(
  recorded: string,
  current: string,
): ProcessIdentityComparison {
  if (recorded === current) return 'same'
  const recordedLegacy = /^linux:([^:]+)$/u.exec(recorded)
  const currentLegacy = /^linux:([^:]+)$/u.exec(current)
  const recordedBootScoped = /^linux:[^:]+:([^:]+)$/u.exec(recorded)
  const currentBootScoped = /^linux:[^:]+:([^:]+)$/u.exec(current)
  const legacyTicks = recordedLegacy?.[1] ?? currentLegacy?.[1]
  const bootScopedTicks = recordedBootScoped?.[1] ?? currentBootScoped?.[1]
  if (legacyTicks && bootScopedTicks) {
    return legacyTicks === bootScopedTicks ? 'legacy-unscoped' : 'different'
  }
  return 'different'
}

/**
 * Best-effort identity for one OS process lifetime. A PID can be reused, so a
 * durable lock records this token and compares it before treating EPERM as a
 * live owner. Missing platform evidence remains unknown and therefore fails
 * closed.
 */
export function processIdentity(pid: number): string | null {
  if (!isSupportedProcessId(pid)) return null
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const bootId = cachedLinuxBootId
        ?? readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim()
      cachedLinuxBootId = bootId
      return linuxProcessIdentity(stat, bootId)
    } catch {
      return null
    }
  }
  if (process.platform === 'darwin') {
    try {
      const started = execFileSync(
        'ps',
        ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf-8' },
      ).trim()
      return started ? `darwin:${started}` : null
    } catch {
      return null
    }
  }
  return null
}

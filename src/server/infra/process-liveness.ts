import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      const startTicks = fields[19]
      return startTicks ? `linux:${startTicks}` : null
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

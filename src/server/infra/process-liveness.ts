export type ProcessLiveness =
  | { state: 'alive' }
  | { state: 'gone' }
  | { state: 'invalid'; reason: string }
  | { state: 'unknown'; reason: string }

/** Node's process APIs require a positive signed 32-bit integer PID. */
export function isSupportedProcessId(pid: unknown): pid is number {
  return typeof pid === 'number'
    && Number.isSafeInteger(pid)
    && pid > 0
    && pid <= 0x7fff_ffff
}

/**
 * Probe without signalling. ESRCH is the only proof that a process is gone;
 * permission and unexpected OS errors remain unknown so ownership gates fail
 * closed instead of starting a competing process.
 */
export function probeProcessLiveness(pid: number): ProcessLiveness {
  if (!isSupportedProcessId(pid)) {
    return { state: 'invalid', reason: `unsupported process id ${pid}` }
  }
  try {
    process.kill(pid, 0)
    return { state: 'alive' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code
    if (code === 'ESRCH') return { state: 'gone' }
    return {
      state: 'unknown',
      reason: code ? `process probe failed with ${code}` : 'process probe failed without an OS error code',
    }
  }
}

export function processMayBeAlive(pid: number): boolean {
  const state = probeProcessLiveness(pid).state
  return state === 'alive' || state === 'unknown'
}

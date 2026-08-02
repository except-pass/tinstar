export type ProcessLiveness =
  | { state: 'alive' }
  | { state: 'gone' }
  | { state: 'unknown'; reason: string }

/**
 * Probe without signalling. ESRCH is the only proof that a process is gone;
 * permission and unexpected OS errors remain unknown so ownership gates fail
 * closed instead of starting a competing process.
 */
export function probeProcessLiveness(pid: number): ProcessLiveness {
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
  return probeProcessLiveness(pid).state !== 'gone'
}

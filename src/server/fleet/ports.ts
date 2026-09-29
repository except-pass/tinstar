import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { LOOPBACK_BIND_ADDRESS } from '../bind'
import { TTYD_MIN_VERSION, compareVersions, parseVersionTriplet } from '../externalFloors'
import { TERMINAL_AUTH_HEADER, TERMINAL_AUTH_VALUE } from '../sessionProxy'
import type { PortWindow } from './config'

const claimed = new Set<number>()

export async function findPort(window: PortWindow): Promise<number> {
  if (!Number.isInteger(window.start) || !Number.isInteger(window.count) || window.count < 1
    || window.start < 1024 || window.start + window.count - 1 > 65535) {
    throw new Error(`Invalid port window "${window.label}"`)
  }
  for (let port = window.start; port < window.start + window.count; port++) {
    if (claimed.has(port)) continue
    const free = await new Promise<boolean>(resolve => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, LOOPBACK_BIND_ADDRESS, () => server.close(() => resolve(true)))
    })
    if (free) { claimed.add(port); return port }
  }
  throw new Error(`No available port found in window "${window.label}"`)
}

export function releasePort(port: number): void { claimed.delete(port) }
export function terminalBindAddress(): string { return LOOPBACK_BIND_ADDRESS }

export async function healthCheck(port: number, opts: { timeout?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeout ?? 5000)
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${port}/`, {
        headers: { [TERMINAL_AUTH_HEADER]: TERMINAL_AUTH_VALUE },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
      if (response.ok) return true
    } catch { /* ttyd is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

/** Older ttyd silently ignores its bind and auth flags, exposing the terminal. */
export function ttydVersionRefusalNow(): string | null {
  let output: string | null = null
  try { output = execFileSync('ttyd', ['--version'], { encoding: 'utf8', timeout: 5000 }) } catch { /* unavailable */ }
  const version = parseVersionTriplet(output ?? '')
  if (!version || compareVersions(version, TTYD_MIN_VERSION) < 0) {
    return `ttyd ${TTYD_MIN_VERSION} or newer is required for terminal bind and auth headers`
  }
  return null
}

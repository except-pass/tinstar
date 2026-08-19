import { join } from 'node:path'

/** Stable per-session channel-server control socket path. */
export function natsControlSocketPath(sessionName: string): string {
  return `/tmp/tinstar-nats-${sessionName}.sock`
}

/** Private per-session owner state; never place trusted PID records in shared /tmp. */
export function natsOwnerLockPath(sessionsDir: string, sessionName: string): string {
  return join(sessionsDir, sessionName, 'nats-mcp-owner')
}

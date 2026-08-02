/** Stable per-session channel-server control socket path. */
export function natsControlSocketPath(sessionName: string): string {
  return `/tmp/tinstar-nats-${sessionName}.sock`
}

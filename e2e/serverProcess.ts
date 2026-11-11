import type { ChildProcess } from 'node:child_process'

// Callers launch Node directly (--import tsx), so close means the backend has
// finished shutdown and can no longer write into the fixture directory.
export async function stopServer(server: ChildProcess | null): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return
  const closed = new Promise<void>(resolve => server.once('close', () => resolve()))
  server.kill('SIGTERM')
  await closed
}

import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

// Callers launch Node directly (--import tsx), so close means the backend has
// finished shutdown and can no longer write into the fixture directory.
export async function stopServer(server: ChildProcess | null): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return
  const closed = new Promise<void>(resolve => server.once('close', () => resolve()))
  server.kill('SIGTERM')
  await closed
}

// The backend can fall back to another port after EADDRINUSE. Its private
// config directory publishes the actual listener before any fixture requests.
export async function serverBase(config: string): Promise<string> {
  let port = ''
  await expect.poll(async () => {
    try { port = await readFile(join(config, 'server.port'), 'utf8') }
    catch { return false }
    return Number(port) > 0
  }, { timeout: 20_000 }).toBe(true)
  return `http://127.0.0.1:${port}`
}

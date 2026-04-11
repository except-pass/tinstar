import { execSync } from 'node:child_process'
import { cpus } from 'node:os'

export default async function globalTeardown() {
  const numWorkers = process.env.TEST_WORKERS ? parseInt(process.env.TEST_WORKERS) : cpus().length
  for (let i = 0; i < numWorkers; i++) {
    const port = 5290 + i
    try { execSync(`lsof -ti tcp:${port} | xargs kill -TERM`, { stdio: 'ignore' }) } catch { /* port free */ }
  }
  // Give SIGTERM a moment, then force-kill any survivors
  await new Promise(r => setTimeout(r, 1_000))
  for (let i = 0; i < numWorkers; i++) {
    const port = 5290 + i
    try { execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: 'ignore' }) } catch { /* clean */ }
  }
}

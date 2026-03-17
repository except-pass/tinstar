import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cpus } from 'node:os'

export default async function globalSetup() {
  const numWorkers = process.env.TEST_WORKERS ? parseInt(process.env.TEST_WORKERS) : cpus().length
  for (let i = 0; i < numWorkers; i++) {
    const port = 5290 + i
    try { execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: 'ignore' }) } catch { /* port free */ }
  }

  const indexHtml = join(process.cwd(), 'dist/client/index.html')
  if (process.env.SKIP_BUILD === '1' && existsSync(indexHtml)) {
    console.log('[global-setup] Skipping build (SKIP_BUILD=1 and dist/client exists)')
    return
  }
  execSync('npx vite build --outDir dist/client', { stdio: 'inherit' })
}

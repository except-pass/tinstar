import { test as base, type BrowserContext, type Page, type WorkerInfo } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_PORT = 5290

export const test = base.extend<
  { context: BrowserContext; page: Page },
  { serverUrl: string }
>({
  serverUrl: [
    async ({}, use, workerInfo: WorkerInfo) => {
      const workerIndex = workerInfo.workerIndex
      const port = BASE_PORT + workerIndex
      const dataDir = join(tmpdir(), `tinstar-w${workerIndex}-${Date.now()}`)
      const child = spawn('npx', ['tsx', 'src/server/standalone.ts'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          TINSTAR_FAST_SIM: '1',
          TINSTAR_NO_SESSIONS: '1',
          TINSTAR_NO_PORT_FALLBACK: '1',
          TINSTAR_BACKEND_PORT: String(port),
          TINSTAR_DATA_DIR: dataDir,
        },
        stdio: 'ignore',
      })

      // Poll until ready
      const url = `http://localhost:${port}`
      const deadline = Date.now() + 10_000
      let ready = false
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${url}/api/state`)
          if (r.ok) { ready = true; break }
        } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 100))
      }
      if (!ready) {
        child.kill('SIGTERM')
        throw new Error(`Worker ${workerIndex} backend on port ${port} failed to start within 10s`)
      }

      await use(url)

      // Graceful shutdown — wait up to 3s, then force-kill
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const fallback = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 3_000)
        child.on('exit', () => { clearTimeout(fallback); resolve() })
      })
      await rm(dataDir, { recursive: true, force: true })
    },
    { scope: 'worker' },
  ],

  context: async ({ browser, serverUrl }, use) => {
    const ctx = await browser.newContext({ baseURL: serverUrl })
    await use(ctx)
    await ctx.close()
  },

  page: async ({ context }, use) => {
    await use(await context.newPage())
  },
})

/**
 * Plugin-aware test fixture: spawns a tinstar server WITH sessions enabled so
 * that ctx.sessionConfig?.dirs.root is populated. This is required for the
 * /api/plugin-widgets/registry route to return plugin-contributed widget types.
 *
 * Uses a port range offset by 100 from the main serverUrl fixture to avoid
 * conflicts when both fixtures are active in the same worker.
 */
const PLUGIN_PORT_OFFSET = 100

export const pluginTest = base.extend<
  { context: BrowserContext; page: Page },
  { serverUrl: string }
>({
  serverUrl: [
    async ({}, use, workerInfo: WorkerInfo) => {
      const workerIndex = workerInfo.workerIndex
      const port = BASE_PORT + PLUGIN_PORT_OFFSET + workerIndex
      const dataDir = join(tmpdir(), `tinstar-pw${workerIndex}-${Date.now()}`)
      const child = spawn('npx', ['tsx', 'src/server/standalone.ts'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          TINSTAR_FAST_SIM: '1',
          // NOTE: TINSTAR_NO_SESSIONS intentionally NOT set — sessions must be
          // enabled so sessionConfig is populated and the widget registry route
          // resolves configRoot from sessionConfig.dirs.root.
          TINSTAR_NO_PORT_FALLBACK: '1',
          TINSTAR_BACKEND_PORT: String(port),
          TINSTAR_DATA_DIR: dataDir,
        },
        stdio: 'ignore',
      })

      // Poll until ready
      const url = `http://localhost:${port}`
      const deadline = Date.now() + 15_000
      let ready = false
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${url}/api/state`)
          if (r.ok) { ready = true; break }
        } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 100))
      }
      if (!ready) {
        child.kill('SIGTERM')
        throw new Error(`Worker ${workerIndex} plugin backend on port ${port} failed to start within 15s`)
      }

      await use(url)

      // Graceful shutdown — wait up to 3s, then force-kill
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const fallback = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 3_000)
        child.on('exit', () => { clearTimeout(fallback); resolve() })
      })
      await rm(dataDir, { recursive: true, force: true })
    },
    { scope: 'worker' },
  ],

  context: async ({ browser, serverUrl }, use) => {
    const ctx = await browser.newContext({ baseURL: serverUrl })
    await use(ctx)
    await ctx.close()
  },

  page: async ({ context }, use) => {
    await use(await context.newPage())
  },
})

export { expect } from '@playwright/test'
export type { Page, Locator } from '@playwright/test'

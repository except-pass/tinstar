import { test as base, expect, type BrowserContext, type Page, type WorkerInfo } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { rm } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Custom fixture: clean server with sessions enabled, no fast-sim, no default
// space.  We need sessions enabled so POST /api/sessions works for the final
// step.  TINSTAR_NO_DEFAULT_SPACE=1 prevents the auto-created "Work Space" that
// would skip the workspace onboarding step.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ONBOARDING_BASE_PORT = 5285  // avoid colliding with fixtures.ts BASE_PORT=5290

/** Kill every process bound to `port` and wait until the port is free. */
function killPort(port: number) {
  try { execSync(`lsof -ti tcp:${port} | xargs kill -TERM`, { stdio: 'ignore' }) } catch { /* already free */ }
  // Give SIGTERM 1s then force-kill
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    try {
      execSync(`lsof -ti tcp:${port}`, { stdio: 'ignore' })
    } catch {
      return // port is free
    }
  }
  try { execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: 'ignore' }) } catch { /* best effort */ }
}

const test = base.extend<
  { context: BrowserContext; page: Page },
  { serverUrl: string }
>({
  serverUrl: [
    async ({}, use, workerInfo: WorkerInfo) => {
      const workerIndex = workerInfo.workerIndex
      const port = ONBOARDING_BASE_PORT + workerIndex

      // Pre-clean: kill any stale process on our port and tmux sessions from prior runs
      killPort(port)
      try {
        const sessions = execSync('tmux ls -F "#{session_name}"', { encoding: 'utf-8' }).trim().split('\n')
        for (const name of sessions) {
          if (name.startsWith('tinstar-e2e-')) {
            try { execSync(`tmux kill-session -t ${name}`, { stdio: 'ignore' }) } catch { /* already gone */ }
          }
        }
      } catch { /* no tmux sessions */ }

      const dataDir = join(tmpdir(), `tinstar-onboarding-w${workerIndex}-${Date.now()}`)
      const child = spawn('npx', ['tsx', 'src/server/standalone.ts'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          // No TINSTAR_FAST_SIM — we need a fresh state with no sim space
          TINSTAR_NO_DEFAULT_SPACE: '1',   // prevent "Work Space" auto-creation
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
        await new Promise(r => setTimeout(r, 150))
      }
      if (!ready) {
        child.kill('SIGTERM')
        throw new Error(`Onboarding test backend on port ${port} failed to start within 15s`)
      }

      await use(url)

      // Graceful shutdown — kill main process, then sweep the port for orphans
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const fallback = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 3_000)
        child.on('exit', () => { clearTimeout(fallback); resolve() })
      })
      killPort(port)
      // Kill any lingering tmux sessions created by this test run
      try {
        const sessions = execSync('tmux ls -F "#{session_name}"', { encoding: 'utf-8' }).trim().split('\n')
        for (const name of sessions) {
          if (name.startsWith('tinstar-e2e-')) {
            try { execSync(`tmux kill-session -t ${name}`, { stdio: 'ignore' }) } catch { /* already gone */ }
          }
        }
      } catch { /* no tmux sessions */ }
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

test('guides a fresh user through workspace + project + session', async ({ page }) => {
  await page.goto('/')

  // Browser mode: connect step is invisibly satisfied (page loaded ⇒ backend reachable).
  // Workspace step active first — no spaces exist on a clean boot.
  await expect(page.getByTestId('onboarding-step-workspace')).toHaveAttribute('data-status', 'active', { timeout: 10000 })

  // --- Step 1: Create workspace ---
  await page.getByTestId('workspace-name-input').fill('e2e-onboarding')
  await page.getByTestId('workspace-create').click()

  // Project step active
  await expect(page.getByTestId('onboarding-step-project')).toHaveAttribute('data-status', 'active', { timeout: 10000 })

  // --- Step 2: Register project ---
  await page.getByTestId('project-name-input').fill('e2e-proj')
  await page.getByTestId('project-path-input').fill(repoRoot)
  await page.getByTestId('project-register').click()

  // First session step active (server emits projects_changed SSE → hook re-fetches)
  await expect(page.getByTestId('onboarding-step-first_session')).toHaveAttribute('data-status', 'active', { timeout: 10000 })

  // --- Step 3: Start first session ---
  // Use a timestamp-suffixed name to avoid collisions with lingering tmux sessions
  // from previous test runs (tmux sessions persist across server restarts).
  const sessionName = `e2e-first-${Date.now()}`
  await page.getByTestId('session-name-input').fill(sessionName)

  // Verify Start button is enabled (project should be populated from /api/projects)
  await expect(page.getByTestId('session-start')).toBeEnabled({ timeout: 5000 })
  await page.getByTestId('session-start').click()

  // After session create, the server emits an SSE delta with the new run.
  // useOnboardingState re-evaluates: active becomes null ⇒ OnboardingCanvas is
  // replaced by the main workspace shell.  The step cards disappear.
  await expect(page.getByTestId('onboarding-step-first_session')).toHaveCount(0, { timeout: 20000 })
})

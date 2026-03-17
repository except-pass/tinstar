# Parallel E2E Tests — Per-Worker Server Instances

**Date:** 2026-03-17
**Status:** Approved

## Overview

Replace the single shared simulator backend with per-worker isolated backend instances so Playwright can run tests fully in parallel. The current `workers: 1` / `fullyParallel: false` constraint exists solely because all tests share one backend — one test's `/api/simulator/reset` would corrupt another's state mid-run. This design eliminates that constraint.

Target: reduce a 30-minute serial suite to ~3 minutes on a typical multi-core machine.

## Architecture

```
globalSetup: kill orphaned ports, vite build → dist/client   (once, shared read-only)

Worker 0:  tsx src/server/standalone.ts  PORT=5290  DATADIR=/tmp/tinstar-w0-...
Worker 1:  tsx src/server/standalone.ts  PORT=5291  DATADIR=/tmp/tinstar-w1-...
Worker 2:  tsx src/server/standalone.ts  PORT=5292  DATADIR=/tmp/tinstar-w2-...
  ...N workers, one per CPU core by default
```

Each worker owns one backend process on a deterministic port, serves API + static files from shared `dist/client`, gets a fresh `TINSTAR_DATA_DIR` deleted in teardown, starts with `TINSTAR_FAST_SIM=1`.

**Port formula:** `5290 + workerIndex`
**Worker count:** `cpus().length` by default, `TEST_WORKERS=N` to override — same formula used in both `playwright.config.ts` and `global-setup.ts`

**`TINSTAR_DATA_DIR` is confirmed:** `src/server/index.ts` (line 81) passes it to session config; `src/server/logger.ts` and `src/server/sessions/skill-drafts.ts` use it as a data root. Setting a unique value per worker gives full storage isolation.

## Required Change to `src/server/standalone.ts`

`standalone.ts` currently auto-increments the port on `EADDRINUSE` (line 151). When `TINSTAR_NO_PORT_FALLBACK=1` is set, replace the retry with `process.exit(1)` and a descriptive stderr message so port collisions produce loud failures rather than silent mis-routing to a wrong server:

```ts
server.once('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    if (process.env.TINSTAR_NO_PORT_FALLBACK === '1') {
      process.stderr.write(`[standalone] Port ${port} in use and TINSTAR_NO_PORT_FALLBACK=1 — exiting\n`)
      process.exit(1)
    }
    log.warn('server', `port ${port} in use, trying ${port + 1}`)
    listen(port + 1)
  } else {
    throw err
  }
})
```

## Files

### New: `e2e/global-setup.ts`

Runs once before any worker starts. Kills orphaned backends on the same port range the workers will use (same formula: `cpus().length` or `TEST_WORKERS`), then builds the frontend.

```ts
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
```

### New: `e2e/fixtures.ts`

Exports `test` and `expect` as the single import target for all spec files. Also re-exports `type Page` and `type Locator` from `@playwright/test` to consolidate imports.

**Worker fixture — `serverUrl` (worker-scoped):**

1. Explicitly declare `workerIndex` as a fixture dependency (Playwright built-in — must be listed or it won't be injected)
2. Derive port: `5290 + workerIndex`
3. Create isolated data dir: `join(tmpdir(), 'tinstar-w' + workerIndex + '-' + Date.now())`
4. Spawn `tsx src/server/standalone.ts` with `cwd: repoRoot` (resolve from fixture file's `__dirname`) and env:
   - `TINSTAR_FAST_SIM=1`
   - `TINSTAR_NO_SESSIONS=1`
   - `TINSTAR_NO_PORT_FALLBACK=1`
   - `TINSTAR_BACKEND_PORT=<port>`
   - `TINSTAR_DATA_DIR=<dataDir>`
5. Poll `GET /api/state` at 100ms intervals up to 10s. On timeout: SIGTERM child, throw with port number in message.
6. `await use('http://localhost:<port>')`
7. Teardown (worker-scoped — runs after all test-scoped fixtures close, so page/context are already closed before SIGTERM): SIGTERM child, `rm -rf dataDir`

**Fixture overrides — `context` and `page`:**

Overriding only `context` does not cascade to the built-in `page` — both must be overridden:

```ts
context: async ({ browser, serverUrl }, use) => {
  const ctx = await browser.newContext({ baseURL: serverUrl })
  await use(ctx)
  await ctx.close()
},

page: async ({ context }, use) => {
  const page = await context.newPage()
  await use(page)
  // no explicit close — context.close() cleans it up when context fixture tears down
},
```

**Teardown ordering:** Playwright tears down test-scoped fixtures (`page`, `context`) before worker-scoped fixtures (`serverUrl`). Traces, screenshots, and artifact capture happen before `context` closes. The backend receives SIGTERM only after `context.close()` has completed — no network-in-flight risk.

**Complete fixture shape:**

```ts
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_PORT = 5290

export const test = base.extend<
  { context: BrowserContext; page: Page },
  { serverUrl: string }
>({
  serverUrl: [
    async ({ workerIndex }, use) => {
      const port = BASE_PORT + workerIndex
      const dataDir = join(tmpdir(), `tinstar-w${workerIndex}-${Date.now()}`)
      const child = spawn('npx', ['tsx', 'src/server/standalone.ts'], {
        cwd: repoRoot,
        env: { ...process.env, TINSTAR_FAST_SIM: '1', TINSTAR_NO_SESSIONS: '1',
               TINSTAR_NO_PORT_FALLBACK: '1', TINSTAR_BACKEND_PORT: String(port),
               TINSTAR_DATA_DIR: dataDir },
        stdio: 'ignore',
      })
      // Poll until ready
      const url = `http://localhost:${port}`
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        try { const r = await fetch(`${url}/api/state`); if (r.ok) break } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 100))
      }
      // (throw if deadline exceeded — implementation detail)

      await use(url)

      child.kill('SIGTERM')
      await fs.rm(dataDir, { recursive: true, force: true })
    },
    { scope: 'worker' }
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
```

### Modified: `playwright.config.ts`

```ts
import { cpus } from 'node:os'

export default defineConfig({
  testDir: './e2e',
  workers: process.env.TEST_WORKERS ? parseInt(process.env.TEST_WORKERS) : cpus().length,
  fullyParallel: true,
  retries: 1,
  timeout: 30000,
  globalSetup: './e2e/global-setup.ts',
  use: {
    trace: 'on-first-retry',
    // baseURL omitted — context fixture sets it per worker
  },
  // webServer block removed — tests manage their own servers
})
```

### Modified: all 17 `e2e/*.spec.ts` files

Change the import line. Files that import `type Page` or `type Locator` consolidate into a single import:

```ts
// Before
import { test, expect } from '@playwright/test'
import type { Page, Locator } from '@playwright/test'  // present in some files

// After — single import
import { test, expect, type Page, type Locator } from './fixtures'
```

**Migration lint check:** After updating, run `grep -r "from '@playwright/test'" e2e/` — any remaining hits (except `import.meta` or similar) indicate a missed file where `page.goto('/')` will fail with no server.

### `e2e/helpers.ts`

No changes. Every `beforeEach` calls `page.goto('/')` before `resetAndWaitForData()`, so the relative `fetch('/api/...')` in `page.evaluate` always resolves against a navigated origin. Optional: reduce `waitForTimeout(500)` to `200ms`.

## Behavioral Changes

**Serial mode + retries:** `entity-crud.spec.ts` uses `test.describe.configure({ mode: 'serial' })` at file scope — Playwright assigns the whole file to one worker. On retry, the entire file reruns from its first test on the same worker. The `beforeEach` reset guarantees clean state for each attempt; the time cost is roughly double that worker's baseline runtime.

**No hot reload during tests:** Source changes require a new `npm run test:e2e`. Use `SKIP_BUILD=1` when only test code changed.

## Expected Outcome

| | Before | After |
|---|---|---|
| Workers | 1 | `cpus().length` (e.g. 8) |
| Test execution | serial | fully parallel |
| Dev server affected | yes | no |
| Estimated runtime | ~30 min | ~15s build + ~2 min tests |

`SKIP_BUILD=1 npx playwright test` skips the build for fast test-code iteration.

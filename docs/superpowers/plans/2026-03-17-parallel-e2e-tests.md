# Parallel E2E Tests Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the E2E suite run fully in parallel by giving each Playwright worker its own isolated backend server, cutting runtime from ~30 minutes to ~2-3 minutes.

**Architecture:** Each Playwright worker spawns a dedicated `tsx src/server/standalone.ts` process on a unique port (`5290 + workerIndex`), with its own isolated `TINSTAR_DATA_DIR`. A one-time `globalSetup` kills any orphaned servers from previous runs and builds the frontend. Tests import `test`/`expect` from a new `e2e/fixtures.ts` instead of `@playwright/test`.

**Tech Stack:** Playwright fixtures (worker-scoped), Node `child_process.spawn`, Vite build, TypeScript

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Create | `tsconfig.e2e.json` | TypeScript config covering `e2e/` so `tsc --noEmit` validates it |
| Modify | `tsconfig.json` | Add reference to `tsconfig.e2e.json` |
| Modify | `src/server/standalone.ts` | Add `TINSTAR_NO_PORT_FALLBACK=1` support — exit instead of auto-increment |
| Create | `e2e/global-setup.ts` | Kill orphaned ports 5290–529N, build frontend to `dist/client` |
| Create | `e2e/fixtures.ts` | Worker fixture (spawns backend), context + page overrides, re-exports |
| Modify | `playwright.config.ts` | Remove `webServer`, set `workers: cpus()`, `fullyParallel: true`, `globalSetup` |
| Modify | `e2e/*.spec.ts` (17 files) | Change import from `@playwright/test` to `./fixtures` |

`e2e/helpers.ts` — no changes needed.

---

## Task 1: Add `tsconfig.e2e.json` so e2e files are type-checked

The `e2e/` directory is not included in any existing tsconfig (`tsconfig.app.json` covers `src/`, `tsconfig.node.json` covers only `vite.config.ts` and `tailwind.config.ts`). Without this, `npx tsc --noEmit` silently skips all e2e files — type errors in `fixtures.ts` or `global-setup.ts` go undetected.

**Files:**
- Create: `tsconfig.e2e.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Create `tsconfig.e2e.json`**

  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "lib": ["ES2023", "DOM"],
      "types": ["node"],
      "module": "ESNext",
      "skipLibCheck": true,
      "moduleResolution": "bundler",
      "allowImportingTsExtensions": true,
      "isolatedModules": true,
      "moduleDetection": "force",
      "noEmit": true,
      "strict": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "noFallthroughCasesInSwitch": true,
      "noUncheckedIndexedAccess": true
    },
    "include": ["e2e/**"]
  }
  ```

- [ ] **Step 2: Add it to `tsconfig.json` references**

  `tsconfig.json` currently looks like:
  ```json
  {
    "files": [],
    "references": [
      { "path": "./tsconfig.app.json" },
      { "path": "./tsconfig.node.json" }
    ]
  }
  ```

  Add the e2e reference:
  ```json
  {
    "files": [],
    "references": [
      { "path": "./tsconfig.app.json" },
      { "path": "./tsconfig.node.json" },
      { "path": "./tsconfig.e2e.json" }
    ]
  }
  ```

- [ ] **Step 3: Verify tsc picks up e2e files**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors. (The existing `e2e/helpers.ts` and spec files should type-check cleanly against their existing `@playwright/test` imports.)

- [ ] **Step 4: Commit**

  ```bash
  git add tsconfig.e2e.json tsconfig.json
  git commit -m "build: add tsconfig.e2e.json so e2e files are covered by tsc --noEmit"
  ```

---

## Task 2: Patch `standalone.ts` — no-fallback port mode

**Files:**
- Modify: `src/server/standalone.ts` (the `EADDRINUSE` handler inside the `listen` function, around line 151)

- [ ] **Step 1: Read the current EADDRINUSE handler**

  Open `src/server/standalone.ts`. Find the `server.once('error', ...)` block. It currently reads:
  ```ts
  if (err.code === 'EADDRINUSE') {
    log.warn('server', `port ${port} in use, trying ${port + 1}`)
    console.log(`  Port ${port} in use, trying ${port + 1}...`)
    listen(port + 1)
  } else {
    throw err
  }
  ```

- [ ] **Step 2: Add the no-fallback branch before the existing log lines**

  ```ts
  if (err.code === 'EADDRINUSE') {
    if (process.env.TINSTAR_NO_PORT_FALLBACK === '1') {
      process.stderr.write(`[standalone] Port ${port} in use and TINSTAR_NO_PORT_FALLBACK=1 — exiting\n`)
      process.exit(1)
    }
    log.warn('server', `port ${port} in use, trying ${port + 1}`)
    console.log(`  Port ${port} in use, trying ${port + 1}...`)
    listen(port + 1)
  } else {
    throw err
  }
  ```

- [ ] **Step 3: Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/server/standalone.ts
  git commit -m "feat: TINSTAR_NO_PORT_FALLBACK=1 exits on port conflict instead of auto-incrementing"
  ```

---

## Task 3: Create `e2e/global-setup.ts`

**Files:**
- Create: `e2e/global-setup.ts`

- [ ] **Step 1: Create the file**

  ```ts
  // e2e/global-setup.ts
  import { execSync } from 'node:child_process'
  import { existsSync } from 'node:fs'
  import { join } from 'node:path'
  import { cpus } from 'node:os'

  export default async function globalSetup() {
    // Kill any orphaned backends from previous crashed test runs
    const numWorkers = process.env.TEST_WORKERS ? parseInt(process.env.TEST_WORKERS) : cpus().length
    for (let i = 0; i < numWorkers; i++) {
      const port = 5290 + i
      try {
        execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: 'ignore' })
      } catch {
        // nothing on that port — ok
      }
    }

    // Build frontend (shared read-only across all workers)
    const indexHtml = join(process.cwd(), 'dist/client/index.html')
    if (process.env.SKIP_BUILD === '1' && existsSync(indexHtml)) {
      console.log('[global-setup] Skipping build (SKIP_BUILD=1 and dist/client exists)')
      return
    }
    execSync('npx vite build --outDir dist/client', { stdio: 'inherit' })
  }
  ```

- [ ] **Step 2: Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add e2e/global-setup.ts
  git commit -m "feat: e2e global-setup — kill orphaned ports and build frontend"
  ```

---

## Task 4: Create `e2e/fixtures.ts`

**Files:**
- Create: `e2e/fixtures.ts`

This is the core of the change. It provides:
- A **worker-scoped** `serverUrl` fixture that spawns and owns a backend process
- Overrides for `context` and `page` pointing at the worker's server
- Re-exports so spec files have one import

**Critical:** In Playwright, `workerIndex` is NOT a named fixture you can destructure from the parameter bag. For worker-scoped fixtures, use the third argument (`workerInfo: WorkerInfo`) — it has a `.workerIndex` property.

- [ ] **Step 1: Create the file**

  ```ts
  // e2e/fixtures.ts
  import { test as base, expect } from '@playwright/test'
  import type { BrowserContext, Page } from '@playwright/test'
  import { spawn } from 'node:child_process'
  import { rm } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { resolve, dirname } from 'node:path'
  import { fileURLToPath } from 'node:url'

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const BASE_PORT = 5290

  export const test = base.extend<
    { context: BrowserContext; page: Page },
    { serverUrl: string }
  >({
    // Worker-scoped: one backend per Playwright worker, lives for all tests in that worker.
    // Note: workerIndex comes from the third argument (WorkerInfo), NOT the fixture param bag.
    serverUrl: [
      async ({}, use, workerInfo) => {
        const port = BASE_PORT + workerInfo.workerIndex
        const dataDir = join(tmpdir(), `tinstar-w${workerInfo.workerIndex}-${Date.now()}`)

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

        // Poll /api/state until the server responds (up to 10s)
        const url = `http://localhost:${port}`
        const deadline = Date.now() + 10_000
        let ready = false
        while (Date.now() < deadline) {
          try {
            const r = await fetch(`${url}/api/state`)
            if (r.ok) { ready = true; break }
          } catch {
            // not up yet
          }
          await new Promise(res => setTimeout(res, 100))
        }
        if (!ready) {
          child.kill('SIGTERM')
          throw new Error(`[fixtures] Backend on port ${port} did not start within 10s`)
        }

        await use(url)

        // Teardown runs after all test-scoped fixtures (page, context) have already closed.
        // Safe to kill the server here — no in-flight requests from Playwright.
        child.kill('SIGTERM')
        await rm(dataDir, { recursive: true, force: true })
      },
      { scope: 'worker' },
    ],

    // Override context to inject the per-worker baseURL.
    // Must override both context AND page — overriding context alone does not
    // cascade to Playwright's built-in page fixture.
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

- [ ] **Step 2: Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors. (The `tsconfig.e2e.json` added in Task 1 makes this meaningful.)

- [ ] **Step 3: Commit**

  ```bash
  git add e2e/fixtures.ts
  git commit -m "feat: e2e fixtures — per-worker backend server + context/page overrides"
  ```

---

## Task 5: Update `playwright.config.ts`

**Files:**
- Modify: `playwright.config.ts`

- [ ] **Step 1: Replace the config**

  ```ts
  import { defineConfig } from '@playwright/test'
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
      // baseURL intentionally omitted — the context fixture sets it per worker
    },
    // webServer removed: each worker manages its own backend via fixtures.ts
  })
  ```

- [ ] **Step 2: Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add playwright.config.ts
  git commit -m "feat: playwright config — parallel workers, globalSetup, remove webServer"
  ```

---

## Task 6: Update all 17 spec file imports

**Files:**
- Modify: all `e2e/*.spec.ts` files

Each spec file imports from `'@playwright/test'`. One `sed` command updates all 17 in one pass, correctly handling files that also import `type Page` and `type Locator` (those types are re-exported from `./fixtures`).

- [ ] **Step 1: Bulk-update all spec imports**

  ```bash
  sed -i "s|from '@playwright/test'|from './fixtures'|g" e2e/*.spec.ts
  ```

- [ ] **Step 2: Verify no `@playwright/test` imports remain in spec files**

  ```bash
  grep -n "from '@playwright/test'" e2e/*.spec.ts
  ```
  Expected: **no output**. Any remaining hits mean a missed file — update manually.

- [ ] **Step 3: Verify `helpers.ts` was NOT changed**

  ```bash
  head -1 e2e/helpers.ts
  ```
  Expected: `import { expect, type Page } from '@playwright/test'`

  `helpers.ts` only uses `expect` and `type Page` directly — it's not a spec and doesn't use the `test` fixture. Leave it alone.

- [ ] **Step 4: Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 5: Commit**

  ```bash
  git add e2e/*.spec.ts
  git commit -m "feat: e2e specs — import test/expect from ./fixtures for per-worker servers"
  ```

---

## Task 7: Smoke test with 2 workers

Before running the full 144-test suite, verify the machinery works with a small slice.

- [ ] **Step 1: Run a single spec with 2 workers**

  ```bash
  TEST_WORKERS=2 npx playwright test e2e/dialogs.spec.ts --reporter=list
  ```
  Expected:
  - Global-setup output: port cleanup lines + vite build (~15s)
  - 2 workers start (you'll see `[worker 0]` and `[worker 1]` in output)
  - All dialog tests pass
  - No "Connection refused" or "did not start within 10s" errors

- [ ] **Step 2: Run two specs simultaneously to confirm isolation**

  ```bash
  TEST_WORKERS=2 npx playwright test e2e/dialogs.spec.ts e2e/hotkeys.spec.ts --reporter=list
  ```
  Expected: both files run in parallel, all tests pass, no state bleed.

- [ ] **Step 3: Confirm serial spec still works**

  ```bash
  TEST_WORKERS=2 npx playwright test e2e/entity-crud.spec.ts --reporter=list
  ```
  Expected: all entity-crud tests pass, running sequentially within one worker (serial mode preserved by `test.describe.configure({ mode: 'serial' })`).

---

## Task 8: Full suite run

- [ ] **Step 1: Run the full suite**

  ```bash
  npx playwright test --reporter=list
  ```
  Expected: all tests pass. Total time well under 10 minutes.

- [ ] **Step 2: Verify SKIP_BUILD shortcut**

  ```bash
  SKIP_BUILD=1 npx playwright test e2e/dialogs.spec.ts --reporter=list
  ```
  Expected: `[global-setup] Skipping build (SKIP_BUILD=1 and dist/client exists)` — tests start immediately with no build step.

- [ ] **Step 3: Commit any fixes**

  If anything needed tweaking during smoke/full runs:
  ```bash
  git add -A
  git commit -m "fix: e2e parallel test suite — issues found during smoke test"
  ```

---

## Verification Checklist

- [ ] `grep -r "from '@playwright/test'" e2e/*.spec.ts` returns nothing
- [ ] `npx tsc --noEmit` passes clean (including e2e files via tsconfig.e2e.json)
- [ ] `TEST_WORKERS=1 npx playwright test` still works (single-worker fallback)
- [ ] `TEST_WORKERS=8 npx playwright test` runs without port conflicts
- [ ] Running tests does not affect a concurrently running `npm run dev` server

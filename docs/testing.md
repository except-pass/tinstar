# Testing

## E2E Tests (Playwright)

Tinstar uses Playwright for end-to-end tests. All tests live in `e2e/`.

### Running tests

```bash
npx playwright test
```

By default this starts a fresh isolated dev server automatically (see [Isolation](#isolation) below). If you already have a dev server running and want to reuse it, set `CI=` to empty — though this is not recommended since the dev server holds real user data.

### Watching / interactive mode

```bash
npx playwright test --ui
```

### Running a single spec

```bash
npx playwright test e2e/hotkeys.spec.ts
```

---

## Isolation

Each test run gets a completely isolated server so tests never touch your real data and multiple runs never collide with each other.

Three env vars control this:

| Variable | Default | Purpose |
|---|---|---|
| `TINSTAR_DATA_DIR` | `/tmp/tinstar-test-<timestamp>` | Data root — replaces `~/.config/tinstar/` |
| `TINSTAR_BACKEND_PORT` | `5281` | Backend HTTP port |
| `TINSTAR_FRONTEND_PORT` | `5280` | Vite dev server port |
| `BASE_URL` | `http://localhost:5280` | URL Playwright uses as the app base |

`playwright.config.ts` generates a fresh `TINSTAR_DATA_DIR` tmp path on every run and passes `TINSTAR_NO_SESSIONS=1` so the backend runs fully in-memory with no tmux dependencies.

### Running a second isolated server alongside dev

Useful for running tests while the main dev server is already on `5280`/`5281`:

```bash
TINSTAR_BACKEND_PORT=5291 \
TINSTAR_FRONTEND_PORT=5290 \
TINSTAR_DATA_DIR=/tmp/tinstar-test \
BASE_URL=http://localhost:5290 \
npx playwright test
```

Or to spin one up manually (e.g. for debugging):

```bash
TINSTAR_BACKEND_PORT=5291 TINSTAR_DATA_DIR=/tmp/tinstar-test npm run dev:backend
TINSTAR_BACKEND_PORT=5291 TINSTAR_FRONTEND_PORT=5290 npm run dev:frontend
```

---

## Simulator

Tests run against a simulator (`TINSTAR_FAST_SIM=1`) that generates mock sessions, runs, and events without tmux. The simulator is automatically enabled by `playwright.config.ts`.

Each test should call `resetAndWaitForData()` from `e2e/helpers.ts` at the start to get a clean, predictable state:

```ts
import { resetAndWaitForData } from './helpers'

test('my test', async ({ page }) => {
  await resetAndWaitForData(page)
  // ...
})
```

This calls `/api/simulator/reset` + `/api/simulator/start`, clears localStorage, reloads the page, and waits for data to appear.

---

## Parallel execution

Tests run fully in parallel (`fullyParallel: true`). Each Playwright worker gets its own isolated backend process on a deterministic port (`5290 + workerIndex`) with a fresh `TINSTAR_DATA_DIR`. Worker count defaults to `cpus().length`; override with `TEST_WORKERS=N`.

The global setup (`e2e/global-setup.ts`) kills any orphaned backends on the worker port range, then builds the frontend once (`dist/client` is shared read-only by all workers).

---

## Unit tests (vitest)

```bash
# Full suite
npx vitest run --exclude='e2e/**'

# Single file
npx vitest run src/server/__tests__/openapi-session-status.test.ts

# Single test by name
npx vitest run src/server/__tests__/document-store-equality.test.ts -t "updateRunStatus"
```

The `--exclude='e2e/**'` is mandatory. Vitest's auto-discovery globs `e2e/*.spec.ts` and the files use Playwright's `test.describe` which throws at module load — every run crashes 30+ "test files" before getting to the actual unit tests. There is currently no `npm test` script that wraps this.

### Node 22 is required (`.nvmrc` → `22`)

Run the suite on Node **>=22.12** (`engines` in `package.json`; `.nvmrc` pins `22`). The jsdom dependency chain (`jsdom` → `html-encoding-sniffer` → `@exodus/bytes`) is ESM-only and is `require()`d from CommonJS; only Node 22.12+'s default `require(esm)` support can load it. On Node 20 every jsdom (`.test.tsx`) test fails to even collect with `ERR_REQUIRE_ESM` (`require() of ES Module .../@exodus/bytes/encoding-lite.js not supported`). The prod server already runs on Node 22, so just `nvm use` in the repo before testing. (Backend `.test.ts` tests run fine on any Node version — see below.)

### Test environments (node vs jsdom)

`vite.config.ts` defaults to the `jsdom` environment but routes backend tests to `node` via `environmentMatchGlobs` (`src/server/**`, `tests/server/**`). Backend tests are pure Node — keeping them out of jsdom is faster and sidesteps the jsdom/ESM trap above, so they pass even on Node 20. If you add a backend test that needs the DOM (rare), move it out of `src/server/` or it'll run without `document`.

### Test file locations

| Location | When to use |
|---|---|
| `src/<area>/__tests__/<thing>.test.ts(x)` | Default. Unit/integration tests for code in the same `src/<area>/` directory. The majority pattern. |
| `tests/<area>/` | Cross-cutting tests that exercise multiple `src/` areas at once (e.g., `tests/server/`, `tests/onboarding/`). |
| `e2e/<spec>.spec.ts` | Browser-driven Playwright tests only. |

Avoid sibling `*.test.ts` files (a single one exists at `src/hooks/telemetryStore.test.ts` — not the convention).

### Reusable test patterns

When you need to fake browser APIs that jsdom doesn't ship:

- **`EventSource`** — see the `MockEventSource` class in `src/core/pluginApi/__tests__/eventBridge.test.ts`. Stub it with `vi.stubGlobal('EventSource', MockEventSource)` in `beforeEach`. Reset module state between tests via `_resetServerEventsForTests()` from `src/hooks/useServerEvents.ts`.
- **`apiFetch`** — see the `vi.mock('../../apiClient', ...)` block in `src/components/__tests__/RecapSessionPanel.quickSend.test.tsx` and `SaloonRefreshButton.apiFetch.test.tsx`. Returns a vi.fn() that resolves to a `Response`.

## Type checking

```bash
npm run typecheck                       # app + e2e + test projects, must report ZERO errors
npx tsc -p tsconfig.app.json --noEmit   # app project only
npx tsc -p tsconfig.test.json --noEmit  # the root tests/ Vitest suite only
```

**Use the `-p tsconfig.app.json` flag** (not the root config). The root `tsconfig.json` is a solution file with only `references` — `npx tsc --noEmit` against the root config compiles nothing and returns 0 even when the project has type errors. This silently masks regressions.

**The baseline is now zero (was ~119 at V5.0, 140 by V5.1-dev).** The `.github/workflows/ci.yml` gate runs `npm run typecheck` on every push/PR and fails on *any* type error, so the baseline can't regrow. Don't add a type error — fix it. If you genuinely need to suppress one, justify it inline (`// reason` next to a `!`/cast) rather than widening the ratchet.

`tsconfig.test.json` covers the root `tests/` Vitest suite (extends the app config, adds `allowJs` so tests can import the plain-JS `bin/` CLI modules). Before it existed, `tests/**` ran under Vitest with no `tsc` gate, so type errors there slipped past CI — now they don't.

Note: the `node` project (`tsconfig.node.json`, which only covers `vite.config.ts` + `tailwind.config.ts`) carries one known wart — `vite.config.ts` trips TS2769 on the `test` key because vitest nests its own copy of `vite`, producing a dual-vite type clash. It's a tooling-version issue, not product code, so `npm run typecheck` covers `app` + `e2e` + `test` (all genuinely zero) and skips `node`.

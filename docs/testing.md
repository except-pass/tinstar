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
npx tsc -p tsconfig.app.json --noEmit
```

**Use the `-p tsconfig.app.json` flag.** The root `tsconfig.json` is a solution file with only `references` — `npx tsc --noEmit` against the root config compiles nothing and returns 0 even when the project has type errors. This silently masks regressions.

The codebase has a known baseline of pre-existing tsc errors (~119 as of V5.0); to tell which errors a change introduces, compare counts before and after, or use `git stash && tsc && git stash pop && tsc`.

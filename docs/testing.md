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

`playwright.config.ts` generates a fresh `TINSTAR_DATA_DIR` tmp path on every run and passes `TINSTAR_NO_SESSIONS=1` so the backend runs fully in-memory with no Docker/tmux dependencies.

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

Tests run against a simulator (`TINSTAR_FAST_SIM=1`) that generates mock sessions, runs, and events without Docker or tmux. The simulator is automatically enabled by `playwright.config.ts`.

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

## Type checking

```bash
npx tsc --noEmit
```

Run this before committing. The CI equivalent is included in `prepublishOnly`.

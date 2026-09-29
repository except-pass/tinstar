# Testing

## Browser regression (Playwright)

Run `npx playwright test`. Each cockpit spec starts an isolated Tin Star server, a private tmux socket, and a private First Mate test home. `e2e/cockpit-regression.spec.ts` checks the fleet rail, provider quota meters, terminal input, worker cycling (including rapid cycling and reduced-motion switch transitions), and terminal window survival. On the worker detail view it also checks that the terminal fills the viewport height, the prompt's bottom edge stays visible, and status, task, and actions sit in the rail beside the terminal (collapsed to a slim header with the worker name, Previous/Next, and a Details toggle at 1200px and below). `e2e/cockpit-inbox.spec.ts` uses a fake `fm-inbox.sh` to check that messages survive reload and follow First Mate receipts and call resolution. The same specs can be selected with `--config playwright.cockpit.config.ts`.

The test home and socket are created in a temporary directory and removed after the run. Do not point this regression at a live First Mate home.

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

The `--exclude='e2e/**'` is mandatory. Vitest's auto-discovery includes the Playwright spec, which throws at module load. `npm run test:unit` includes the exclusion.

> **`NODE_ENV=production` trap:** if your shell exports `NODE_ENV=production`, vitest throws spurious `act(...) is not supported in production builds` failures, and any `npm install` silently prunes devDependencies (typescript/vite/vitest) — after which `npx tsc` hits a sham package and vitest can't find `vite`. Prefix toolchain commands with `env -u NODE_ENV` (or use the `npm run test:unit` / `npm run typecheck` aliases). Full writeup: [docs/solutions/developer-experience/node-env-production-prunes-devdependencies.md](solutions/developer-experience/node-env-production-prunes-devdependencies.md).

### Node 22 is required (`.nvmrc` → `22`)

Run the suite on Node **>=22.12** (`engines` in `package.json`; `.nvmrc` pins `22`). The jsdom dependency chain (`jsdom` → `html-encoding-sniffer` → `@exodus/bytes`) is ESM-only and is `require()`d from CommonJS; only Node 22.12+'s default `require(esm)` support can load it. On Node 20 every jsdom (`.test.tsx`) test fails to even collect with `ERR_REQUIRE_ESM` (`require() of ES Module .../@exodus/bytes/encoding-lite.js not supported`). The prod server already runs on Node 22, so just `nvm use` in the repo before testing. (Backend `.test.ts` tests run fine on any Node version — see below.)

### Test environments (node vs jsdom)

`vite.config.ts` defaults to the `jsdom` environment but routes backend tests to `node` via `environmentMatchGlobs` (`src/server/**`, `tests/server/**`). Backend tests are pure Node — keeping them out of jsdom is faster and sidesteps the jsdom/ESM trap above, so they pass even on Node 20. If you add a backend test that needs the DOM (rare), move it out of `src/server/` or it'll run without `document`.

### Test file locations

| Location | When to use |
|---|---|
| `src/<area>/__tests__/<thing>.test.ts(x)` | Default. Unit/integration tests for code in the same `src/<area>/` directory. The majority pattern. |
| `tests/<area>/` | Cross-cutting tests that exercise multiple `src/` areas at once (e.g., `tests/server/`). |
| `e2e/<spec>.spec.ts` | Browser-driven Playwright tests only. |

Keep tests in an area’s `__tests__/` directory unless there is a cross-cutting reason to put them under `tests/`.

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

# Testing

## Browser regression (Playwright)

Run `npx playwright test`. Each cockpit spec starts an isolated Tin Star server, a private tmux socket, and a private First Mate test home. `e2e/cockpit-shell.spec.ts` checks that the activity strip opens one side panel at a time without changing the page URL, that a closed panel stays closed after opening a worker, that Back returns to the overview, that its labels fit a 616px strip, and that at 616px the panel starts closed, opens as a drawer over the prompt composer, and closes on its backdrop, Escape, Close, or a worker pick. `e2e/cockpit-regression.spec.ts` checks the activity strip and worker switcher, provider quota meters, terminal input, worker cycling (including rapid cycling and reduced-motion switch transitions), and terminal window survival. On the worker detail view it also checks that the terminal fills the height above the prompt composer, that the terminal screen's top edge is inside the viewport and its bottom edge is not past the viewport bottom, that the prompt's bottom row stays visible, and that status, task, and actions sit in the rail beside the terminal (collapsed to a slim header with the worker name, Previous/Next, and a Details toggle at 1200px and below). Wide checks include 1440×700; collapsed-rail checks include 1000×700. At every one of those viewports, with the detail rail wide and collapsed, it checks that the font stays 14px, the xterm grid fills the stage with no horizontal or vertical clipping, and the tmux window matches that grid. Resizing the viewport reflows the window to the new grid. `e2e/cockpit-inbox.spec.ts` uses a fake `fm-inbox.sh` to check that messages survive reload and follow First Mate receipts and call resolution. `e2e/cockpit-filter-link.spec.ts` checks the overview filter, the filter in the page URL, a worker detail link addressed by task id, and that Back after cycling workers returns to the overview. `e2e/cockpit-dismiss.spec.ts` checks that a keyed decision closes through `fm-send.sh` and reads dismissing while the script runs, that a keyed blocked line has no slider, that a captain-held task closes through `fm-captain-hold.sh` and a hold on a live worker's own task is released, that a failed script shows its error and leaves the slider, that an unclassified decision still sends one dismiss note, that a short slide does not, that the slider comes back after a First Mate reply and when a dismissed decision returns, that a dismiss note in one First Mate home does not hold the matching card in another, that a failing home does not block a second dismiss, and that confirming again before the note is listed sends no second note. `e2e/cockpit-mate-status.spec.ts` checks that a second mate whose last status line is a child done or failed shows as working or idle with no attention card, while a ship worker that is done stays done. `e2e/cockpit-mate-badge.spec.ts` checks that a worker with snapshot kind `secondmate` shows a Second mate badge on its overview card and in the detail rail, and that a ship worker and a scout do not. `e2e/cockpit-unknown-state.spec.ts` checks that a worker whose pane state is unknown shows the verb from its latest status event with a last-report age, while a live pane state stays as read and a dead endpoint or a `none` source stays unknown. `e2e/cockpit-quota.spec.ts` checks the compact quota icons and the hover detail against a stubbed `quota-axi`, that each popover stays inside the viewport at 1440×900 and 390×844, that hovering one meter while another has focus shows only the hovered popover, that a signed-out Cursor reads Sign in without removing the activity-strip quota summary, and that a signed-in Cursor is drawn against its own usage cycle. `e2e/cockpit-composer.spec.ts` checks that the prompt composer is docked under the worker terminal, that a sent prompt is pasted into that worker's pane, and that a dropped file is uploaded and shown as a chip. `e2e/cockpit-terminal-scroll.spec.ts` checks that the mouse wheel on a worker terminal scrolls to earlier output, that a key returns to the live pane, that a selection drag still selects text, and that switching to another worker takes the scrolled pane out of copy mode, with the first key after switching back reaching the pane. `e2e/cockpit-group-by.spec.ts` checks two-level grouping by status, project, and direct or managed, and that the grouping choice and a Direct mark survive reload. The same specs can be selected with `--config playwright.cockpit.config.ts`.

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

Note: `npm run typecheck` covers `app` + `e2e` + `test` but not the `node` project (`tsconfig.node.json`, which only covers `vite.config.ts` + `tailwind.config.ts`). That project is type-checked by `npm run build` (`tsc -b`), which CI runs in its Build step. vitest 2.1.9 nests its own vite 5.4.21 beside the root vite 6.4.3, so vitest's `test` key doesn't exist on the root `UserConfig`. `vite.config.ts` works around that dual-vite clash by spreading in a `satisfies InlineConfig` test config — writing `test: testConfig` directly brings back TS2769.

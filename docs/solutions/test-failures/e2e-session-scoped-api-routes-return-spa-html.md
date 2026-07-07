---
title: E2E tests hitting session-scoped API routes get SPA HTML, not JSON
date: 2026-07-07
category: test-failures
module: e2e-testing
problem_type: test_failure
component: testing_framework
symptoms:
  - "SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"
  - "page.request.get('/api/projects').then(r => r.json()) throws in a Playwright test"
  - "A GET/PATCH/PUT to a session-scoped /api route returns the SPA index.html instead of a JSON envelope"
root_cause: config_error
resolution_type: test_fix
severity: medium
tags: [playwright, e2e, test-fixtures, session-routes, spa-fallback, projects]
related_components: [standalone-backend, projects-registry]
---

# E2E tests hitting session-scoped API routes get SPA HTML, not JSON

## Problem

A Playwright e2e that calls a session-scoped API route (e.g. `/api/projects`, including the new `PATCH /api/projects/:name` and `PUT /api/projects/order`) receives the SPA `index.html` fallback instead of a JSON response. `r.json()` then throws and every test in the file fails during setup.

## Symptoms

- `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, thrown from a `.then(r => r.json())` on a `page.request` call.
- The failure is in a `beforeEach`/setup helper that seeds or clears data via the API, so all tests in the spec fail at once.
- `curl`-ing the same route against a standalone started with `TINSTAR_NO_SESSIONS=1` returns the HTML document, confirming it is not a Playwright-only issue.

## What Didn't Work

- **Assuming it was a `baseURL` / `page.request` wiring problem.** It is not — the request *did* reach the server (it got a real HTTP response, just the SPA HTML). Getting `<!DOCTYPE html>` back means the request hit the catch-all SPA fallback, i.e. no API handler matched. Chasing `baseURL` wastes time.
- **Assuming the route was "new and not built yet."** The `docs/solutions/` note about new routes needing a `dist` rebuild is a *different* trap. Here `GET /api/projects` already existed; the route simply is not mounted in this server configuration.

## Solution

The default Playwright fixture (`test` in `e2e/fixtures.ts`) spawns the standalone backend with `TINSTAR_NO_SESSIONS=1`. Under that flag the **entire session-scoped route block is not mounted** — which includes all `/api/projects` routes. Use the `pluginTest` fixture instead, which runs the backend with sessions enabled:

```ts
// Before — /api/projects falls through to the SPA
import { test, expect } from './fixtures'

// After — sessions enabled, session-scoped routes are mounted
import { pluginTest as test, expect } from './fixtures'
```

`pluginTest` has identical `baseURL`/context wiring (it just uses a port offset of +100 and omits `TINSTAR_NO_SESSIONS`), so `page.goto('/')`, `page.request.*`, and all locators work unchanged.

Each worker fixture sets a per-worker `TINSTAR_DATA_DIR` temp dir, and `getConfigRoot()` honors `TINSTAR_DATA_DIR` (a legacy alias), so `projects.json` writes are isolated from the real user config — it is safe to seed and delete projects via `page.request` in the test.

## Why This Works

Session-scoped API routes are only registered when the backend starts with sessions enabled. `TINSTAR_NO_SESSIONS=1` (set by the default fixture to keep most UI tests lightweight) skips that registration, so requests to those paths reach the SPA catch-all and return `index.html`. Switching to the sessions-enabled fixture mounts the routes, so they respond with the normal JSON envelope. An HTML body on an `/api/*` path is the tell that the handler was never registered — not that the URL or client is wrong.

## Prevention

- **Choose the fixture by what the test touches.** If a spec calls any session-scoped `/api` route, import `pluginTest as test`. Reserve the default `test` fixture for pure-UI specs that never hit those routes.
- **When an `/api/*` call returns HTML, suspect route mounting first**, not `baseURL`. Confirm quickly by `curl`-ing the standalone with `TINSTAR_NO_SESSIONS=1`.
- **Companion gotcha — don't try to simulate native HTML5 drag-and-drop in Playwright.** `dragTo` drives mouse events that do not fire `ondragstart`/`ondrop`, so a native-DnD reorder cannot be exercised that way. Instead, drive the reorder endpoint (`PUT /api/projects/order`) and assert the UI after a reload, and unit-test the pure index math (e.g. `reorderByDrop` in `src/lib/projects.ts`) directly:

```ts
// Reliable: endpoint + reload for persistence, unit test for the math
await page.request.put('/api/projects/order', { data: { order: ['c', 'a', 'b'] } })
await page.reload()
// ...assert rendered row order
```

## Related Issues

- `docs/solutions/tooling-decisions/per-session-mcp-config-outside-the-repo.md` — related session-config plumbing.
- Reference memory: standalone-backend route-rebuild trap (a *different* reason an `/api` route can 404 / return SPA HTML — a stale `dist` bundle rather than a disabled-sessions config).
- Introduced while shipping the project star/hide/reorder feature (PR #107).

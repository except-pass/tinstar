# Conventions

Rules that aren't enforceable by the type system but matter for keeping the codebase coherent. When the audit catches drift, it's usually because one of these wasn't written down.

The format: **rule**, one-line *why*, and a link to the source where the rule attaches. Don't restate the implementation here — read the code with the rule in mind.

---

## Server-side

### Config paths route through `getConfigRoot()`

Any file the server reads or writes under `~/.config/tinstar/` must build its path with [`getConfigRoot()`](../src/server/configRoot.ts), not `homedir()` or a hardcoded `~/.config/tinstar`. The override (`TINSTAR_CONFIG_HOME`) is how second backends (rehearsal harness, Tauri local-mode helper, CI) avoid stomping the primary instance's state.

---

## Frontend

### HTTP goes through `apiFetch` / `apiUrl`

Both live in [`src/apiClient.ts`](../src/apiClient.ts) and honor `globalThis.__TINSTAR_API_BASE__`, which the Tauri desktop shell injects to route HTTP to a non-`/` origin. Bare `fetch('/api/...')` 404s in Tauri.

### Component file naming

Components in `src/components/` are `PascalCase.tsx`. Hooks in `src/hooks/` are `camelCase.ts`. Utility modules are `camelCase.ts`. The lone exception is `src/components/agentIcon.tsx` (utility-shaped, awaits cleanup) — don't follow that pattern.

---

## Layering

### Server may not import from frontend; frontend may not runtime-import from server

The server uses shared wire types and pure utilities. It must not import React or JSX. The frontend can `import type` from server wire schemas, but must not runtime-import server modules.

Put shared types beside the active contract: the fleet response in [`src/server/fleet/cockpit.ts`](../src/server/fleet/cockpit.ts), and provider observations in [`src/domain/provider-observation-wire.ts`](../src/domain/provider-observation-wire.ts). Do not add new cockpit types to the retired V5 domain model.

---

## Build & dev

### Type checking and unit tests

See [docs/testing.md](./testing.md#type-checking).

The headline traps:
- `npx tsc --noEmit` against the root tsconfig is a no-op — use `-p tsconfig.app.json`.
- `npx vitest run` without `--exclude='e2e/**'` collects the Playwright spec as a unit test.

---

## Response envelopes

Application APIs return `{ ok: true, data, warnings? }` or `{ ok: false, error: { code, message, details? } }`. Use the `ok()` and `fail()` helpers in [`src/server/api/envelope.ts`](../src/server/api/envelope.ts) — they auto-derive the HTTP status from the `ErrorCode`.

Wire-protocol endpoints (`/api/cc-quota`, provider observations, the `/api/events` SSE stream) stay raw and are documented at the route.

Decision + rationale + migration plan: [ADR 0001](./adrs/0001-response-envelope.md).

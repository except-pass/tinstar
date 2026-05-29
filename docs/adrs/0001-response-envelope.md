# ADR 0001 — Unified response envelope and error codes

**Status:** Implemented (2026-05-23)
**Date:** 2026-05-23
**Supersedes:** the eight ad-hoc shapes that were in `src/server/api/routes.ts` and `src/server/api/fileUploadRoute.ts`

---

## Context

`src/server/api/routes.ts` currently ships **eight** distinct response shapes across ~240 `json()` calls:

| Shape | Count | Where |
|---|---|---|
| `{ ok: true, data: X }` | ~25 | Standard success |
| `{ ok: true, data: X, warnings: { nats: [...] } }` | 3 | Success with soft-failures |
| `{ ok: true, <adhoc-key>: X }` | 4 | `commit`, `activeSpaceId`, `content` |
| `{ ok: true, message: 'msg' }` | few | Action confirmations |
| `{ ok: false, error: { code, message } }` | ~30 | Structured error (de facto majority) |
| `{ ok: false, error: 'string' }` | ~3 | Hybrid |
| `{ error: 'string' }` (no `ok`) | ~40 | Bare error |
| Raw JSON (no envelope) | ~10+ | `/api/docs/openapi.json`, `/api/observability/*`, `/api/state`, taxonomy list endpoints |

The frontend universally reads `body?.error?.message` and `body?.error?.code` — already expects the structured form. Bare `{ error }` responses surface as `undefined` in error UI. There is no generic error reader on the frontend, and there can't be one until the envelope is consistent.

The audit flagged this as Tier-4 item #21 and recommended an ADR.

## Decision

### Application APIs

Every application API endpoint returns one of two shapes:

```ts
type Ok<T>     = { ok: true; data: T; warnings?: WarningMap }
type Err       = { ok: false; error: { code: ErrorCode; message: string; details?: unknown } }
type Response<T> = Ok<T> | Err
```

- `ok` is the discriminant — frontend narrows the union by checking `body.ok`.
- `data` is always present on success, even when the response is "void" — use `data: null` (don't use `message` as a stand-in for `data`).
- `warnings` is an optional map of soft-failures (e.g. `{ nats: [...] }` for partial NATS subscription failures); the operation succeeded but the consumer should surface them.
- `error.code` is a machine-readable enum (TS string union). `error.message` is human-readable. `error.details` is structured context (validation errors, conflicting state, etc.) — opaque to generic readers, useful to specific handlers.

### Error codes

A flat string union, owned in `src/domain/api.ts`:

```ts
export type ErrorCode =
  // Client errors (4xx)
  | 'BAD_REQUEST'           // malformed JSON, missing required field, wrong type
  | 'INVALID_PARAMS'        // semantic validation failed (range, format)
  | 'NOT_FOUND'             // entity by id not found
  | 'SESSION_NOT_FOUND'     // specifically a session lookup miss (kept distinct; frontend treats it differently)
  | 'CONFLICT'              // would violate uniqueness / state precondition
  | 'PATH_OUTSIDE_WORKSPACE'  // path-traversal guard hit
  | 'FORBIDDEN'             // permission/safety guard
  // Server errors (5xx)
  | 'INTERNAL'              // unexpected throw, last-resort catch-all
  | 'BACKEND_UNAVAILABLE'   // tmux/NATS/external service not reachable
  | 'BRIDGE_UNAVAILABLE'    // NATS bridge specifically (already in use)
  | 'CONFIG_UNAVAILABLE'    // sessionConfig hasn't loaded yet
  | 'LIST_FAILED'           // a list/enumerate operation failed mid-flight
```

This list is **closed** — every error must map to one of these. New error categories need an ADR amendment. The TS string union enforces it at compile time.

ALL_CAPS_WITH_UNDERSCORES matches the existing majority pattern in routes.ts; no renames needed for the 30+ sites that already use these names.

### HTTP status codes

The envelope is the application contract. The HTTP status is the transport contract. Both must be set; they're correlated but not redundant:

| ErrorCode | HTTP status |
|---|---|
| `BAD_REQUEST`, `INVALID_PARAMS` | 400 |
| `NOT_FOUND`, `SESSION_NOT_FOUND` | 404 |
| `FORBIDDEN`, `PATH_OUTSIDE_WORKSPACE` | 403 |
| `CONFLICT` | 409 |
| `BRIDGE_UNAVAILABLE`, `CONFIG_UNAVAILABLE`, `BACKEND_UNAVAILABLE` | 503 |
| `LIST_FAILED`, `INTERNAL` | 500 |

The `fail()` helper (below) sets both from a single ErrorCode argument — call sites can't get out of sync.

### Helpers

Two helpers replace direct `json(res, { ok: ..., ... })` writes. Defined in `src/server/api/envelope.ts`:

```ts
export function ok<T>(res: ServerResponse, data: T, opts?: { warnings?: WarningMap; status?: number }): true
export function fail(res: ServerResponse, code: ErrorCode, message: string, opts?: { details?: unknown; status?: number }): true
```

`status` is auto-derived from `code` per the table above; pass `opts.status` only to override. Call sites read like English: `fail(res, 'NOT_FOUND', \`Session '${name}' not found\`)`.

The existing `json()` helper stays for the **exception cases** below.

### Exceptions — endpoints that stay raw

Wire-protocol endpoints don't get the envelope. Their *external contract* is their envelope:

- `GET /api/docs/openapi.json` — OpenAPI spec (third-party consumers expect raw)
- `GET /api/observability/*` — OTLP-shape spans/metrics, Prometheus text format
- `GET /api/state` — full SSE snapshot, shape contract is fixed and consumed by `useServerEvents`
- `GET /api/cc-quota/snapshot` — opaque CC quota payload, consumed by `useCcQuota`

Each exception is documented in a comment at the route's `json(res, ...)` line stating "raw — not enveloped" and why.

## Consequences

### Positive

- Frontend can write **one generic error reader**: `if (!body.ok) showToast(body.error.message)`. Currently impossible.
- Tests can assert envelope structure with one helper.
- New routes get the right shape by default (helpers exist, no ad-hoc spreading).
- Adding an `ErrorCode` is a compile error until every call site classifies, which prevents silent regressions.
- `warnings` becomes a first-class concept — currently `{ nats: [...] }` is sneaked into specific endpoints inconsistently.

### Negative / costs

- One large migration commit (or several scoped ones) touching ~70 call sites in `routes.ts`.
- Three frontend code paths that read `{ ok: true, content }` / `{ ok: true, activeSpaceId }` / `{ ok: true, commit }` need updates (`body.data` instead of the ad-hoc key).
- Two e2e tests likely assert on bare-error shapes — need updating.
- Closed `ErrorCode` union creates friction when a new error category appears; this is intentional but worth flagging.

### Out of scope

- SSE event payload shape (separate contract, not request/response).
- Per-route OpenAPI schema generation (would benefit from the envelope but is a larger effort).
- Renaming `LIST_FAILED` → `INTERNAL` (LIST_FAILED is too specific; kept for now to preserve existing log searches).

---

## Implementation plan

Five tasks, each independently revertible.

### Task 1 — Define envelope types and helpers

**Files:**
- Create: `src/domain/api.ts` — `ErrorCode` union, `Ok`, `Err`, `Response`, `WarningMap` types.
- Create: `src/server/api/envelope.ts` — `ok()` and `fail()` helpers wrapping the existing `json()`.
- Create: `src/server/api/__tests__/envelope.test.ts` — round-trip tests for status auto-derivation, helper output shape, warnings field.

**Verification:**
```bash
npx vitest run src/server/api/__tests__/envelope.test.ts
npx tsc -p tsconfig.app.json --noEmit
```

Commit: `feat(api): envelope types and ok/fail helpers #envelope`

### Task 2 — Migrate routes.ts bare-error responses

About 40 sites of `json(res, { error: 'msg' }, NNN)`. Each maps mechanically to `fail(res, '<CODE>', 'msg')`. The hardest part is picking the right code:

| Existing message pattern | New code |
|---|---|
| "not found", "no run with…", "...not found" | `NOT_FOUND` or `SESSION_NOT_FOUND` |
| "invalid json", "malformed_json", "Invalid request body" | `BAD_REQUEST` |
| "X is required", "missing Y" | `BAD_REQUEST` |
| "session config unavailable" | `CONFIG_UNAVAILABLE` |
| "Cannot delete the active space", "Cannot delete the last space" | `CONFLICT` |
| Path traversal guards | `PATH_OUTSIDE_WORKSPACE` |

**Files:**
- Modify: `src/server/api/routes.ts` (~40 edits)
- Run any existing tests that hit these routes to confirm they still pass.

**Verification:**
```bash
npx vitest run --exclude='e2e/**'
npx tsc -p tsconfig.app.json --noEmit
```

Commit: `refactor(api): migrate bare-error responses to envelope #envelope`

### Task 3 — Migrate routes.ts ad-hoc success keys to `data`

Four sites:
- `{ ok: true, commit: updated }` → `{ ok: true, data: updated }` (plus update the one frontend consumer in `CommitActivity*` — already dead code, gone in tier4)
- `{ ok: true, activeSpaceId: id }` → `{ ok: true, data: { activeSpaceId: id } }` (consumer: `SpaceSwitcher` likely)
- `{ ok: true, content: stdout }` → `{ ok: true, data: { content: stdout } }`
- `{ ok: true, content: null }` → `{ ok: true, data: { content: null } }`

**Files:**
- Modify: `src/server/api/routes.ts` (4 edits)
- Modify: each frontend consumer (grep for the key names). Each frontend call site changes from `body.commit` to `body.data` etc.

**Verification:**
```bash
npx vitest run --exclude='e2e/**'
npx tsc -p tsconfig.app.json --noEmit
# Manual smoke: hit each migrated endpoint via curl, verify shape
```

Commit: `refactor(api): move ad-hoc success keys under data #envelope`

### Task 4 — Migrate the remaining `{ ok: true, data, warnings }` and `{ ok: false, error: 'string' }` sites

The 3 `warnings:` sites already match the new shape — just need `ok()` helper call. The 3 hybrid `{ ok: false, error: 'string' }` sites get `fail(res, 'NOT_FOUND', ...)` etc.

**Files:** `src/server/api/routes.ts` (~6 edits).

Commit: `refactor(api): final routes.ts envelope migration #envelope`

### Task 5 — Update OpenAPI spec and docs

**Files:**
- Modify: `src/server/api/openapi.ts` — declare the `Ok` and `Err` schemas as `components/schemas/Response`; reference them from every operation's `responses` block. Document the exceptions (raw-shape endpoints) explicitly.
- Modify: `docs/conventions.md` — point to this ADR under "Response envelopes".
- Modify: `docs/architecture.md` — link to ADR from the API section.
- Update: `src/server/api/fileUploadRoute.ts` — has its own private `json()` helper, migrate to envelope too.

Commit: `docs(api): document the envelope contract #envelope`

---

## Migration safety

- Each task is a single commit with its own verification — easy revert if a downstream consumer breaks.
- The frontend already reads `body?.error?.message` everywhere — bare-error sites becoming structured-error sites is a pure improvement (currently those error messages display as `undefined`; after migration they display the actual text).
- Existing structured-error sites are not touched (already match the contract).
- No HTTP status code changes — only body shapes change.

## Open questions for review

1. **Should `data: null` be allowed for void responses, or should they emit a typed empty?** Recommended: `data: null`. Cleaner than `data: undefined` (drops from JSON entirely) or `data: {}` (lies about shape).
2. **Should `error.details` be required for `INVALID_PARAMS`?** Probably yes, with a `{ field, expected }` shape — but defer to a follow-up ADR; for now leave as `unknown`.
3. **Should `warnings` be typed beyond `Record<string, unknown[]>`?** Current single use is `{ nats: NatsWarning[] }`. As more warning categories appear, type them. Defer until we have a second category.

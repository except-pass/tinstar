# Conventions

Rules that aren't enforceable by the type system but matter for keeping the codebase coherent. When the audit catches drift, it's usually because one of these wasn't written down.

The format: **rule**, one-line *why*, and a link to the source where the rule attaches. Don't restate the implementation here — read the code with the rule in mind.

---

## Server-side

### Config paths route through `getConfigRoot()`

Any file the server reads or writes under `~/.config/tinstar/` must build its path with [`getConfigRoot()`](../src/server/configRoot.ts), not `homedir()` or a hardcoded `~/.config/tinstar`. The override (`TINSTAR_CONFIG_HOME`) is how second backends (rehearsal harness, Tauri local-mode helper, CI) avoid stomping the primary instance's sessions/projects/NATS state.

*Audit caught:* `src/server/index.ts:62` hardcoded `homedir()` for `slash-usage.json`, silently corrupting the primary's file when a second backend was started.

### tmux session names route through `tmuxSessionName(cfg, name)`

`config.sessions.prefix` is user-configurable. Building a tmux target as `\`tinstar-${name}\`` ignores that override; tmux lookups fail silently, and every session shows "stopped".

Use [`tmuxSessionName`](../src/server/sessions/backends/tmux.ts) from `backends/tmux.ts`. If you're outside that file, inject the resolver as a callback (see [`StatusWatcherOpts.resolveTmuxName`](../src/server/sessions/status-watcher.ts) for the pattern).

### NATS subjects route through `buildAgentSubject` / `parseSubject`

One canonical builder + parser at [`src/server/nats/subjects.ts`](../src/server/nats/subjects.ts). The shape, the magic part-counts, and the `BREAKOUT_PREFIX` literal all live there. Inline `\`tinstar.${space}.${init}...\`` templates were the rot. See [docs/nats-agent-channels.md](./nats-agent-channels.md) for the subject scheme itself.

### Docstore mutators must equality-short-circuit before emit

`upsertRun`, `updateRunStatus`, `reconcileFiles` all skip the change emit when nothing actually changed. Any new mutator that calls `this.changes.emit(...)` unconditionally undoes the perf work — every status-watcher tick re-broadcasts SSE and reschedules a persist write.

When you add a mutator: compare to existing state first, emit only on change. See [`runShallowEqual`](../src/server/stores/document-store.ts) for the array-reference convention (callers spread, so `touchedFiles !== touchedFiles` is the correct staleness signal).

### `upsertRun` callers must preserve array references via spread

Use `{ ...existing, foo: x }`, never `{ ...makeFreshRun() }`. The shallow-equal check uses reference identity for `touchedFiles` and `recapEntries`; rebuilding from scratch with new arrays produces unnecessary emits. (Mutations to those arrays go through dedicated methods — `addRecapEntry`, `reconcileFiles` — not via re-upsert.)

### `updateRunStatus` mutates the stored run in place

`run.status = status` modifies the same object reference the caller may be holding. Not visible from the signature. Be deliberate: if you cache a `Run`, you'll see the mutation.

### Adding a new `BusEvent` needs three coordinated edits

1. Payload interface in [`src/server/types.ts`](../src/server/types.ts).
2. Variant in the `BusEvent` discriminated union.
3. Emit-site call that supplies a payload matching the variant.

`emitSessionEvent` is typed `<T extends BusEventType>(type: T, payload: PayloadFor<T>)` — step 3 fails to compile if you forget steps 1–2. (Before V5 these emits were cast as `Parameters<typeof bus.emit>[0]`, hiding mismatches; one live bug had `managed_session.nats_orphaned` emitted but not in the union, and another sent `{ session }` where `{ name, state }` was declared.)

---

## Frontend

### HTTP goes through `apiFetch` / `apiUrl`

Both live in [`src/apiClient.ts`](../src/apiClient.ts) and honor `globalThis.__TINSTAR_API_BASE__`, which the Tauri desktop shell injects to route HTTP to a non-`/` origin. Bare `fetch('/api/...')` 404s in Tauri.

### Component file naming

Components in `src/components/` are `PascalCase.tsx`. Hooks in `src/hooks/` are `camelCase.ts`. Utility modules are `camelCase.ts`. The lone exception is `src/components/agentIcon.tsx` (utility-shaped, awaits cleanup) — don't follow that pattern.

---

## Layering

### Server may not import from frontend; frontend may not runtime-import from server

The server uses shared domain types and pure utilities. It must not import React or JSX. The frontend can `import type` from server wire schemas, but must not runtime-import server modules.

Shared types live in [`src/domain/types.ts`](../src/domain/types.ts). `src/types.ts` is a re-export shim — new types go in `domain/`, not the shim.

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

Wire-protocol endpoints (OpenAPI spec, OTLP/Prometheus exports, `/api/state` SSE snapshot) stay raw and are documented at the route.

Decision + rationale + migration plan: [ADR 0001](./adrs/0001-response-envelope.md).

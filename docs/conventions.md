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

### `JSON.parse(e.data)` inside SSE event listeners must try/catch

The `telemetry:hud`, `canvas:viewport`, and `projects_changed` listeners in [`useServerEvents.ts`](../src/hooks/useServerEvents.ts) wrap their parse in try/catch and silently drop malformed frames. `snapshot`, `delta`, `file_watch`, `nats_traffic`, and `ready_queue_update` currently don't — one malformed server frame crashes those handlers. Treat the wrapped pattern as the rule; the un-wrapped ones are pending fixes.

---

## Frontend

### HTTP goes through `apiFetch` / `apiUrl`

Both live in [`src/apiClient.ts`](../src/apiClient.ts) and honor `globalThis.__TINSTAR_API_BASE__`, which the Tauri desktop shell injects to route HTTP to a non-`/` origin. Bare `fetch('/api/...')` 404s in Tauri.

Dynamic `import()` of plugin code: wrap the URL with `apiUrl(...)` before passing to `import()` — see [`externalLoader.ts`](../src/core/pluginHost/externalLoader.ts).

### localStorage prefs go through `uiPrefs.ts`

[`src/lib/uiPrefs.ts`](../src/lib/uiPrefs.ts) is the only file that should call `localStorage.getItem`/`setItem` directly. Singleton booleans/numbers fold into one `tinstar-ui-prefs` blob; per-id families (hotgroups, prompt-stash, hidden runs) keep their own keys but go through `readJSON`/`writeJSON` helpers.

The sole documented exception is `tinstar-layouts-v3` (widget layouts cache) in [`useWidgetLayouts`](../src/hooks/useWidgetLayouts.ts). Don't add new exceptions — extend the `UiPrefs` interface instead.

### Custom window events go through `windowEvents.ts`

Use [`dispatchWindowEvent`](../src/lib/windowEvents.ts) on the dispatch side and `useWindowEvent` (React hook) or the `EV` constants (for sites that share useEffect state with the listener) on the receive side. Raw `window.dispatchEvent(new CustomEvent('tinstar:foo'))` is the rot — string typos on either side silently break the connection.

The `tinstar:open-linked-file` event is bubble-based DOM (dispatched on `e.currentTarget`), not window-routed. It's intentionally outside this registry.

### Component file naming

Components in `src/components/` are `PascalCase.tsx`. Hooks in `src/hooks/` are `camelCase.ts`. Utility modules are `camelCase.ts`. The lone exception is `src/components/agentIcon.tsx` (utility-shaped, awaits cleanup) — don't follow that pattern.

---

## Layering

### Server may not import from frontend; frontend may not runtime-import from server

The dependency graph runs `src-tauri → packages → src/server ← src/domain → src/{components,hooks,widgets,context,lib,plugins,core,data,hotkeys}`. Server code must not import React, JSX, or anything under `src/components/*` / `src/hooks/*` / etc. Frontend code may `import type` from `src/server/observability/types` (wire schemas for SSE/telemetry are shared) but not runtime values.

Shared types live in [`src/domain/types.ts`](../src/domain/types.ts). `src/types.ts` is a re-export shim — new types go in `domain/`, not the shim.

### Plugins: built-in vs external

Built-in and external plugins both consume only [`@tinstar/plugin-api`](../packages/plugin-api/src/index.ts); host runtime imports from `src/plugins/*/src/**` are forbidden by ESLint. See [ADR 0002](./adrs/0002-plugin-api-boundary.md).

---

## Build & dev

### Type checking and unit tests

See [docs/testing.md](./testing.md#type-checking).

The headline traps:
- `npx tsc --noEmit` against the root tsconfig is a no-op — use `-p tsconfig.app.json`.
- `npx vitest run` without `--exclude='e2e/**'` crashes on every Playwright spec.

---

## Response envelopes

Application APIs return `{ ok: true, data, warnings? }` or `{ ok: false, error: { code, message, details? } }`. Use the `ok()` and `fail()` helpers in [`src/server/api/envelope.ts`](../src/server/api/envelope.ts) — they auto-derive the HTTP status from the `ErrorCode`.

Wire-protocol endpoints (OpenAPI spec, OTLP/Prometheus exports, `/api/state` SSE snapshot) stay raw and are documented at the route.

Decision + rationale + migration plan: [ADR 0001](./adrs/0001-response-envelope.md).

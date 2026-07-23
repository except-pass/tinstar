> ## ⛔ PUNTED — DO NOT BUILD THIS
>
> **Ruling (2026-07-23, Will):** plugins and Slate surfaces stay **completely separate** for now.
> This plan is retained as the record of *why*, not as work to pick up.
>
> The contract turned out far more entangled than it first appeared: a plugin surface needs its own
> opt-in capability tag, a **second** shell-free render component (canvas widgets depend on
> `CanvasWidgetShell` hooks that throw outside the shell), a new anchor kind plus a file-owned
> `pluginData` threaded through every merge site, a server-side placement gate, and a new surface
> kind — while leaving `Point` modelling something with no thread/status meaning. That is a second
> widget framework in disguise, in exchange for one fleet-wide first rider.
>
> Reopen the `op-plugin` Slate point if plugin-backed surfaces are wanted later.

# S5 — Plugin-as-Surface (implementation plan)

> A `/lightsout` run builds, tests, and squash-merges this as ONE PR. No code here — only the plan.
> Repo-relative paths throughout. Typecheck: `env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json`.
> Tests: `env -u NODE_ENV npx vitest run --exclude='e2e/**'`. Frontend HTTP via `apiFetch` (`src/apiClient.ts`). Do NOT bump version.

## Problem & Scope

A2UI already lets an agent author rich but **static** surfaces on The Slate (the run-scoped column of small cards). Plugins are the other half of Tinstar's UI vocabulary — they add **live data, iframes, and interactivity** (`src/core/pluginHost/`, `packages/plugin-api/`). Today a plugin can only render as a full canvas widget inside `CanvasWidgetShell`; it cannot appear as a Slate surface.

**Goal:** let a plugin render as a Slate surface — but **not** by universally auto-wrapping every canvas widget. A plugin **opts in** with a capability tag and ships a **compact render mode** built for the Slate's narrow (~260–560px) column. The first shipped rider is one simple existing bundled plugin.

**In scope:** the capability tag, one compact-render contract, one new `SlateSurface` kind (`'plugin'`) with its projection + one dispatch branch in `SlatePanel`, server-side placement/validation, and wiring exactly one bundled plugin (`model-attribution`) as the first rider.

**Explicitly out of scope:** a composer UI for adding plugin surfaces (file-authored + HTTP placement only); auto-wrapping arbitrary canvas widgets; per-instance interactivity that needs the widget shell (`useData`/`useAttention`/pins/constellations); external (non-bundled) plugins as surfaces; refresh-recipe semantics for plugin surfaces.

## Decisions

**This is the most open-ended feature in the set.** Unlike the A2UI surfaces (a fixed JSON schema through one shared renderer), a plugin surface is arbitrary live React with its own data sources. The open questions are all about *where to draw the boundary* so this stays "a capability tag + one render path" and does not metastasize into a second widget framework. Every call below is chosen to **maximize reuse of the existing Point→surface projection and the existing plugin registry**, and to **minimize new surface area**.

### (a) Where the capability tag lives, and its shape

**Decision:** reuse the **existing `capabilities: string[]`** bag on the plugin manifest widget contribution (`packages/plugin-api/src/index.ts` → `PluginManifest.contributes.widgets[].capabilities`) and its mirror on the client `WidgetRegistration.capabilities`. The tag string is **`'surface-hostable'`**. No new manifest field.

- **Rationale:** `capabilities` is already the declarative tag bag — `'spawnable'`, `'web-view'`, `'session-host'` already live there (see the JSDoc at `WidgetRegistration.capabilities`). Adding one more string is the smallest possible change and matches the house preference for *declarative capability tags over hardcoded N×N tables* (memory: `feedback_composable_over_tables`). The **server** can read this off the manifest (`BUILTIN_PLUGIN_PKGS` in `src/server/api/builtinPluginManifests.ts`) to gate placement; the **client** reads it off the registration.
- **Assumption:** the tag is a coarse opt-in ("this plugin *may* be surface-hosted"), not per-instance config. Fine — plugin surfaces carry their instance config in the placing Point's `pluginData` (decision c).
- **Tradeoff:** choosing a reused capability string over a dedicated `surfaceHostable: boolean` manifest field. Gains: zero new manifest schema, server+client already parse capabilities. Costs: a stringly-typed flag (typo = silently not surface-hostable). Wrong if we needed structured per-surface config at the manifest level (we don't — that lives on the Point).

### (b) The compact-render contract

**Decision:** a **dedicated slim component**, registered via a **new optional field `surfaceComponent?: ComponentType<SurfaceHostProps>` on `WidgetRegistration`** — *not* the canvas `component` reused with a size hint. `SurfaceHostProps` is a small, **shell-free** read-only prop bag:

```
interface SurfaceHostProps { data: unknown; runId: string; width?: number }
```

- **Rationale — the load-bearing constraint:** a canvas plugin widget's `component` depends on **per-widget host context** injected by `CanvasWidgetShell` — `api.widget.useData`, `api.constellations.useMyNodeId`, `api.pins.*`, `api.hotkeys.*` all read that context and **throw when called outside the shell** (verified in `src/core/pluginApi/createApi.tsx`). Dropping a canvas component into `SlatePanel` (which is not a widget shell) would crash any widget that uses those hooks. A dedicated slim entry sidesteps the whole coupling problem and lets the author lay out for the narrow column.
- **The contract (documented on the type):** a `surfaceComponent` MAY use the **bridge-level, shell-free** slices of the plugin API — `api.http`, `api.events`, `api.logger`, `api.theme` — and its own props. It **MUST NOT** call the shell-coupled hooks (`api.widget.*`, `api.constellations.*`, `api.pins.*`, `api.hotkeys.*`). It renders from `props.data` (the Point's `pluginData`) plus whatever it fetches/subscribes itself.
- **Why this is feasible for the first rider:** `src/plugins/model-attribution/src/ModelAttributionWidget.tsx` already gets all its data from `api.http.fetch('/api/state')`, `api.http.fetch('/api/cc-quota')`, and `api.events.subscribe('telemetry:hud', …)` — **no `useData`, no shell hooks**. So its compact variant reuses the same closure over `api` (produced in `activate(api)`), just a narrower layout.
- **Assumption:** the capability tag (a) and the `surfaceComponent` field (b) are both required to be a valid surface rider. The tag is the *server-visible declarative opt-in*; the field is the *client renderer*. A plugin that declares the tag but ships no `surfaceComponent` is a misconfiguration → the client logs a warning and renders the fallback note (never crashes). This mirrors the existing split where manifest capabilities and the live registration both carry data.
- **Tradeoff:** choosing a dedicated `surfaceComponent` over reusing `component` + a `preferredSize`/`compact` hint. Gains: no widget-shell-context coupling, author owns the slim layout, safe to mount anywhere. Costs: the plugin author writes a second (small) component. Wrong if plugin canvas components were already shell-context-free — they are not (`useData` is the norm), so the reuse path would be a crash surface.

### (c) Placement on the Slate and projection

**Decision:** a **new `SlateSurface` kind `'plugin'`**, placed by the **existing Point→surface pipeline** via a **new `PointAnchor.kind` value `'plugin'`** whose `ref` names the widget `type`, plus a new **file-owned `pluginData?: unknown`** field on the Point. `SlatePanel` gains **one dispatch branch** for `'plugin'`.

- **Placement paths (both reuse existing plumbing, no new UI):**
  1. **File-authored** — a `.tinstar/slate/*.json` entry with `{ headline, anchor: { kind: 'plugin', ref: '<widget-type>' }, pluginData: {…} }`. The slate-watcher (`src/server/sessions/slate-watcher.ts`) already ingests these; extend `toAnchor` to accept `'plugin'` and `toPointInput` to carry `pluginData`.
  2. **User HTTP** — `POST /api/runs/:id/slate/points` (`src/server/api/routes.ts`) already creates user points; extend its anchor validation to accept `'plugin'` + `pluginData`. This gives `/lightsout` a clean, unit-testable placement path.
- **Server-side gate (defensive):** a `'plugin'`-anchored point is **rejected unless `ref` names a bundled plugin widget that carries `'surface-hostable'`** in its manifest capabilities (read from `BUILTIN_PLUGIN_PKGS`). A hostile/typo file referencing an arbitrary widget type is dropped at the boundary — this is *why* the capability tag must be server-visible (decision a). This gate lives in a small shared helper so the watcher and the HTTP route apply the same rule.
- **Projection** (`projectRunToSlate`, `src/server/stores/document-store.ts:972`): derive
  `kind = anchor?.kind === 'plugin' ? 'plugin' : anchor?.kind === 'surface' ? 'diagram' : 'open-point'`,
  and carry `pluginType = anchor.ref` and `pluginData = p.pluginData` onto the `SlateSurface`.
- **Dispatch** (`SlatePanel.tsx`, the `surface.kind === 'diagram' ? … : A2UI` block ~line 317): add a `surface.kind === 'plugin'` branch that renders a new `PluginSurface` inside the **same hairline card shell** and the **same error-boundary discipline** (a throwing/unregistered plugin degrades *alone*, siblings untouched — mirror `A2uiErrorBoundary`). `PluginSurface` looks up `getWidgetComponent(surface.pluginType)?.surfaceComponent` (`src/widgets/widgetComponentRegistry.ts`) and renders it with `{ data: surface.pluginData, runId, width }`. Missing registration → a quiet low-ink note ("This surface needs the <type> plugin"), never a crash.
- **`pluginData` is file-owned → the 3-place merge trap applies.** Per memory `reference_rundata_field_three_places`, a file-owned Slate field silently rots unless mirrored in **every** merge site in `src/server/stores/slate.ts`: `synthesizeId` (the id basis), `fileOwnedChanged`, `mergeFileOwned`, and `createPoint`. Each gets a guard test that fails when the field is backed out. Model it exactly on how `content`/`anchor` are threaded.
- **Rationale:** reusing the Point pipeline means plugin surfaces inherit hide/show, ordering, freshness, per-surface error isolation, and SSE projection **for free** — no parallel store, no second stream. The only genuinely new field is `pluginData`.
- **Tradeoff:** choosing "plugin surface = a Point with a plugin anchor" over a **separate `PluginSurfaceStore`/entity**. Gains: reuses projection, hide/show, ordering, SSE, error isolation; ~one field of new state. Costs: a Point now models something with no thread/status meaning (a plugin surface's `status`/`thread`/resolve are inert). Wrong if plugin surfaces needed lifecycle semantics fundamentally unlike a point — they don't for S5 (read-only live data), so the reuse wins decisively.

### (d) The first rider

**Decision:** **`model-attribution`** (palette label "Models" — `src/plugins/model-attribution/`).

- **Rationale:** it is the **cleanest possible rider**. Its widget already sources **all** data from bridge-level APIs (`api.http.fetch('/api/state')`, `/api/cc-quota`, `api.events.subscribe('telemetry:hud')`) with **no `useData`, no session backing, no primitives, no pins** — so a shell-free `surfaceComponent` is a genuinely small addition, not a rewrite. It shows *live* data (which model each session runs, quota headroom, cost-by-model), satisfying "plugins add live data," and it fits a narrow column (a compact 2–3 row summary).
- **Tradeoff:** choosing `model-attribution` over `roundup` (run-adjacent notices) or `graveyard`. Gains: zero shell/session coupling → smallest safe first render path. Costs: its data is *fleet-wide*, not this-run-specific, so on one run's Slate it reads as ambient context rather than run-scoped. Wrong if the point of the first rider were to prove *run-scoped* plugin data — but S5's point is proving the *render path*, and a fleet-global widget proves it with the least coupling risk. Others (`browser`, `file-editor`, `image-viewer`, `roborev`, `nats-traffic`) depend on primitives/sessions/heavy context and are poor first riders.

## Implementation Units

### U1 — Capability tag + compact-render contract in the plugin API

- **Goal:** define `'surface-hostable'` and the `surfaceComponent` / `SurfaceHostProps` contract in the shared types, with no behavior change yet.
- **Files:**
  - Modify `packages/plugin-api/src/index.ts` — add `SurfaceHostProps` interface; add optional `surfaceComponent?: ComponentType<SurfaceHostProps>` to `WidgetRegistration` with JSDoc spelling out the shell-free contract (allowed: `http`/`events`/`logger`/`theme`; forbidden: `widget`/`constellations`/`pins`/`hotkeys`) and that `'surface-hostable'` in `capabilities` is the declarative opt-in. Document the `'plugin'` value nowhere here (host-internal — see U2).
  - Modify `src/widgets/widgetComponentRegistry.ts` — `WidgetRegistration extends` the API shape, so `surfaceComponent` flows through automatically; add a `getSurfaceComponent(type)` convenience accessor returning `registry.get(type)?.reg.surfaceComponent`.
  - Test `packages/plugin-api/src/**` (or the existing plugin-api test file) — assert the type shape compiles and `TINSTAR_API_VERSION` unchanged.
- **Approach:** pure type + accessor addition. `@tinstar/plugin-api` is a separately-publishable package (see `docs/releasing.md`); this is an **additive optional field** — do NOT trigger a plugin-api republish decision here, just land the source (the release skill gates publication on the shipped-surface diff).
- **Test scenarios:** registration with `surfaceComponent` round-trips through `registerWidgetComponent` → `getSurfaceComponent`; registration without it returns `undefined`.
- **Verification:** `env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json`; targeted vitest on the registry + plugin-api tests.

### U2 — `SlateSurface`/`Point` `'plugin'` kind + `pluginData`, and the server projection

- **Goal:** carry a plugin surface end-to-end through the store projection.
- **Files:**
  - Modify `src/domain/types.ts` — add `pluginData?: unknown` (file-owned) to `Point` and `PointInput`-adjacent shapes; add `pluginType?: string` and `pluginData?: unknown` to `SlateSurface`; add `'plugin'` to `PointAnchor.kind`'s union; update the `SlateSurface.kind` JSDoc to name `'plugin'`.
  - Modify `src/server/stores/slate.ts` — thread `pluginData` through **all four** file-owned merge sites: `synthesizeId` (add to the id basis), `fileOwnedChanged`, `mergeFileOwned`, `createPoint`, plus `PointInput`. This is the 3-place-trap surface (memory `reference_rundata_field_three_places`) — mirror `content` exactly.
  - Modify `src/server/stores/document-store.ts` (`projectRunToSlate`, ~line 972) — derive the `'plugin'` kind and carry `pluginType = p.anchor?.ref` + `pluginData`.
  - Test `src/server/stores/__tests__/` (slate store + document-store projection) — the guard tests below.
- **Approach:** treat `pluginData` as opaque JSON, size-capped (reuse/introduce a `SLATE_PLUGINDATA_MAX`, small — e.g. 8KB). No A2UI validation (it's plugin-private config, not a rendered body).
- **Test scenarios:**
  - A file/user point with `anchor.kind:'plugin', ref:'model-attribution'` projects to a `SlateSurface{ kind:'plugin', pluginType:'model-attribution', pluginData }`.
  - **Merge-trap guards:** changing only `pluginData` bumps `amendedAt` and re-projects (fails if `fileOwnedChanged`/`mergeFileOwned` omit it); two points differing only in `pluginData` get distinct synthesized ids (fails if `synthesizeId` omits it).
  - A re-projection that omits `pluginData` clears it (mirrors `content` clearing).
- **Verification:** `env -u NODE_ENV npx vitest run --exclude='e2e/**'` on the store tests; full typecheck.

### U3 — Placement paths + server surface-hostable gate

- **Goal:** accept `'plugin'` anchors from files and HTTP, gated on the manifest capability.
- **Files:**
  - Create `src/server/api/surfaceHostablePlugins.ts` (small helper) — reads `BUILTIN_PLUGIN_PKGS` (`src/server/api/builtinPluginManifests.ts`), returns the set of widget `type`s whose manifest contribution carries `'surface-hostable'`; export `isSurfaceHostableType(type): boolean`.
  - Modify `src/server/sessions/slate-watcher.ts` — extend `toAnchor` to accept `kind:'plugin'` (keep `ref`); extend `toPointInput` to carry `pluginData`; **drop** a `'plugin'` entry whose `ref` fails `isSurfaceHostableType` (return `null`, like a schema-invalid body).
  - Modify `src/server/api/routes.ts` (`POST /api/runs/:id/slate/points`, ~line 3352) — accept `'plugin'` in the anchor validation, parse `pluginData` (size-capped), and `fail(INVALID_PARAMS)` when `ref` is missing or not surface-hostable.
  - Test `src/server/api/__tests__/` (routes.slate + builtinPluginManifests) and `src/server/sessions/__tests__/` (slate-watcher).
- **Approach:** one shared gate helper used by both entry points so the rule can't drift. Keep the HTTP `notified:false` "eventual, not interrupt" posture unchanged (a plugin surface delivers no agent prompt).
- **Test scenarios:**
  - HTTP POST with `anchor.kind:'plugin', ref:'model-attribution'` → 200, point stored with `pluginData`.
  - HTTP POST with `ref:'browser'` (not surface-hostable) → `INVALID_PARAMS`.
  - HTTP POST with `kind:'plugin'` but no `ref` → `INVALID_PARAMS`.
  - Watcher: a file entry with a non-surface-hostable `ref` is dropped; a valid one projects.
- **Verification:** targeted vitest on routes + watcher; full typecheck.

### U4 — `SlatePanel` dispatch + `PluginSurface` renderer

- **Goal:** render a `'plugin'` surface in the standard hairline card, isolated from siblings.
- **Files:**
  - Create `src/components/RunWorkspaceWidget/PluginSurface.tsx` — looks up `getSurfaceComponent(surface.pluginType)`; renders it with `{ data: surface.pluginData, runId, width }`; wraps in an error boundary (reuse/adapt the pattern of `A2uiErrorBoundary` so one plugin's throw degrades alone); renders a quiet low-ink fallback note when no `surfaceComponent` is registered.
  - Modify `src/components/RunWorkspaceWidget/SlatePanel.tsx` — in the card body dispatch (currently `surface.kind === 'diagram' ? <DiagramSurface…> : <A2ui…>`, ~line 317) add a `surface.kind === 'plugin'` branch → `<PluginSurface …>`. The **outer card shell, controls (⟳/✕), freshness footer stay identical** — a plugin surface must fit the shell (design language: "keep the shell identical across every surface kind"). The `refresh` fast-path badge only shows when `surface.refresh` is set (plugin surfaces won't set it) — no change needed.
  - Test `src/components/RunWorkspaceWidget/__tests__/` (SlatePanel + PluginSurface).
- **Approach:** the card chrome is shared and untouched; only the *body* branch is new. `cyan = live only` (design language) — the plugin surface body owns its own liveness cues; the card's cyan glow remains the refresh signal only.
- **Test scenarios:**
  - A `'plugin'` surface with a registered `surfaceComponent` renders the component and passes `data`/`runId`/`width`.
  - An unregistered `pluginType` renders the fallback note, not a crash, and does NOT take down sibling surfaces (render a plugin surface next to an A2UI surface; assert the A2UI one still renders).
  - A `surfaceComponent` that throws is caught by the boundary; siblings survive.
- **Verification:** targeted vitest (jsdom) on SlatePanel; full typecheck.

### U5 — Wire `model-attribution` as the first rider

- **Goal:** ship one working plugin surface end-to-end.
- **Files:**
  - Modify `src/plugins/model-attribution/package.json` — add `"surface-hostable"` to the widget contribution's `capabilities` (alongside `"spawnable"`).
  - Modify `src/plugins/model-attribution/src/index.tsx` — build a compact surface component (a thin variant/extract of `makeModelAttributionWidget(api)` that shares the same `api.http`/`api.events` data-fetching but renders a slim summary) and pass it as `surfaceComponent` on the `api.widgets.register({...})` call. Keep the existing canvas `component` unchanged.
  - Create `src/plugins/model-attribution/src/ModelAttributionSurface.tsx` — the slim view (fleet model summary + quota headroom in a narrow column); it may read `props.width`/`props.runId` but must NOT use shell hooks.
  - Confirm `src/server/api/builtinPluginManifests.ts` and `src/core/pluginHost/bundled.ts` already include `model-attribution` (they do — **no new registration entry needed**; this is the rare case where the two-place bundled-plugin registration is already satisfied, so the capability just needs to reach the server manifest, which it does because the manifest is `package.json`).
  - Test `src/plugins/model-attribution/src/__tests__/` (or alongside) — surface component renders from injected data.
- **Approach:** extract the shared data hook if it keeps the diff clean; otherwise duplicate the tiny fetch effect into the surface component. Do not touch the canvas widget's behavior.
- **Test scenarios:** `isSurfaceHostableType('model-attribution')` is true; the registration exposes a `surfaceComponent`; the surface component renders a model summary given mocked `/api/state` + `/api/cc-quota` data.
- **Verification:** `env -u NODE_ENV npx vitest run --exclude='e2e/**'`; full typecheck; a manual note in the PR that on a running dev server (`TINSTAR_FAST_SIM=1`) a file-authored `.tinstar/slate/*.json` plugin point renders on the run's Slate (runtime check per memory `feedback_test_before_done`; the standalone :5273 needs a dist rebuild for server-route changes — see `reference_standalone_backend_route_rebuild`, defer live route smoke to the user).

## Scope Boundaries

- **No composer UI** for adding plugin surfaces — placement is file-authored `.tinstar/slate/*.json` + the existing `POST …/slate/points`. (A "add plugin surface" composer entry is a clean follow-up once the render path is proven.)
- **No auto-wrap** of arbitrary canvas widgets; opt-in only, and only bundled plugins (the server gate reads `BUILTIN_PLUGIN_PKGS`; external plugins are deferred).
- **No shell-coupled interactivity** in a surface — `surfaceComponent` is read-only-ish live data; `useData`/`useAttention`/pins/constellations are out of contract.
- **No refresh-recipe semantics** for plugin surfaces (they self-refresh via their own `api.events`/polling); the card's ⟳ still fires the generic nudge harmlessly.
- **One rider only** (`model-attribution`); do not convert other plugins in this PR.
- **No version bump**; one squash-merged PR.

## Risks

- **Shell-context crash (highest):** if the implementer reuses the canvas `component` instead of a dedicated `surfaceComponent`, any shell hook throws in the Slate. Mitigated by decision (b) and the "renders next to an A2UI surface without taking it down" test in U4. The error boundary is the backstop.
- **Silent file-owned-field rot:** `pluginData` must be threaded through all four merge sites in `src/server/stores/slate.ts` or it drops silently on re-projection (memory `reference_rundata_field_three_places`). Mitigated by the U2 merge-trap guard tests that fail when the field is backed out.
- **Hostile `ref`:** a malicious `.tinstar/slate/*.json` could try to mount an arbitrary/nonexistent widget type. Mitigated by the server `isSurfaceHostableType` gate applied at *both* entry points via one shared helper, plus the client fallback note for anything unregistered.
- **Stringly-typed capability typo:** `'surface-hostable'` misspelled = silently not hostable. Low-severity (the gate just refuses placement); mitigate by referencing a single exported constant for the string on both server and client where practical.
- **plugin-api republish:** `surfaceComponent` is an additive optional field on `@tinstar/plugin-api`; the release process (`docs/releasing.md`) gates a separate npm publish on the shipped-surface diff — flag it in the PR body but do not publish as part of this PR.
- **Fleet-vs-run mismatch (product):** `model-attribution` shows fleet-wide data on a single run's Slate; acceptable for proving the path, but note it in the PR so the product call is explicit and a run-scoped second rider can follow.

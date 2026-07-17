---
title: "feat: Roundup — live notice board with agent-authored notices"
date: 2026-07-17
type: feat
origin: docs/brainstorms/2026-07-17-roundup-requirements.md
status: planning
---

# feat: Roundup — live notice board with agent-authored notices

## Summary

Add a new docstore entity — a **notice** — that an agent posts, amends, and pulls over HTTP, plus a standalone **Roundup** widget that renders every run's notices grouped by agent. A notice carries a headline, a kind (`needs-you` or `fyi`), and a markdown background. This is the read+author foundation of the Roundup; interactive answer-back and A2UI rendering are deferred to later PRs.

---

## Problem Frame

Tinstar's primary user runs many agent sessions in parallel on unrelated topics. The scarce resource is attention, and the expensive act is re-entering a session after time away — today that means scrolling the terminal or asking the agent for a recap, paid fresh on every switch. The Roundup inverts this: each agent keeps a standing brief of what it needs and what it decided, so arriving is a glance, not a round trip.

This PR builds the durable, live, agent-authored substrate: an agent can post a notice, amend it in place, and pull it, and the user sees those changes without reloading. It deliberately stops short of the interactive controls and the A2UI renderer — see Scope Boundaries.

---

## Requirements

Traceability is to the origin brainstorm (`docs/brainstorms/2026-07-17-roundup-requirements.md`). This PR covers a subset; deferred requirements are listed under Scope Boundaries.

- R1. Standalone widget, palette-spawnable, space-scoped. *(origin R1)*
- R2. Sectioned by agent/run, each section attributed to its run. *(origin R2)*
- R4. Renders two notice kinds, visually distinct at a glance. *(origin R4)*
- R5. Readable without expanding — every notice shows a scannable headline before detail. *(origin R5)*
- R8. A notice carries a headline and expandable background. *(origin R8)*
- R9. Background rendered as markdown (the de-nerd depth bar is enforced by the agent skill, not code). *(origin R9)*
- R12. A notice may carry links out to external systems — satisfied for now by links inside the markdown background. *(origin R12, partial)*
- R17. An agent can amend a posted notice in place; the change reaches the user live. *(origin R17)*
- R18. An agent can pull a notice it posted. *(origin R18)*
- R20. A notice does not outlive the run that posted it. *(origin R20)*
- R21. A notice records when it was posted and when it was last amended. *(origin R21)*
- R25. An agent skill documents the protocol: when to post, what belongs in each kind, the de-nerd depth bar, and — most importantly — when to amend and pull. *(origin R25)*

---

## Key Technical Decisions

**KTD1 — Notice is a first-class docstore entity, modeled on `ImageWidget`, mutated like `upsertRun`/`upsertTombstone`.** `ImageWidget` (`src/domain/types.ts:361`) is the closest existing shape (flat, run-scoped). But `ImageWidget`/`Artifact`/`BrowserWidget` mutators predate the equality-short-circuit contract and must NOT be copied for the mutator; follow `upsertRun` (`src/server/stores/document-store.ts:393`) and `upsertTombstone` (`:781`) instead, which the contract at `document-store.ts:1-18` mandates. A dedicated `noticeEqual(a, b)` comparator mirrors `tombstoneEqual` (`:158`).

**KTD2 — The Roundup is a bundled plugin widget, not a host widget.** Mirror `graveyard` (`src/plugins/graveyard/`) end to end: a palette-spawnable, `creator: standalone` widget registered via `api.widgets.register`. This matters because plugins read docstore state over HTTP + a `delta` subscription (the ADR-0002 boundary — plugins do not import `useServerEvents`). Consequence: **no `useServerEvents.ts` reducer edits are needed** — the widget fetches `GET /api/notices` and refreshes when it sees a `notice.updated` delta, exactly as `GraveyardWidget` does for `tombstone.updated` (`src/plugins/graveyard/src/GraveyardWidget.tsx:41-65`).

**KTD3 — Liveness rides the generic SSE path; no SSE-server changes.** The broadcaster (`src/server/api/sse.ts:15`) turns any mutator `change` into a `delta` generically. Emitting `this.changes.emit('change', { entity: 'notice', id, data })` is sufficient to reach the client. Adding `'notice.updated'` to the `BusEvent` union (`src/server/types.ts`) is optional (the broadcaster casts) and is skipped unless typecheck requires it.

**KTD4 — Run-end cleanup is a docstore cascade inside `deleteRun`, not a route-level afterthought.** Mirror the `deleteBrowserWidget → deleteArtifact` cascade (`document-store.ts:572`). Putting the notice-drop inside both branches of `deleteRun` (`:408-429`), plus `clearSpace` (`:858`) and `clear` (`:882`), guarantees a notice cannot outlive its run regardless of which path removes the run (R20). Keying: `deleteRun` is called with the session **name**, which is the run's `.id`; `Notice.runId` holds that run id, and the cascade filters `notice.runId === deletedRunId`.

**KTD5 — Size caps on `headline` and `background`.** Follow the plugin-widget 413 pattern (`routes.ts:2563`). Cap `headline` (e.g. 200 chars) and `background` (e.g. 16KB) so a malformed post can't bloat the persisted snapshot. Exact limits are an execution-time detail; the cap mechanism is the decision.

---

## Output Structure

New files (mirrors the `graveyard` plugin layout):

```
src/plugins/roundup/
  package.json                 # tinstar manifest: widget contribution
  src/
    index.tsx                  # activate(api) → api.widgets.register
    RoundupWidget.tsx          # the read UI: fetch + delta-refresh, grouped by run
agent-skills/skills/roundup-notices/
  SKILL.md                     # how an agent posts/amends/pulls a notice
src/server/stores/__tests__/
  document-store.notices.test.ts
src/server/api/__tests__/
  routes.notices.test.ts
```

Modified files: `src/domain/types.ts`, `src/server/stores/document-store.ts`, `src/server/api/routes.ts`, `src/core/pluginHost/bundled.ts`.

---

## Implementation Units

### U1. Notice type + docstore entity

**Goal:** Define `Notice` and give the docstore full CRUD with the equality-short-circuit contract, hydration, snapshots, and run-end cascade.

**Requirements:** R17, R18, R20, R21.

**Dependencies:** none.

**Files:**
- `src/domain/types.ts` (add `Notice` interface)
- `src/server/stores/document-store.ts` (import; `notices` Map; `noticeEqual`; `upsertNotice`/`deleteNotice`/`getAllNotices`/`getNotice`; hydration; `snapshot` + `snapshotAll`; `deleteRun` cascade; `clearSpace` + `clear`)
- `src/server/stores/__tests__/document-store.notices.test.ts`

**Approach:**
- `Notice = { id, runId, kind: 'needs-you' | 'fyi', headline, background, createdAt, amendedAt }`. `amendedAt` records last amend (R21); set equal to `createdAt` on post.
- `upsertNotice` reads prev from the Map, returns early if `noticeEqual(prev, next)`, else sets + emits `change` with `entity: 'notice'`. `deleteNotice` returns bool, guards on presence, emits `change` with `data: null` (mirror `deleteTombstone` `:800`).
- Hydration: in the constructor load block (near `:231`), `if (data.notices) for (const n of data.notices) this.notices.set(n.id, n)`, with the corrupt-entry `id` skip guard used by runs/tombstones.
- `snapshot()` (`:811`) and `snapshotAll()` (`:833`): include `notices`. In space-filtered `snapshot`, run-scoped notices with no `spaceId` pass the `inSpace` filter (matches `Artifact`).
- `deleteRun` cascade: in both the direct-key and `sessionId`-fallback branches, iterate `this.notices` and `deleteNotice` any whose `runId` matches the removed run's id. Add notice-clearing to `clearSpace` and `clear`.

**Patterns to follow:** `upsertRun` (`:393`), `upsertTombstone` (`:781`), `tombstoneEqual` (`:158`), `deleteTombstone` (`:800`), `deleteBrowserWidget → deleteArtifact` cascade (`:572`), `getAllImageWidgets` (`:755`).

**Test scenarios** (`document-store.notices.test.ts`):
- Post: `upsertNotice` on a new id stores it and emits one `change` with `entity: 'notice'`.
- Amend: `upsertNotice` with a changed `headline` emits exactly one `change`; `amendedAt` differs from `createdAt`.
- Equality short-circuit: `upsertNotice` with a value equal to the stored one emits **zero** `change` events (spy on `changes`). *This is the contract test — it must fail if the short-circuit is removed.*
- Pull: `deleteNotice` on an existing id removes it and emits a `change` with `data: null`; on a missing id returns `false` and emits nothing.
- Run-end cascade (Covers AE3 / origin R20): with two notices whose `runId` is a run's id, `deleteRun(runId)` removes both notices and emits a `change: null` for each. A notice with a different `runId` survives.
- Persistence round-trip: `snapshotAll()` includes notices; a fresh store hydrated from that JSON returns them via `getAllNotices()`.

**Verification:** vitest green for the new file; the short-circuit test fails when the guard is reverted.

### U2. Agent-facing HTTP API (`/api/notices`)

**Goal:** POST (post), PATCH (amend), DELETE (pull), and GET (list) for notices, authored by a managed session.

**Requirements:** R12 (partial), R17, R18, R21.

**Dependencies:** U1.

**Files:**
- `src/server/api/routes.ts` (four handlers)
- `src/server/api/__tests__/routes.notices.test.ts`

**Approach:**
- `POST /api/notices`: body `{ sessionId, kind, headline, background }`. Resolve the run via `ctx.docStore.getAllRuns().find(r => r.sessionId === sessionId)`; 404 `SESSION_NOT_FOUND` if absent. Validate `kind ∈ {needs-you, fyi}` and non-empty `headline`; enforce size caps (KTD5) with a 413. Generate `shortId('notice')`, stamp `createdAt = amendedAt = now`, set `runId` to the resolved run's id. `upsertNotice`, respond `ok(res, notice)`.
- `PATCH /api/notices/:id`: fetch existing (404 if absent), JSON-parse a partial `{ kind?, headline?, background? }`, spread `{ ...existing, ...patch, amendedAt: now }`, re-`upsertNotice`, `ok(res, updated)`.
- `DELETE /api/notices/:id`: 404 if absent, `deleteNotice`, `ok(res, null)`.
- `GET /api/notices`: `ok(res, ctx.docStore.getAllNotices())` (the widget's initial load).

**Patterns to follow:** `POST /api/image-widgets` (`routes.ts:1931`), `PATCH /api/browser-widgets/:id` (`:2350`), `DELETE /api/image-widgets/:id` (`:1998`), `GET /api/graveyard` (`:3551`), the `ok`/`fail` envelope (`src/server/api/envelope.ts`), the 413 cap (`:2563`).

**Test scenarios** (`routes.notices.test.ts`):
- POST happy path: valid body against a known `sessionId` returns `{ ok: true, data }` with a generated `id`, `runId` set, and timestamps equal.
- POST unknown session: returns `SESSION_NOT_FOUND` (404).
- POST invalid kind / empty headline: returns `INVALID_PARAMS` (400).
- POST oversized background: returns 413.
- PATCH amend: changing `headline` returns the updated notice with a later `amendedAt`; PATCH on a missing id returns 404.
- DELETE existing vs missing: 200 then 404.
- GET list: returns all notices as `{ ok: true, data: [...] }`.

**Verification:** vitest green; envelope shapes and status codes match existing routes.

### U3. Roundup widget (bundled plugin)

**Goal:** A palette-spawnable widget that lists notices grouped by run, each showing a kind indicator, a scannable headline, and an expandable markdown background. Read-only.

**Requirements:** R1, R2, R4, R5, R8, R9, R12 (partial).

**Dependencies:** U2 (needs `GET /api/notices` + the `notice.updated` delta).

**Files:**
- `src/plugins/roundup/package.json`
- `src/plugins/roundup/src/index.tsx`
- `src/plugins/roundup/src/RoundupWidget.tsx`
- `src/core/pluginHost/bundled.ts` (register the plugin in `BUNDLED_PLUGINS`)

**Approach:**
- Manifest: one widget contribution `{ type: 'roundup', label: 'Roundup', spawn: 'palette', capabilities: ['spawnable'], creator: 'standalone', defaultSize, icon }`, mirroring `graveyard/package.json`.
- `index.tsx`: `activate(api)` returns `api.widgets.register({ type: 'roundup', component, isContainer: false, defaultSize, minSize, dragHandleSelector: '.widget-drag-handle' })`.
- `RoundupWidget.tsx`: on mount, `api.http.fetch('/api/notices')` → `body.data`; subscribe to `api.events.subscribe('delta', msg => msg?.eventType === 'notice.updated' && reload())`. Group notices by `runId`; render a section header per run (attribution), then each notice as a row: a kind badge (needs-you vs fyi visually distinct — color/label), the headline always visible, and a collapsible body rendering `background` via the existing `react-markdown`. Style with host Tailwind classes (the plugin is in the host tree; `graveyard` does this).
- Register in `bundled.ts` alongside `graveyard`.

**Patterns to follow:** `src/plugins/graveyard/src/index.tsx`, `src/plugins/graveyard/src/GraveyardWidget.tsx` (fetch + delta-refresh + drag handle), existing `react-markdown` usage in the recap renderer (`src/components/PromptComposer/PromptComposer.tsx`).

**Test scenarios:** `Test expectation: none — presentational widget with no branching logic beyond grouping; covered manually at runtime and by the route/store unit tests upstream.` (If the grouping helper is extracted as a pure function, add a small unit test that it buckets notices by `runId` and preserves order.)

**Verification:** `npm run build:all` succeeds with the new plugin bundled; at runtime, posting a notice via `curl` makes a row appear in the widget without reload, and pulling it removes the row.

### U4. Agent skill — how to post/amend/pull a notice

**Goal:** Teach agents the protocol at de-nerd depth, with copy-pasteable curl.

**Requirements:** R25 (and enforces R9's depth bar by instruction).

**Dependencies:** U2 (documents its API).

**Files:**
- `agent-skills/skills/roundup-notices/SKILL.md`

**Approach:** Mirror `agent-skills/skills/tinstar/SKILL.md`: YAML frontmatter (`name`, `description`), a `TINSTAR_URL` var, and `## ` sections with `curl … | jq '.data'` examples for post/amend/pull and the `{ok, data}` envelope. Sections cover: when a `needs-you` vs an `fyi` notice is appropriate; the depth bar for `background` (plenty of plain-language context, jargon unpacked — because the user arrives cold); and — called out prominently — the obligation to **amend** when the situation changes and **pull** when the notice is resolved, so the board never goes stale.

**Test scenarios:** `Test expectation: none — documentation.`

**Verification:** `SKILL.md` frontmatter parses; curl examples match the routes built in U2.

---

## Scope Boundaries

### Deferred to Follow-Up Work
- **A2UI / `@a2ui/web_core` rendering** (origin R14–R16). This PR renders backgrounds as plain markdown; A2UI component descriptions and the themed component mapping come next.
- **Interactive controls** (origin R10, R11): radio/checkbox choice sets and free-text input.
- **Answer-back path** (origin R22, R23): submitting a choice/text to the agent, and the FYI dissent affordance (origin R13). The widget is read-only here.
- **Auto-anchored lifecycle** (origin R19): posting on block / retracting on unblock via the status watcher. Agents post/amend/pull manually via the API in this PR.
- **Immediate submit feedback** (origin R24).
- **Graceful-degrade on invalid component descriptions** (origin R16) — moot until A2UI lands; plain markdown has no schema to fail.

### Non-goals (this feature, any PR)
- Replacing the sidebar Inbox or the telemetry rail — both stay untouched.
- Deriving notices from transcripts — notices are agent-authored by design.

---

## Risks & Dependencies

- **No new npm dependency, no React bump.** Rendering uses the existing `react-markdown`. Adding `@a2ui/*` or upgrading React is explicitly out of scope; `@a2ui/react` requires React 19 and this repo is React 18 (see origin Dependencies).
- **Keying mismatch on cleanup.** `deleteRun` receives the session name (the run's `.id`), while `.sessionId` is distinct. If `Notice.runId` is keyed to the wrong one, the cascade misses. U1's cascade test guards this explicitly.
- **Space-filter on notices.** Run-scoped notices carry no `spaceId`, so they pass the `snapshot` `inSpace` filter unconditionally (same as `Artifact`). Acceptable for v1; a later PR can scope notices to a space if cross-space bleed becomes a concern.
- **Unrelated WIP in the tree.** `src/server/sessions/workspace.ts` and a stray test are the user's — never staged. Work happens in a separate worktree off `origin/main`.

---

## Verification Strategy

Pre-merge gate (matches CI `typecheck-and-test`):
- `npm run typecheck` — three tsconfigs, zero errors.
- `npm run build:all` — vite client + esbuild server; confirms the new plugin bundles.
- `npx vitest run --exclude='e2e/**'` — the two new unit test files plus the existing baseline.
- `npm run check:case` — case-collision guard (CI runs it).

Runtime spot-check (per the lightsout verification note, without disturbing the user's running server): post a notice via `curl` to a live session, confirm the row appears in the Roundup widget, amend it and confirm the row updates in place, pull it and confirm the row disappears, then delete the run and confirm its notices vanish.

---

## Sources & Research

- `docs/brainstorms/2026-07-17-roundup-requirements.md` — origin requirements (R1–R25), acceptance examples, A2UI dependency analysis.
- `src/server/stores/document-store.ts:1-18` — the mutator equality-short-circuit contract this plan mirrors.
- `src/plugins/graveyard/` — the bundled-plugin template for a palette-spawnable, docstore-reading widget (`index.tsx`, `GraveyardWidget.tsx`, `package.json`).
- `src/server/api/sse.ts:15` — the generic `change → delta` broadcaster (why no SSE-server edits are needed).
- `src/server/api/routes.ts` — route patterns: image-widgets (`:1931`, `:1998`), browser-widgets PATCH (`:2350`), graveyard GET (`:3551`); envelope in `src/server/api/envelope.ts`.
- `docs/contributing.md`, `docs/conventions.md` — branch/PR flow, squash-merge, `getConfigRoot()`, `apiFetch`/`apiUrl`, the BusEvent recipe.

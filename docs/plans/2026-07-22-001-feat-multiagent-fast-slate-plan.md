---
title: "feat: Multi-agent, fast Slate — code-spawned surface authors"
date: 2026-07-22
type: feat
origin: docs/brainstorms/2026-07-22-multiagent-fast-slate-requirements.md
depth: deep
status: ready-for-ce-work
---

# feat: Multi-agent, fast Slate — code-spawned surface authors

## Summary

Get Slate surface authoring off the run's single main agent. When a surface carries a self-contained `refresh` recipe, refreshing it **spawns a fresh, one-shot author** (a headless child process, cheap model, in the run's workdir) that executes the recipe and writes the surface file — the watcher projects it as usual. The main agent is never involved. Surfaces without a recipe keep the current main-agent path unchanged, which cleanly covers session-derived surfaces and the existing recipe-less backlog with no migration.

Because `claude -p` has a poor reliability track record (turn-budget wandering, returns-nothing), the headless author ships as a **cheap, isolated, kill-switchable spike behind a single seam** — the current path stays intact as the fallback, and the same seam can swap to a real agentic subagent (fork A) if the spike proves too dumb for even this tight, mechanical job.

---

## Problem Frame

Every Slate interaction (refresh, compose, explain, re-author) delivers a prompt to ONE session — the run's main agent — so N surface changes run serially through a single-threaded agent, and all upkeep bottlenecks through it (see origin: `docs/brainstorms/2026-07-22-multiagent-fast-slate-requirements.md`). Research confirmed there is **no existing headless/one-shot agent runner** in the codebase — every managed agent is a persistent tmux+ttyd session — so the offload path is a new (small) primitive, not a reuse of the session stack.

---

## Requirements (trace to origin)

- **R1** — Refreshing a source-derived surface consumes no main-agent turn and does not block the user ("you never even know it refreshed").
- **R2** — The `refresh` recipe is the self-contained authoring contract; a surface is treated as source-derived **iff it carries a recipe** (recipe-presence classifier, confirmed).
- **R3** — Session-derived and recipe-less surfaces keep the current main-agent path (no migration; graceful fallback).
- **R4** — The author executes a file-authored recipe → the injection GUARDRAIL + `oneLine()` are load-bearing; author runs semi-trusted with the run's own permissions; a planted recipe is a documented residual threat.
- **R5** — The offload must be a cheap, isolated, removable spike with a kill switch and a fallback seam.
- **R6** — Recipes are captured at create-time so surfaces are born handoff-able.
- **R7** — The Slate skill + authoring reference teach the expectation so every run's agent inherits it.
- **R8** — No regression: projection, SSE, per-surface bounded spinner, `amendedAt` freshness, and the zero-change short-circuit stay coherent under async author writes.

---

## Key Technical Decisions

- **KTD1 — A one-shot child process, not a session/hand.** Authors are a bare `claude -p` child (`execFile`), `cwd` = run workdir, **no tmux, no ttyd, no persisted session record, no Run tile.** Reusing `createTmuxSession`/hands would spam session dirs + Run tiles and exhaust the 100-port ttyd ceiling (research §6). Completion is fire-and-forget: **the file appearing is the signal** (the existing `SlateWatcher` projects it); the child's exit code is a secondary/log signal. No new NATS handshake.
- **KTD2 — Model via a dedicated author CLI template, not the `model` override param.** The per-session `model` override is rejected unless `switchboard.allowedModels` is seeded (defaults to `[]` → `OVERRIDE_MODEL_NOT_CONFIGURED`). A dedicated `slate-author` template bakes the model into its command (the ungated path). Default the spike to a **capable** model (not the cheapest) to give `claude -p` its best shot; tune toward faster/cheaper once quality is proven.
- **KTD3 — Recipe-presence is the classifier.** Surface has a self-contained recipe → spawn author; no recipe → current `deliverSlatePrompt` main-agent path. No new field, no 3-place RunData change; backlog + session-derived degrade gracefully. Leans on recipes actually being self-contained (enforced at create-time, U4).
- **KTD4 — No new RunData field for v1.** Author status rides the **existing** bounded spinner: the refresh POST returns `dispatched:true` immediately; the client spinner clears on a newer `amendedAt` (file landed) OR the existing timeout (author wandered/returned nothing). A dumb author is therefore *visible* (spinner times out) without new server-owned state — avoiding the silent-clearable-field trap (`docs/solutions/integration-issues/sse-delta-drops-undefined-keys-stale-client-state.md`).
- **KTD5 — Kill switch + seam.** A single dispatch function (`dispatchSurfaceAuthor`) is the seam the route calls; a config flag disables the author path (falls back to the main-agent nudge) with no code revert. Ripping out the spike = revert one module + the route branch.
- **KTD6 — Injection posture (semi-trusted).** The delivered prompt reuses `slateRefreshPromptText` (already GUARDRAIL-framed + `oneLine()`d). The author runs with the run's own permission scope; a recipe planted by an untrusted branch/process is a documented residual risk, not mitigated by sandboxing in v1 (see Risks).

---

## High-Level Technical Design

Refresh flow after this change (the branch is the whole feature):

```mermaid
sequenceDiagram
    participant U as User (client)
    participant R as Refresh route
    participant A as Author (claude -p child)
    participant W as SlateWatcher
    participant S as Store → SSE

    U->>R: POST /slate/surfaces/:id/refresh
    alt surface has a self-contained recipe (source-derived)
        R->>A: spawn headless child (cwd=workdir, GUARDRAIL'd recipe, author model)
        R-->>U: { dispatched: true }  (returns in ms; main agent uninvolved)
        A->>A: execute recipe, validate, write .tinstar/slate/<id>.json
        A--xR: exit (code logged; no await)
        W->>S: file appears → projection → amendedAt advances
        S-->>U: SSE run delta → spinner clears (newer amendedAt)
    else no recipe (session-derived / backlog)
        R->>R: deliverSlatePrompt → main agent (UNCHANGED)
        R-->>U: { delivered }
    end
    Note over U: If the author wanders/returns nothing,<br/>the file never changes → the bounded<br/>spinner TIMES OUT (dumb author is visible)
```

---

## Implementation Units

### U1. Author CLI template + `slate.author` config (model, timeout, kill switch)

**Goal:** Add the ungated model path and the spike's config knobs.
**Requirements:** R2, R5, KTD2, KTD5.
**Dependencies:** none.
**Files:** `src/server/sessions/config.ts` (add a `slate-author` entry to `DEFAULT_CLI_TEMPLATES`; add a `slate.author` config block), `src/server/sessions/__tests__/config.test.ts` (or the nearest existing config test).
**Approach:** A `slate-author` CLI template whose command runs `claude -p` non-interactively with a baked `--model <capable-default>`. A `slate: { author: { enabled: boolean; model?: string; timeoutMs: number } }` config block (default `enabled: true`, a sane `timeoutMs`). Kill switch = `enabled:false` → the route seam falls back to the main-agent path. Do NOT touch `switchboard.allowedModels` (KTD2 avoids that path).
**Patterns to follow:** the Marshal template baking `--model sonnet` (`config.ts` ~line 172); config merge shape around `config.ts:246`/`:322`.
**Test scenarios:** the `slate-author` template resolves by name and carries a `--model` flag; `slate.author` defaults (enabled true, timeout set) load; a user config can override `enabled`/`model`/`timeoutMs`; `Covers R5.` disabling `enabled` is readable by the seam (asserted in U3).

### U2. The one-shot surface-author primitive (isolated, removable)

**Goal:** Spawn a headless author child that runs a recipe and exits; fire-and-forget.
**Requirements:** R1, R4, R5, R8, KTD1, KTD4, KTD6.
**Dependencies:** U1.
**Files:** `src/server/sessions/surfaceAuthor.ts` (new — the whole spike lives here), `src/server/sessions/__tests__/surfaceAuthor.test.ts`.
**Approach:** Export `dispatchSurfaceAuthor(ctx, runId, point): { dispatched: boolean }`. Resolve workdir via `getSession(cfg.dirs.sessions, runId)?.workspace?.path` (research §4). Build the prompt from `slateRefreshPromptText(point, serverBase())` (already GUARDRAIL + `oneLine()`). `execFile` the `slate-author` template's `claude -p` with `cwd = workdir`, **no tmux, no ttyd, no session/run entity**, a hard timeout from `slate.author.timeoutMs` (kill the child on timeout). Do NOT `await` completion — return `{ dispatched:true }` as soon as the child is launched. Log exit code + duration + timeout for observability. When `slate.author.enabled` is false, return `{ dispatched:false }` so the caller falls back. Never throw into the request path — a spawn failure returns `dispatched:false`.
**Execution note:** Start with a failing test that asserts the child is launched with `cwd=workdir` and a GUARDRAIL'd prompt (mock the process spawn), and that the request does not block on completion.
**Patterns to follow:** `buildAgentCommand` template interpolation (`tmux.ts:341`) for command assembly; the command-assembly trap (split the prompt tail once — `docs/solutions/tooling-decisions/per-session-mcp-config-outside-the-repo.md`); `deliverSlatePrompt` never-throws posture (`routes.ts:1053`).
**Test scenarios:** dispatch launches a child with `cwd` = the run's resolved workdir; the prompt passed carries the GUARDRAIL line and the recipe verbatim; a recipe with embedded newlines/`SYSTEM:` is `oneLine()`-collapsed (injection guard); `enabled:false` returns `dispatched:false` and launches nothing; a spawn error returns `dispatched:false` (no throw); the call returns without awaiting child exit (fire-and-forget); on timeout the child is killed and logged. `Covers R4.` the injection-framed prompt. `Covers R5.` the kill-switch fallback.

### U3. Refresh + compose route branch (author when recipe present, else main-agent)

**Goal:** Wire the seam into the routes; keep the fallback path byte-for-byte.
**Requirements:** R1, R3, R8, KTD3, KTD5.
**Dependencies:** U2.
**Files:** `src/server/api/routes.ts` (the `/slate/surfaces/:pid/refresh` handler ~line 3507, and `/slate/compose` ~line 3528), `src/server/api/__tests__/routes.slate.test.ts`.
**Approach:** In the refresh handler: if the surface's point carries a non-empty `refresh` recipe AND `slate.author.enabled`, call `dispatchSurfaceAuthor` and return `{ dispatched:true }`; otherwise the existing `deliverSlatePrompt` path unchanged (`{ delivered }`). Compose: the template/freeform IS the recipe → dispatch an author for the new surface the same way (it re-derives from the composed instruction). **Explain stays main-agent** (session-derived — do not offload). Refresh-all needs no server change: each per-surface POST now returns fast (a dispatch, not a turn), so the existing client serialize becomes N fast dispatches instead of N slow turns — the win lands without touching the client serialize (which stays correct for the main-agent fallback surfaces).
**Patterns to follow:** the anchored-regex-before-greedy route ordering already in place; the `{ ok, data }` envelope; `routes.slate.test.ts` pluginTest harness.
**Test scenarios:** a surface WITH a recipe → author dispatched, `deliverSlatePrompt` NOT called, returns `dispatched:true`; a surface WITHOUT a recipe → `deliverSlatePrompt` called (unchanged), author NOT spawned; `slate.author.enabled:false` → recipe surface still falls back to `deliverSlatePrompt`; compose with a template → author dispatched; explain → still main-agent (unchanged). `Covers R1, R3.` `Covers R8.` persist-nothing preserved (the author writes the file; the route persists nothing).

### U4. Create-time recipe capture in the composer + catalog

**Goal:** Make the self-contained recipe first-class so new surfaces are born handoff-able.
**Requirements:** R2, R6.
**Dependencies:** none (client-only; independent of U1–U3).
**Files:** `src/components/RunWorkspaceWidget/SlateComposer.tsx`, `src/components/RunWorkspaceWidget/surfaceCatalog.ts`, `src/components/RunWorkspaceWidget/__tests__/SlateComposer.test.tsx`.
**Approach:** The freeform composer gains a "how does this stay fresh?" affordance that captures a recipe passed through to `/slate/compose`, with inline guidance that a good recipe names **source / derivation / output**. Catalog templates already carry recipes — surface that recipe in the composer preview so the user sees/edits it. Not a hard block in v1 (a recipe-less surface is a valid *static* surface); nudge strongly. Cap the recipe length like the sibling composer inputs.
**Patterns to follow:** the existing composer fuzzy-search + freeform submit; `surfaceCatalog.ts` template `prompt`/recipe fields.
**Test scenarios:** submitting a template surfaces its recipe in the compose payload; a freeform recipe is passed through; an over-long recipe is bounded; a static (no-recipe) surface still submits. `Covers R6.`

### U5. Teach the expectation — Slate skill + authoring reference

**Goal:** Every run's agent inherits the recipe-as-contract + vacuum-test + dispatch behavior.
**Requirements:** R7.
**Dependencies:** none (docs).
**Files:** `agent-skills/skills/the-slate/SKILL.md`, `docs/solutions/documentation-gaps/slate-surface-authoring-contract.md` (extend — the "reply is not an update" and freshness discipline already landed there).
**Approach:** Document: a living surface MUST carry a self-contained recipe (source/derivation/output); the vacuum test (can the recipe refresh in a vacuum?) sorts source-derived vs session-derived; source-derived surfaces are refreshed by a spawned author, so the recipe must stand alone; session-derived stay with the main agent. Note the classifier (recipe presence) and the semi-trusted author posture.
**Test expectation:** none — documentation only.

---

## Scope Boundaries

**In scope:** the one-shot author primitive; the refresh/compose route branch with main-agent fallback; the author template + kill-switch config; create-time recipe capture; the skill/authoring-reference update.

### Deferred for later (from origin)
- **Fork C** — per-surface self-tending daemons that watch their source and re-author unprompted.
- A formal **live-query surface type** that refreshes with no agent at all (pure data/query).
- Reworking the recipe schema to separate a "dispatch flag" from the "authoring instruction."

### Deferred to Follow-Up Work
- **Fork A as the fallback impl** — if the `claude -p` spike proves too dumb, swap `dispatchSurfaceAuthor` to dispatch a real agentic subagent. Same seam; a follow-up once the spike is judged.
- Client-side parallelization of author dispatches in refresh-all (v1 relies on dispatches simply being fast).
- Tuning the author model down toward cheap/fast once quality is proven.
- A `/ce-compound` capture of the config-isolation/ttyd learning if authors ever move to a second backend (they do not in v1).

---

## Risks & Dependencies

- **`claude -p` quality (the headline risk).** May wander, burn budget, or return nothing on even this tight task. Mitigations: a self-contained recipe (small, bounded task), a capable default model, a hard timeout, and the bounded spinner making failure *visible*. The spike is isolated + kill-switchable so a bad result costs one revert, and fork A is the ready fallback.
- **Injection (semi-trusted author).** The author executes a file-authored recipe with the run's permissions. GUARDRAIL + `oneLine()` frame it; a recipe planted by an untrusted branch/process is a **documented residual threat** not sandboxed in v1. Revisit if authors ever run against untrusted worktrees.
- **ttyd port / Run-tile churn** — avoided by KTD1 (the author is a bare child, not a session). Verify no session dir / Run tile / ttyd port is created per author.
- **New route behavior on the standalone** — the refresh route already exists, but its new branch won't be live until a dist rebuild + restart (`docs/solutions/test-failures/e2e-session-scoped-api-routes-return-spa-html.md`); unit-test the handler, defer live smoke to the user's rebuild (do not restart their :5273).
- **Toolchain:** prefix `tsc`/`vitest`/`vite` with `env -u NODE_ENV`; `vitest --exclude='e2e/**'`; full `npm run typecheck` before done; do not touch the package version; squash-merge one feature-cohesive PR.

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-07-22-multiagent-fast-slate-requirements.md`.
- Spawning substrate (research): `createSessionInternal`/`deliverSlatePrompt`/slate routes in `src/server/api/routes.ts`; `buildAgentCommand`/`createTmuxSession`/`findPort` in `src/server/sessions/backends/tmux.ts`; `DEFAULT_CLI_TEMPLATES`/`validateSessionOverride`/`allowedModels` in `src/server/sessions/config.ts`; workdir wiring in `src/server/index.ts` (~line 484); `SlateWatcher.slateDir` in `src/server/sessions/slate-watcher.ts`; `PointInput.refresh` in `src/server/stores/slate.ts`; `slateRefreshPromptText` in `src/slate/slatePrompt.ts`.
- Learnings: `docs/solutions/conventions/agent-prompt-delivery-and-surface-refresh.md` (injection guardrail, bounded spinner, serialize fan-out), `docs/solutions/documentation-gaps/slate-surface-authoring-contract.md` (the authoring contract + silent-failure gates), `docs/solutions/tooling-decisions/per-session-mcp-config-outside-the-repo.md` (command-assembly trap), `docs/solutions/integration-issues/sse-delta-drops-undefined-keys-stale-client-state.md` (why KTD4 avoids a new field), `docs/solutions/test-failures/e2e-session-scoped-api-routes-return-spa-html.md` (route-rebuild trap).

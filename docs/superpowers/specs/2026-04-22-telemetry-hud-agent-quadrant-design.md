# Telemetry HUD — Agent Quadrant & Visible Toggle

**Date:** 2026-04-22
**Status:** Design
**Scope:** Telemetry HUD (top-right canvas overlay)

## Problem

The telemetry HUD shows aggregate cost/tokens/cache, but doesn't show how many agents are actually working. Two weaknesses:

1. **No fleet view.** During multi-agent orchestrations there is no single place to see "how many of my agents are doing anything right now."
2. **Status field isn't reliable yet.** `status === 'running'` is a tmux/process-tree heuristic. It can disagree with reality (e.g. a subagent burning tokens while the parent's terminal is quiet, or a session waiting on a long bash command — legitimately working but quiet on the LLM).

We also want the HUD hide-able with a visible ✕ button (currently only togglable via the `T` hotkey, matching the minimap's UX).

## Design

### Two honest axes, not one

Rather than collapse agent state into a single (unreliable) "working" flag, the HUD exposes two orthogonal signals:

- **BUSY** — tinstar reports `status === 'running'` (process-tree says something is happening on the terminal). Everything else (`idle`, `creating`, `needs_attention`) is classified as **READY** — this matches the existing `READY_STATUSES` set in `src/server/sessions/ReadyQueue.ts:4`, which is the same population reachable via the `ctrl+[` ready-queue navigation. Using the codebase's own vocabulary keeps the mental model aligned: a dot on the READY side is a dot you can send input to. `needs_attention` is an alert condition, not an activity state — it belongs on the READY side.
- **LLM** — telemetry reports non-zero token rate in the last ~30s for this session (Anthropic API is being called)

Neither is a proxy for the other. `BUSY ∧ ¬LLM` is common and honest (ota-testing-tester waiting on a 90s bash build). `LLM ∧ ¬BUSY` is common and honest (parent waiting on a Task-tool subagent that shares the parent's session_id).

### The quadrant

A 2×2 grid under the existing HudBars. Axes labeled. Each quadrant tells a story:

```
              BUSY            READY
          ┌─────────────┬─────────────┐
     LLM  │  WORKING    │  SUBAGENT   │
          │   ● ● ●     │      ●      │
          ├─────────────┼─────────────┤
    quiet │   TOOL      │   IDLE      │
          │  ● ● ● ●    │  ● ● ● ●    │
          └─────────────┴─────────────┘
```

One avatar per **alive** session (`status !== 'stopped'`). Avatars are rendered by `<AgentIcon>` (see §Agent Avatars below): explicit template icon if the run has one, otherwise a procedurally-generated DiceBear `bottts-neutral` SVG seeded by `run.id` and tinted with `run.color`. Each avatar sits inside a small circular ring in the run's accent color so the agent is identifiable both by face and by color.

### Animation

When an agent transitions quadrants (status changes, starts/stops burning tokens), the dot animates from its old cell to the new one. CSS `transform` + `transition: transform 400ms ease-out`. No framer-motion needed.

Dots within a cell lay out as a `flex-wrap` grid of small circles. When a new dot arrives, it slots in; when one leaves, remaining dots reflow.

### Interaction

- **Hover a dot:** tooltip shows session name (and optionally its current status).
- **Click a dot:** call the existing `onFocusRun(runId)` prop — this already pans and centers the canvas on that session's widget.
- **Dot cursor:** pointer.

### HUD toggle parity with minimap

When HUD is visible:
- Show a ✕ button in the top-right corner, opacity 0 by default, opacity 1 on hover (same pattern as `CanvasMinimap.tsx:257-264`).
- Clicking ✕ hides the HUD (same behavior as the `T` hotkey — toggles `visible` state, persisted in `tinstar-hud-visible` localStorage).

When HUD is hidden:
- Show a small icon button near the existing minimap toggle (top-right area, e.g. `absolute top-3 right-3` or similar), icon `monitoring` or `insights`, tooltip `Show telemetry (T)`.
- Clicking restores the HUD.

### Layout

The quadrant sits below the existing bars (COST, model chips, TOKENS, CACHE HIT, AutonomyStat). HUD grows taller; width stays 260px. Quadrant footprint roughly 240×150 inside the 260px container. Nothing above is removed.

### Agent Avatars

Agents are rendered with real procedural faces, not abstract dots. This makes the quadrant (and every other place avatars appear) feel like a zoo of distinct characters rather than a color field.

**Library:** [DiceBear](https://www.dicebear.com) — `@dicebear/core` + `@dicebear/collection` (or the individual `@dicebear/bottts-neutral` package). Generates SVG deterministically from a seed string. Tree-shakeable, ~30–50KB gzipped for core + one style.

**Style:** `bottts-neutral`. Matches the synthetic-agent aesthetic. (Different styles per role — hands as `identicon`, orchestrators as `pixel-art` — is a deliberate follow-up, not part of this PR.)

**Generation location: client-side.** The avatar is a pure function of `run.id` (the seed) plus `run.color` (the paint palette). Both are already on every Run everywhere in the system. No server-side generation, no persisted SVG, no run-doc bloat, no backfill for existing runs. Any client generates the same image from the same runId; DiceBear's determinism is the contract.

**Caching:** module-level `Map<string, string>` keyed by `${runId}:${color}` → data-URL SVG string. Rendered once per unique combination per browser session; subsequent reads are a hashmap lookup.

**Bundle strategy:** dynamic `import('@dicebear/core')` on first avatar render. Before the library arrives (~100ms cold, cached by browser after that), render a placeholder: a colored circle tinted with `run.color`. After the promise resolves, the avatar swaps in. Initial canvas paint is never blocked on the library.

**Fallback hierarchy** (composed inside `<AgentIcon>`):

1. If `run.agentIcon` is set (from the agent template) → render it (existing behavior: `<img>` for URLs, emoji text otherwise).
2. Else if DiceBear is loaded → render generated `bottts-neutral` SVG seeded by `run.id`, tinted with `run.color`.
3. Else (lib not yet loaded or failed) → colored `run.color` circle placeholder.
4. Legacy ultra-fallback for consumers not passing a seed (e.g. existing sidebar call sites) → current `▶` / `🐳` backend emoji, unchanged.

**Why the fallback hierarchy preserves existing behavior:** template icons win, so every currently-templated agent keeps its existing emoji/image. DiceBear only fills the gap for untemplated runs (which today get `▶`/`🐳`). No visual regression for existing users.

## Components

### `AgentQuadrant.tsx` (new)

```ts
interface Props {
  runMap: Map<string, Run>
  burningRunIds: Set<string>  // from telemetry
  onFocusRun: (runId: string) => void
}
```

Pure-presentation React component. Consumes run list, burning set, and a click handler.

- Filters runs to alive (`status !== 'stopped'`).
- For each run computes cell = `(busy ? 0 : 1) * 2 + (burning ? 0 : 1)` (or similar).
- Renders 4 cells, each a `<div>` with flex-wrap of `<AgentAvatar>` children.
- `<AgentAvatar>` is a positioned `<button>` containing `<AgentIcon>` (see below) inside a circular ring tinted with `run.color`. It has `title` = session name, `onClick` = `onFocusRun(run.id)`. Absolute positioning keyed by runId lets CSS transitions move the avatar when its cell changes.

### `agentIcon.tsx` (modified)

- `<AgentIcon>` gains optional `seed` (string) and `color` (string) props.
- Rendering logic updated to the fallback hierarchy above:
  1. If `icon` prop is set → render as today.
  2. Else if `seed` prop is set → lazy-load DiceBear (dynamic import, cached), render SVG data URL. Show tinted placeholder while loading.
  3. Else → existing fallback (`▶`, `🐳`, or caller-provided `fallback`).
- New sibling module `agentAvatarCache.ts` owns the `Map<string, string>` memo cache and the dynamic-import wrapper. Pure function, trivial to unit-test.

### `CanvasHud.tsx` (modified)

- Adds a close ✕ button (mirrors `CanvasMinimap.tsx:257-264` pattern).
- Adds the collapsed icon-button state when `!visible` (mirrors `CanvasMinimap.tsx:227-238`).
- Passes `runMap` and `burningRunIds` down to `<AgentQuadrant>`.
- Accepts `onFocusRun` via props from parent.

### `InfiniteCanvas.tsx` (modified)

- Passes `runMap` and `onFocusRun` (already has both) into `<CanvasHud>`.

### `useTelemetryHud.ts` (modified)

- Snapshot type gains `burningRunIds?: string[]` (list of tinstar run IDs currently burning tokens).
- Populated from the SSE event and REST fetch.

### Server: `src/server/observability/query.ts` (modified)

- New method `async burningSessions(opts): Promise<string[]>` — runs a Prometheus query like:
  ```
  sum by (session_id) (rate(claude_code_token_usage_tokens_total{user_email="..."}[30s])) > 0
  ```
  Returns the set of `session_id` labels (Claude Code conversation UUIDs).

### Server: `src/server/api/telemetry.ts` (modified)

- In `buildSnapshot` (or a new per-tick computation), after the existing HUD query, call `burningSessions`, then translate conversation UUIDs → tinstar run IDs using a new dep `getRunIdsForConversationIds(uuids: string[]): string[]` (inverse of the existing `getSessionConversationId`).
- Add `burningRunIds: string[]` to the broadcast snapshot.
- In FAST_SIM mode, populate with a random subset of run IDs for local testing.

### Server: `src/server/index.ts` (modified)

- Provide the inverse lookup. `RunData.id` (the run ID used by `onFocusRun` on the frontend) is distinct from `RunData.sessionId` (tmux session name), which is distinct from the Claude Code conversation UUID. The lookup must:
  1. For each burning conversation UUID, find the session whose `conversation.id` matches.
  2. Find the Run whose `sessionId` matches that session's name.
  3. Return that Run's `id`.
- Iterating the session store + run list once per tick is cheap.

## Data Flow

```
Prometheus ─┐
            ├→ TelemetryQuery.burningSessions() → [conversationUUIDs]
            │                                          │
            │    tinstar session store ────────────────┤
            │    (conversation UUID → run ID)          ↓
            │                                 [burningRunIds]
            ↓                                          │
   existing HUD numbers                                │
            │                                          │
            └─────────→ broadcast { ...hud, burningRunIds } ──→ SSE
                                                               │
                                                    useTelemetryHud
                                                               │
                                                          CanvasHud
                                                               │
                                                     AgentQuadrant ← runMap
                                                               │
                                                    onClick → onFocusRun(runId)
```

## Non-Goals

- **Not** fusing telemetry into the session status engine. Status stays process-tree-derived; telemetry is a separate display signal. (A session running a 90s bash build should NOT be reclassified as `needs_attention` just because it hasn't burned tokens — that's a legitimate state.)
- **Not** removing or replacing the existing COST / TOKENS / CACHE bars or AutonomyStat. All kept.
- **Not** wiring per-dot context menus, drag, or multi-select. Click = focus, hover = tooltip. Nothing else.

## Edge Cases

- **No live agents:** render an empty quadrant placeholder (or hide the quadrant entirely). Leaning toward hiding — the HUD still shows aggregate metrics.
- **Prometheus query fails:** `burningRunIds` defaults to empty. Every agent renders on the "quiet" row. No crash.
- **session_id → run ID lookup miss:** the conversation UUID is discarded. Doesn't affect the rest of the HUD.
- **Lots of agents (>20):** dots shrink; cells become `flex-wrap` grids. If needed, clamp dot size to a minimum (e.g. 6px) and scroll within the cell.
- **Rapid churn:** animation duration capped so a flickering agent doesn't blur the display.
- **FAST_SIM mode:** uses fake burning subset so the quadrant is testable without a real Prometheus.

## Testing

- **Unit:** `AgentQuadrant` render tests — given runMap + burningRunIds, correct counts per cell.
- **Unit:** `burningSessions` query — mock Prometheus response, verify UUID extraction.
- **Unit:** telemetry builder — verify `burningRunIds` translation through the session store.
- **Unit:** `agentAvatarCache` — given same seed/color, returns cached SVG; different seed produces different SVG; placeholder returned before lib resolves.
- **Unit:** `<AgentIcon>` fallback hierarchy — template icon wins over seed; seed wins over backend fallback; works with lib unavailable.
- **E2E (FAST_SIM):** quadrant renders with avatars, avatars move between cells when fake data flips, clicking an avatar pans the canvas (uses existing `onFocusRun` wiring).
- **Manual:** toggle HUD via both `T` hotkey and ✕ button. Verify collapsed icon shows. Verify persistence across reload. Spawn several templated + untemplated sessions; verify each untemplated one gets a distinct robot face stable across reloads.

## Measurements

- **Prometheus query cost — measured 2026-04-22 against local dev Prometheus (60 token-metric series, 1 active session):**
  - `sum by (session_id) (rate(claude_code_token_usage_tokens_total{user_email="..."}[30s])) > 0`
  - Single run: ~0.9ms. 10 sequential warm runs: 0.60–0.85ms (median ~0.65ms).
  - Response payload: ~170 bytes for one active session; linear in active-session count.
  - Verdict: negligible. Existing HUD already issues 8 concurrent Prometheus queries every 1.5s; adding one more query in the same `Promise.all` batch has no meaningful impact. **No throttling needed — run it on every 1.5s tick alongside the existing queries.**

## Rollout

Small, single-PR change. No migration, no breaking API, no config. localStorage keys stay the same. If the backend query fails, the HUD degrades gracefully to its pre-change behavior.

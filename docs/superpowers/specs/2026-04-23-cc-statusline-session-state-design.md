# CC Statusline Session State — Design

**Status:** sketch, not yet approved
**Date:** 2026-04-23
**Author:** gathright@gmail.com + Claude
**Builds on:** `2026-04-23-cc-quota-hud-design.md` (the cc-quota statusline-push pivot)

## 1 · Problem

The cc-quota pivot showed that Claude Code's statusline hook pipes its **full** session-state JSON on every render — not just `rate_limits`. The current ingest endpoint extracts `rate_limits.{five_hour,seven_day}` and throws the rest away. We're sitting on a feed of:

- per-session **context-window utilization** (the operator's current `load context` widget breaks; this is a cheap reliable replacement)
- per-session **cost** (USD, durations, line deltas)
- per-session **model**, `fast_mode`, `output_style`
- `exceeds_200k_tokens` flag
- optional `agent` + `worktree` metadata

Surfacing any of these requires more than the existing single-snapshot store can hold.

## 2 · Goals

- One keyed store of session states, fed by the existing statusline ingest, addressable by `session_id`.
- Tinstar widgets can read per-session state via a thin client hook (same SSE/poll pattern as `useCcQuota`).
- Account-level `rate_limits` (HUD card) keeps working with no UI change.
- Bounded memory: stale sessions evicted on a TTL.

Non-goals: no new statusline plumbing (the shim already POSTs the whole payload). No new CC settings. No telemetry replacement — `claude_code_*` Prometheus metrics stay the source of truth for historical dashboards; this is a low-latency in-process cache for live widgets.

## 3 · Storage shape

Replace `CcQuotaService`'s single cached snapshot with a `Map<sessionId, SessionState>`.

```ts
// src/server/cc-statusline/types.ts (new file; cc-quota dir renamed)
export interface SessionState {
  sessionId: string
  fetchedAt: string            // ISO; updated on every push from this session
  cwd: string | null
  model: { id: string; displayName: string } | null
  cost: {
    totalUsd: number
    totalDurationMs: number
    totalApiDurationMs: number
    totalLinesAdded: number
    totalLinesRemoved: number
  } | null
  contextWindow: {
    usedPercentage: number
    remainingPercentage: number
    contextWindowSize: number
    totalInputTokens: number
    totalOutputTokens: number
    cacheReadTokens: number | null
    cacheCreationTokens: number | null
  } | null
  exceeds200kTokens: boolean
  fastMode: boolean
  outputStyle: string | null
  agent:    { name: string; type: string | null } | null      // when --agent
  worktree: { name: string; path: string; branch: string | null } | null  // when --worktree
  rateLimits: RawUsage | null  // same as today, but kept on the session for traceability
}
```

The existing `RawUsage` (just `five_hour` + `seven_day`) stays as-is. Account-level quota is derived from the **most recently fetched** session that has non-null `rateLimits` — last write wins is fine because rate_limits are account-scoped (verified during the cc-quota POC: two parallel CC sessions reported identical values).

## 4 · Service

Rename `CcQuotaService` → `CcSessionStore`. Same module path moves from `src/server/cc-quota/` → `src/server/cc-statusline/`.

```ts
export class CcSessionStore {
  private sessions = new Map<string, SessionState>()

  ingest(payload: unknown): SessionState | null
  getSession(id: string): SessionState | null
  getAllSessions(): SessionState[]
  /** Most recently fetched non-null rateLimits across sessions. */
  getAccountQuota(): { fetchedAt: string; data: RawUsage } | null
  /** Drop sessions that haven't pushed in `staleMs`. Called on a timer. */
  evictStale(staleMs: number, nowMs: number): void
}
```

Eviction: every 60s, drop entries older than 30 minutes. CC sessions don't terminate gracefully into the statusline, so we need a TTL — otherwise a long-running Tinstar accumulates dead sessions forever.

OTel metrics emission stays the same wire format — `cc_quota_used_ratio{window=5h|7d}` etc. — but is now driven by `getAccountQuota()` derivation. **Add new per-session gauges** (labeled by `session_id`):

| Name | Labels | Value |
|---|---|---|
| `cc_session_context_used_ratio` | `session_id` | `usedPercentage / 100` |
| `cc_session_cost_usd` | `session_id` | `cost.totalUsd` |
| `cc_session_lines_added_total` | `session_id` | `cost.totalLinesAdded` |
| `cc_session_lines_removed_total` | `session_id` | `cost.totalLinesRemoved` |
| `cc_session_fast_mode` | `session_id` | 0/1 |

Cardinality risk: bounded by eviction. With 30-min TTL even a heavy day stays under a few hundred series.

## 5 · API

**Existing (preserved):**
- `POST /api/cc-quota/ingest` — unchanged wire format. Internally now feeds `CcSessionStore.ingest()`.
- `GET /api/cc-quota` — unchanged response shape (`{fetchedAt, data: RawUsage|null, error}`); served from `getAccountQuota()`.

**New:**
- `GET /api/cc-sessions` — returns `SessionState[]` (snapshot of the Map values).
- `GET /api/cc-sessions/:sessionId` — returns the single `SessionState` or 404.

Optional: SSE channel `/api/cc-sessions/events` that pushes a `SessionState` on every successful ingest. Skip for v1; the 5-minute poll the HUD already uses is fine for context-window updates and the per-widget hook can use a shorter interval (e.g. 5-10s).

## 6 · Client

**`src/hooks/useCcSession.ts`**

```ts
export function useCcSession(sessionId: string): SessionState | null
```

Polls `/api/cc-sessions/:sessionId` on a short interval (5-10s) and exposes the latest. Singleton-shared cache like `useCcQuota`. Returns `null` until the first push lands.

Mapping from Tinstar `run.id` → CC `session_id` already exists server-side (`getSessionConversationId` in the telemetry routes). The hook can either accept the CC session id directly (simpler) or accept a tinstar `run.id` and resolve it server-side. **Recommend: accept session_id**; resolution lives on the run model already (`run.sessionId`-ish), so callers grab it from there.

`useCcQuota` stays exactly as it is — it still hits `GET /api/cc-quota`.

## 7 · UI integration points (incremental)

Build none of these in this spec; they're follow-ups. Just listing what becomes possible:

- **Cheap context-window placeholder** — agent avatar shows `42%` badge or thin ring; replaces the broken load-context visualizer for the unloaded state.
- **Per-session cost chip** — running USD on each agent widget header.
- **Lines added/removed mini-badge** — net code contribution per agent.
- **Model chip** — `OPUS` / `SONNET` / `HAIKU` next to avatar.
- **Fast-mode badge** — visual cue when an agent is on Fast.
- **200k boundary marker** — warning ring when `exceeds200kTokens`.

## 8 · Migration & compatibility

- File moves: `src/server/cc-quota/` → `src/server/cc-statusline/`. Rename only, not a fork.
- Type renames: `CcQuotaService` → `CcSessionStore`, `CcQuotaSnapshot` keeps its name (the HUD-card-facing API doesn't change).
- The shim (`scripts/cc-quota-statusline.sh`) doesn't change. Its install path stays valid.
- The OTel metric names that already shipped (`cc_quota_*`) stay the same shape — Prometheus dashboards built on them won't break.

## 9 · Testing

- `CcSessionStore` unit tests: ingest one + many sessions, eviction, getAccountQuota derivation when one session has rateLimits and another doesn't.
- Route tests for the two new endpoints, including 404 for unknown session.
- `useCcSession` hook test (similar to `useCcQuota`).
- E2E: extend `e2e/cc-quota.spec.ts` with a second seed POST under a different `session_id` and assert both snapshots are retrievable via `/api/cc-sessions`.

## 10 · Open questions

- **Polling interval for `useCcSession`**: 5s reads cheap and feels live; 10s is half the load. Pick before implementing widgets that consume it.
- **SessionState eviction TTL**: 30 min is a guess. Probably want telemetry on "sessions evicted per hour" once it ships to tune.
- **Per-session OTel metrics cardinality** — if a heavy user hits 100+ session_ids/day, 5 gauges × 100 = 500 series for the cc-statusline scope. Acceptable for local Prom; would be a problem in a hosted setup, but Tinstar's Prom is local.

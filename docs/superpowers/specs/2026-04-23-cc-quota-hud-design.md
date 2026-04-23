# Claude Code Quota HUD — Design

**Status:** approved, ready for implementation plan
**Date:** 2026-04-23
**Author:** gathright@gmail.com + Claude

## 1 · Problem

Tinstar observes agents that burn a shared resource: the user's Claude Code subscription quota. Today the quota is visible only inside Claude Code's interactive `/usage` TUI — invisible from Tinstar, invisible from Grafana, and impossible to correlate with agent activity. The operator can hit their 5-hour or 7-day limit mid-session with no warning.

## 2 · Goals

- **Glanceable quota readout in the Tinstar HUD** — the operator can see, without leaving the canvas, whether burning is on-pace for the current cycle or trending toward exhaustion.
- **Prometheus-scrapable metrics** for historical graphs (burn-rate, time-to-exhaustion, per-model slice).
- **Zero new infrastructure** — reuse the existing OTLP → Alloy → Prometheus pipeline and the existing HUD panel.

Non-goals: UI for flipping extra-usage on/off, any action beyond read-only display, support for API-billed usage (handled by the existing COST row).

## 3 · Data source

`GET https://api.anthropic.com/api/oauth/usage` — undocumented endpoint used by community statusline tools. Auth: `Authorization: Bearer <accessToken>` where the token is read from `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`.

Observed response shape (confirmed live):

```json
{
  "five_hour":        { "utilization": 67.0, "resets_at": "2026-04-23T15:49:59Z" },
  "seven_day":        { "utilization": 89.0, "resets_at": "2026-04-23T20:00:00Z" },
  "seven_day_opus":   null,
  "seven_day_sonnet": { "utilization":  2.0, "resets_at": "2026-04-23T21:00:00Z" },
  "extra_usage":      { "is_enabled": true, "used_credits": 8148.0, "monthly_limit": null, "currency": "USD" }
}
```

Server-side codenames `omelette`, `iguana_necktie`, `seven_day_cowork`, etc. are ignored — the official Claude Code CLI binary itself does not reference them.

Cycle length is fixed by convention: 5 hours for `five_hour`, 168 hours for the weekly buckets. `resets_at` is the next reset; cycle start is `resets_at - cycleLength`.

## 4 · Architecture

```
┌────────────────────────────────┐       ┌────────────────────────────────┐
│  Tinstar UI (React)            │       │  Tinstar Server (Vite plugin)  │
│  ┌────────────────────┐        │ HTTP  │  ┌──────────────────────────┐  │
│  │ useCcQuota hook    │◀───────┼───────┼──│ GET /api/cc-quota        │  │
│  │  · 5min setInterval│        │       │  └──────┬───────────────────┘  │
│  │  · refresh()       │        │       │         ▼                      │
│  │  · tab-visibility  │        │       │  ┌──────────────────────────┐  │
│  └──────┬─────────────┘        │       │  │ CcQuotaService           │  │
│         ▼                      │       │  │  · 5s cooldown cache     │  │
│  ┌────────────────────┐        │       │  │  · emits OTel metrics   ─┼─┐│
│  │ CcQuotaCard        │        │       │  └──────┬───────────────────┘  │
│  │  clock+bar+chip    │        │       │         ▼                      │
│  └────────────────────┘        │       │  ┌──────────────────────────┐  │
└────────────────────────────────┘       │  │ fetchCcQuota() ─────────▶│──┼──▶ api.anthropic.com
                                         │  │   reads ~/.claude/...    │  │    /api/oauth/usage
                                         │  └──────────────────────────┘  │
                                         │                                │ │
                                         │  existing: OtlpExporter ◀──────┘ │
                                         │            └──▶ Alloy:4318 ──────┼──▶ Prometheus
                                         └──────────────────────────────────┘
```

Three new pieces, one new HTTP route, zero new dependencies.

## 5 · Server — `src/server/cc-quota/`

### 5.1 · `fetcher.ts`

```ts
export interface RawUsage {
  five_hour:        UsageBucket | null
  seven_day:        UsageBucket | null
  seven_day_opus:   UsageBucket | null
  seven_day_sonnet: UsageBucket | null
  extra_usage:      ExtraUsage  | null
}
interface UsageBucket { utilization: number; resets_at: string }
interface ExtraUsage  { is_enabled: boolean; used_credits: number | null; currency: string }

export type FetchError =
  | { code: 'no_creds';      message: string }
  | { code: 'expired_token'; message: string }   // 401
  | { code: 'http_4xx';      message: string }
  | { code: 'http_5xx';      message: string }
  | { code: 'network';       message: string }

export async function fetchCcQuota(): Promise<RawUsage>
```

Reads `~/.claude/.credentials.json`; if missing or `claudeAiOauth.accessToken` absent, throws `no_creds`. On 401, throws `expired_token`. On 4xx/5xx/fetch failure, throws the mapped code. Otherwise returns the parsed JSON (no re-validation beyond optional-chaining into the fields we actually use — unknown codename fields pass through without affecting the type).

### 5.2 · `service.ts`

```ts
export interface CcQuotaSnapshot {
  fetchedAt: string            // ISO
  data: RawUsage | null        // null iff last fetch failed and no prior good snapshot
  error: FetchError | null     // set when most recent fetch failed
}

export class CcQuotaService {
  getSnapshot(opts?: { force?: boolean }): Promise<CcQuotaSnapshot>
}
```

Single in-memory cache. A `force` call re-fetches unless the last attempt was within 5 seconds (cooldown prevents thrash from UI refresh-button spam). On success: updates cache, emits metrics, clears error. On failure: preserves the last good `data`, sets `error`.

### 5.3 · `metrics.ts`

Pushes gauges to the project-wide `OtlpExporter` on every successful fetch. Metric names are prefixed `cc_quota_` to avoid collision with Claude Code's own `claude_code_*` metrics (which the docker backend already enables for agent sessions).

| Name | Type | Labels | Value |
|---|---|---|---|
| `cc_quota_used_ratio` | gauge | `window=5h\|7d\|7d_opus\|7d_sonnet` | `utilization / 100` |
| `cc_quota_resets_at_seconds` | gauge | `window=...` | unix epoch of `resets_at` |
| `cc_quota_time_in_cycle_ratio` | gauge | `window=5h\|7d` | `1 - (resets_at - now) / cycleLen` |
| `cc_quota_deficit_ratio` | gauge | `window=5h\|7d` | `used_ratio - time_in_cycle_ratio` |
| `cc_extra_usage_enabled` | gauge | — | 0 or 1 |
| `cc_extra_usage_credits_usd` | gauge | — | `used_credits` (omitted if null) |
| `cc_quota_fetch_total` | counter | `result=ok\|error` | 1 |

Null buckets emit nothing for that label — per the project's no-zero-defaults rule, absence is data.

## 6 · API route — `GET /api/cc-quota`

Query: `?force=0|1` (default 0).
Registered in `src/server/index.ts` alongside existing routes.

**Response (200):**

```json
{
  "fetchedAt": "2026-04-23T08:36:00Z",
  "data": { /* RawUsage, see §3 */ } | null,
  "error": null | { "code": "...", "message": "..." }
}
```

Never 4xx/5xx unless the server is genuinely broken — credential/token/network errors are represented in the body so the UI can render a stale snapshot plus an inline error.

No SSE. 5-minute cadence is too slow to justify a push channel; the client polls cheaply and the server cooldown absorbs duplicate calls.

## 7 · Client — `useCcQuota`

**`src/hooks/useCcQuota.ts`**

```ts
export interface UseCcQuota {
  snapshot: CcQuotaSnapshot | null
  lastRefreshedAt: string | null
  refreshing: boolean
  refresh: () => void
}
export function useCcQuota(): UseCcQuota
```

- `setInterval(fetch, 5 * 60 * 1000)` on mount.
- Pauses when `document.visibilityState === 'hidden'`; resumes (and refetches once) on visibility change.
- A singleton in `useCcQuota.ts` (module-scoped state, not localStorage) so multiple `useCcQuota()` consumers in the tree share one timer and one in-flight request.
- `refresh()` hits `/api/cc-quota?force=1`.

## 8 · Component — `CcQuotaCard`

**`src/components/CanvasHud/CcQuotaCard.tsx`**

Layout (fits the 260px-wide HUD panel):

```
┌──────────────────────────────────────────┐
│ Claude Code           ⟳ 2m   ⛽ $81.48   │  ← group header
├──────────────────────────────────────────┤
│ (clock)   33% left · 5H · resets 3h 12m  │
│ (7d bar)  11% left · 7D · resets 7h 23m  │
└──────────────────────────────────────────┘
```

### 8.1 · Clock subcomponent

- Full 12-hour clock face; 12 always at top.
- **Reset dot** at the actual reset-hour position.
- **Cycle trough** — a dim 150° arc from (reset − 5h) clockwise to reset; rest of the face is barely-visible, reinforcing "clock first, gauge second".
- **Quota fill** — a bright arc of the same 150° window, anchored to the reset dot, shrinking clockwise as quota burns. At 100% remaining: full 150°. At 1% remaining: a sliver right next to the reset dot.
- **Quota trailing-edge dot** — a small colored ring marking where the fill's empty side meets the filled side. This is "quota's runner."
- **Hour hand** — wall-clock hour position. "Time's runner."
- **No minute hand** (per feedback — reads as clutter).

### 8.2 · 7D bar subcomponent

- 7-day horizontal strip with 6 interior day ticks at 1-day intervals.
- Reset dot on the right edge (actual reset wall-clock time in the tooltip).
- Same depletion rule as the clock: fill anchored to the right, shrinking leftward toward the reset as quota burns.
- Playhead tick and quota trailing-edge dot, same semantics as the clock's hand + dot.
- **Deficit shading** — when quota's dot is ahead of the playhead, the region between them (the slack already burned) is tinted red.

### 8.3 · Color rules

`deficit = used_ratio − time_in_cycle_ratio` (positive = quota ahead of time).

| Condition | 5H fill | 7D fill |
|---|---|---|
| `deficit ≤ 0`        | cyan `#22d3ee`   | amber `#f59e0b` |
| `0 < deficit ≤ 0.20` | orange `#f97316` | orange `#f97316` |
| `deficit > 0.20` OR `used_ratio = 1` with time remaining | red `#ef4444` | red `#ef4444` |

### 8.4 · Gas-pump chip

Material Symbol `local_gas_station`. In the group header row:

- `extra_usage.is_enabled === true` → green chip, body text `$X.XX` (from `used_credits`). Assume `used_credits` is denominated in cents when `currency: "USD"` (empirical — `8148.0` displayed as `$81.48`); adjust the divisor if Anthropic's unit turns out otherwise. If `used_credits` is null, show just `ON`.
- `is_enabled === false` → gray chip, body text `OFF`.
- `extra_usage === null` → chip omitted entirely.

### 8.5 · Refresh affordance

Small `refresh` Material Symbol in the header showing `Nm ago` relative to `lastRefreshedAt` (`0m`, `2m`, `14m`, `1h`, …). Clicking calls `refresh()`. Spins during `refreshing`. Turns red + stops spinning if the latest fetch set `error`.

### 8.6 · Tooltip (on hover)

- Absolute reset timestamps: `5H resets at 11:49 AM`, `7D resets at Thu 8:00 PM`.
- Per-model weekly if non-null: `7D Sonnet 2%`, `7D Opus —`.
- Extra-usage: `$81.48 used this month · overflow ON`.
- Last refreshed: `Fetched 2m ago at 8:36:12 AM`.
- If `error`: `⚠ token expired — start Claude Code to refresh`.

### 8.7 · Display rule — `% left` only

Only the remaining-quota percentage is shown as a number (e.g. `33% left`). Do NOT show both `% left` and `% used` — the number of digits on screen is already dense and one is enough.

### 8.8 · Placement in the HUD

Insert between `<AutonomyStat … />` and `<AgentQuadrant … />` in `src/components/CanvasHud/CanvasHud.tsx`. The card always renders the skeleton (clock outline, bar trough, labels); numeric values are `--` when the corresponding bucket is unavailable — whether that's because the token is bad, the endpoint errored, or the bucket is null. The card never hides.

## 9 · Error handling — single table

| Situation | UI behavior | Metric behavior |
|---|---|---|
| `~/.claude/.credentials.json` missing / no OAuth section | Card renders in full with `--` for every `% left` value; tooltip and refresh icon explain "sign in to Claude Code". Gas-pump chip omitted. | No metrics emitted. Error counter + 1. |
| 401 expired token | Card stays visible with last-good snapshot; refresh icon red; tooltip explains "start Claude Code to refresh". | Last-good gauges remain stale in Prometheus; error counter + 1. |
| Null bucket in response | That row renders `--` for `% left`, tooltip says "not reported". | That label set not emitted. |
| 5xx / network / timeout | Same as 401 — stale card + red refresh icon. | Error counter + 1. |
| Token valid, all buckets null | Card renders skeleton with `--` in every row. | Only `cc_quota_fetch_total{result=ok}` emitted. |

**Stale-token tradeoff (accepted):** the local credentials file is refreshed only when Claude Code runs. If Claude Code hasn't been running, the token goes stale and our fetch 401s. We accept this — if the operator isn't running Claude Code, they have no active agents to worry about quota for. Refresh-via-OAuth-refresh-token is explicitly out of scope.

## 10 · Testing

- `fetcher.test.ts` — mocks `fetch`; covers valid response, 401, 5xx, missing file, malformed JSON.
- `service.test.ts` — cooldown behavior, metric emission on success, counter on error, cache preservation across transient errors.
- `CcQuotaCard.test.tsx` — RTL snapshots for: fresh cycle, on-pace, deficit, red/exhausted, null buckets, extra-usage on/off, error state. (Follows `AgentQuadrant.test.tsx` pattern.)
- One Playwright e2e covering the card's presence + `% left` label. Under `TINSTAR_FAST_SIM=1` the backend should return a deterministic fixture instead of calling Anthropic (wire a `TINSTAR_FAST_SIM` branch into `CcQuotaService`).
- Metrics smoke test: manual — start server, hit `GET http://localhost:9090/api/v1/query?query=cc_quota_used_ratio`, confirm series appear with the expected window labels.

## 11 · Out of scope (parked)

- UI controls to enable/disable extra-usage (requires undocumented mutation endpoint — too fragile).
- Per-session attribution (`which agent burned the quota`) — Claude Code's own `claude_code_*` metrics already flow through Alloy and can be joined in Grafana without Tinstar owning it.
- Expanded modal with the larger clock-and-calendar dashboard (that was the original prototype; hover tooltip is sufficient).

## 12 · Open questions

None — all design decisions are locked:

- Form factor: dedicated quota card (not HudBar rows, not inline triplet).
- Shape: 5H clock + 7D bar, identical dual-encoding (time playhead + quota trailing edge racing clockwise toward the reset).
- Clock face: real 12h, reset at actual hour, no minute hand.
- Only `% left` shown.
- Gas-pump glyph for extra-usage.
- Placement: between AUTONOMY and AGENT QUADRANT.
- Click: hover tooltip only, no expand.
- Polling: 5 minutes, with manual refresh button showing last-fetched age.
- Token stale: accept and explain.

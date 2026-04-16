# Tinstar-Native Telemetry Design

**Date:** 2026-04-16
**Status:** Draft (pending implementation plan)

## Problem

Telemetry today is "bolted on" to Tinstar. The Alloy + Prometheus + Grafana stack lives in `observability/docker-compose.yml` and must be started by hand. Dashboards are deployed to an external Grafana via a separate `/grafana-deploy` skill. A fresh clone of the repo does not "just get telemetry" the way it gets ttyd.

We want telemetry to feel as invisible as ttyd: auto-managed by the Tinstar server, surfaced natively in the Tinstar UI, and requiring zero extra steps on `npx tinstar`. We are explicitly **not** trying to build a replacement for Grafana — Grafana stays available as a power-user dev tool but is no longer part of the default experience.

## Goals

- A new user running `npx tinstar` (or `npm run dev`) sees live session telemetry in the Tinstar UI with no additional setup.
- The Tinstar server owns the lifecycle of the telemetry stack: starts it, adopts orphans, reaps children cleanly on shutdown.
- Telemetry is rendered directly in Tinstar — an aggregate HUD in the upper-right (mirroring the minimap in the lower-right) and per-session bars in the existing `TelemetryPanel` sidebar.
- No Docker requirement on the user's machine.
- If telemetry degrades, core Tinstar functionality (sessions, ttyd, commits) is unaffected.

## Non-Goals

- Replacing Prometheus or re-implementing an OTLP collector in TypeScript.
- Building Grafana-equivalent interactive exploration inside Tinstar.
- Supporting arbitrary PromQL from the frontend.
- Migrating existing Grafana dashboards into the Tinstar UI (they continue to exist for power users via the opt-in docker-compose path).

## Decisions

### Packaging: Embedded binaries (managed subprocesses)

Tinstar downloads Prometheus and Alloy as platform-specific static binaries on first launch, caches them under `~/.config/tinstar/bin/`, and runs them as supervised child processes — the same conceptual model Tinstar already uses for ttyd.

Considered and rejected:
- **Native in-process collector** (Tinstar IS the OTLP receiver + SQLite-backed store) — reinvents too much of the existing OTLP ecosystem and fights established tooling.
- **Docker auto-lifecycle** — still requires Docker on the user's machine, which breaks the `npx tinstar` portability goal.

### UI: RPG resource bars in the upper-right, twinned with the minimap

An aggregate HUD appears in the upper-right corner of the canvas, mirroring the minimap's position in the lower-right. Metrics are rendered as horizontal segmented bars (cost, tokens, cache hit) with an icon, label, value, and fill. Autonomy is rendered as a **ratio dial**, not a fill-bar, because the formula `cli_time / user_time` has no natural ceiling.

The same component library renders a narrower **"Session"** section at the top of the existing `TelemetryPanel` sidebar in the RunWorkspace widget, scoped to this session's `tinstar_session` label. The existing context-usage treemap stays below as a distinct "Context" section.

### Data model: typed endpoints, not PromQL passthrough

The frontend never speaks PromQL. It calls a small, typed API:

```
GET /api/telemetry/hud
  → {
      window: "today",      // since local midnight in user tz
      state: "ready" | "downloading" | "starting" | "degraded",
      cost:    { total: number, byModel: { opus: number, haiku: number } },
      tokens:  { total: number },
      rate:    { perMin: number, perHour: number },
      cacheHitPct: number,   // 0..1
      autonomy: { ratio: number, cliSeconds: number, userSeconds: number },
      staleSeconds?: number  // present when serving last-known snapshot
    }

GET /api/telemetry/session/:sessionName
  → same shape, filtered by tinstar_session label
```

Live updates arrive on SSE channels `telemetry:hud` and `telemetry:session:<name>`. The server polls Prometheus every ~1.5s, diffs against the last snapshot, and pushes when it changes.

### Scope

- **HUD scope:** all Tinstar activity today (since local midnight in user's timezone), filtered by `user_email` label. Resets naturally at midnight.
- **Per-session scope:** a single `tinstar_session` label, lifetime of the session.

### Autonomy definition

`sum(claude_code_active_time_seconds_total{type="cli"}) / sum(claude_code_active_time_seconds_total{type="user"})`. Same formula already used in `observability/dashboards/claude-code-telemetry.json`. Rendered as `"4.52×"` with a tick on a 1:1 ↔ 10:1 scale.

## Architecture

### New module: `src/server/observability/`

Parallel in shape to `src/server/sessions/`:

- **`supervisor.ts`** — generic child-process supervisor. One instance per child. Handles: spawn, adopt (via pidfile + platform-appropriate pid validation — `readlink /proc/<pid>/exe` on Linux, `ps -p <pid> -o comm=` + expected-binary-name match on macOS), restart-on-crash with 2s exponential backoff (cap 5 restarts / 60s), SIGTERM→SIGKILL shutdown cascade (5s grace), readiness probe before reporting `ready`.
- **`binaries.ts`** — first-run binary manager. Resolves `{os, arch}` → download URL for the expected version; downloads to a temp path; verifies sha256 against a committed manifest; atomically renames into `~/.config/tinstar/bin/`. Surfaces progress events on an EventEmitter consumed by the SSE bridge.
- **`index.ts`** — orchestration. On server start: ensure binaries → start Alloy → start Prometheus → probe readiness → mark `ready`. On shutdown: reverse order, 5s grace per child.
- **`templates/`** — `prometheus.yml.tmpl`, `alloy-config.alloy.tmpl`. Rendered against `TinstarConfig` on server start and written to `~/.config/tinstar/observability/`, overwriting any manual edits (deliberate — prevents drift on upgrade).
- **`query.ts`** — the typed query layer. Compiles each typed endpoint to a concrete PromQL query against `http://127.0.0.1:9090`. Caches the last successful result per-endpoint with a `staleSeconds` field for the degraded-query case.

### Files on disk

```
~/.config/tinstar/
  bin/
    prometheus-{os}-{arch}/prometheus
    alloy-{os}-{arch}/alloy
    manifest.json                 # versions + sha256s
  observability/
    prometheus.yml                # generated each boot
    alloy-config.alloy            # generated each boot
    prometheus-data/              # TSDB (retention: 7 days)
    prometheus.state.json         # { pid, binaryPath, binaryHash, port, startedAt }
    alloy.state.json
    observability.lock            # flock'd by the owning Tinstar server
```

### Data flow

```
Claude Code (in docker/tmux session)
   ↓ OTLP/HTTP :4318
Alloy (Tinstar-supervised subprocess)
   ↓ prometheus.remote_write
Prometheus (Tinstar-supervised subprocess, 127.0.0.1:9090)
   ↑ PromQL (every ~1.5s)
Tinstar server (/api/telemetry/*)
   ↓ SSE
Frontend (CanvasHud + TelemetryPanel "Session" section)
```

Session env injection for `OTEL_EXPORTER_OTLP_ENDPOINT` is unchanged; the endpoint is now always Tinstar-owned (with the existing `host.docker.internal` rewrite for Docker containers).

### Network surface

Both supervised children bind only to `127.0.0.1` (loopback): Prometheus on `:9090`, Alloy on `:4318`. They are not exposed to the network, and no authentication layer is added — they exist as local, Tinstar-owned services. Docker-based sessions reach them via the existing `host.docker.internal` rewrite.

### Platform support

Primary targets: macOS (darwin-arm64, darwin-amd64) and Linux (linux-arm64, linux-amd64). Windows is out of scope for the initial implementation — if `TINSTAR_TELEMETRY` is left on on Windows, the binary manager reports a clear "telemetry not supported on this platform" state rather than attempting a download.

### Singleton guarantee

- The `observability.lock` file is held with `flock` by whichever Tinstar server owns the stack.
- A second Tinstar server instance on the same machine reads the pidfile and adopts the running stack read-only — no duplicate spawns.
- Port-bind collision with a non-Tinstar process fails loudly with a specific error message rather than clobbering.

### Shutdown & orphan recovery

- Children are spawned detached (`setsid`) so they survive a hard kill of Tinstar. On the next Tinstar start, the startup reconciliation loop adopts them via pidfile + platform-appropriate pid validation (see `supervisor.ts`).
- Clean shutdown (SIGTERM/SIGINT) triggers reverse-order child shutdown with 5s grace then SIGKILL. Pidfiles are unlinked on clean shutdown so the next start does not waste time probing stale pids.

### Opt-out

`TINSTAR_TELEMETRY=0` skips binary download, skips supervisor startup, and hides the HUD slot and the per-session "Session" section entirely. Server boots normally; there is no degraded-banner noise for users who actively opted out.

### Legacy `observability/docker-compose.yml`

Stays in the repo as an opt-in power-user dev tool runnable via a new `npm run dev:observability` script. No longer on the default `npm run dev` path. The `/grafana-deploy` and `/query-telemetry` skills continue to work against it unchanged.

## Frontend

### New components

`src/components/CanvasHud/`:

- **`CanvasHud.tsx`** — upper-right aggregate HUD. Reads state via `useTelemetryHud()`. Positioned symmetrically opposite the minimap; toggle hotkey **`T`** (mirroring the minimap's `M`).
- **`HudBar.tsx`** — single row: `{ icon, label, value, fill, accent }`. Reused between the aggregate HUD and the per-session panel.
- **`AutonomyStat.tsx`** — specialized renderer for the ratio. No fill-bar. Shows `"{N.N}×"` plus a tick on a 1:1 ↔ 10:1 track. Hover tooltip shows the raw `cliSeconds / userSeconds`.
- **`TelemetryBootstrap.tsx`** — renders the first-run download progress state inside the HUD slot.

### Modified components

- `src/components/RunWorkspaceWidget/TelemetryPanel.tsx` — add a new **"Session"** section at the top that reuses `HudBar` + `AutonomyStat` with per-session data. Existing context-usage treemap stays below as a distinct "Context" section. No other changes to existing treemap behavior.

### Hooks

- `src/hooks/useTelemetryHud.ts` — subscribes to SSE `telemetry:hud`, returns `{ state, data?, progress?, staleSeconds? }`.
- `src/hooks/useTelemetrySession.ts` — same for SSE `telemetry:session:<name>`.

### Degraded / loading UX

- `downloading` → `TelemetryBootstrap` renders a progress card with the HUD aesthetic: "Downloading telemetry · 42 / 120 MB".
- `starting` → bars render with a shimmer and "warming up…".
- `degraded` → bars render `--` (never `0` — per no-zero-defaults convention) with a warning chip and a "Retry" affordance that `POST /api/telemetry/restart`s the supervisor.
- `TINSTAR_TELEMETRY=0` → slot does not render. Zero visual footprint.

## Error Handling

### Binary download

- Network failure → retry with exponential backoff up to 3 attempts; surface `download-failed` with a user-actionable "Retry".
- Checksum mismatch → refuse to execute; log loudly; stay in `download-failed`. Unverified binaries are never launched.
- Disk full / permission denied → surface the specific path + error so the user can fix it.

### Supervisor

- Port already bound: check pidfile — if it's ours, adopt; if not, fail with `"port 9090 is held by pid 1234 (not Tinstar)"`. Never clobber.
- Child exits unexpectedly → 2s exponential backoff restart, capped at 5 restarts / 60s, then `degraded`. Crash loops never silently consume CPU.
- Startup race (two Tinstar servers at once) → `flock` on `observability.lock` serializes; the loser adopts the winner's stack.

### Query + SSE

- Prometheus query timeout (>1s) → return last-known snapshot with `staleSeconds` populated. Frontend dims bars slightly with a tooltip. Never renders `0` for missing data.
- SSE disconnect → frontend reconnects with backoff and shows a small "reconnecting…" chip.

### Invariant

Telemetry failures are **never load-bearing** for the rest of Tinstar. Sessions, ttyd, commits, and all other functionality keep working; only the HUD dims.

## Testing

### Unit (Vitest)

- **`supervisor.test.ts`** — spawn / adopt / restart / shutdown using a `sleep` subprocess stand-in. Covers: clean start, adoption of live pid, rejection + cleanup of stale pid, backoff cap, SIGTERM→SIGKILL cascade, lock contention.
- **`binaries.test.ts`** — download + checksum verification against a mock HTTP server; corrupt-download rejection; atomic-rename atomicity; retry/backoff behavior.
- **`config-template.test.ts`** — generated `prometheus.yml` and `alloy-config.alloy` match golden files given representative `TinstarConfig` inputs.
- **`query.test.ts`** — each typed endpoint compiles to the expected PromQL string; snapshot/stale behavior under Prom timeout.

### Integration (Node, no real Prom)

- Full server boot with stubbed binary paths → supervisor reports `ready`.
- Second server instance detects lock, adopts, does not spawn.
- Simulated crash of each child → supervisor restarts within 3s.
- SIGTERM of Tinstar → both children reaped within 5s.

### E2E (Playwright, `TINSTAR_FAST_SIM=1`)

- HUD appears in the upper-right on boot; `T` toggles visibility.
- Fast-sim injects fake telemetry snapshots over SSE → bars animate to values.
- Per-session bars appear in the RunWorkspace sidebar when a session is opened.
- `TINSTAR_TELEMETRY=0` → HUD absent; no console errors.
- Degraded state → warning chip + "Retry" visible; clicking restarts and clears the degraded state.

### Not on CI

Real binary downloads and real Prometheus boots are **not** exercised on default CI. CI uses the fast-sim path only. A separate (optional) nightly job may exercise the real download + boot loop on macOS + Linux runners.

## Migration

This change does not break any existing Tinstar functionality. The migration path:

1. Land the new `src/server/observability/` module behind the `TINSTAR_TELEMETRY` flag defaulting to on.
2. Existing `observability/docker-compose.yml` moves behind `npm run dev:observability`.
3. The existing `OTEL_EXPORTER_OTLP_ENDPOINT` env injection in session backends continues to work; by default it now points at Tinstar-managed Alloy instead of a user-started docker-compose Alloy.
4. The `/grafana-deploy` and `/query-telemetry` skills are unaffected — they target the docker-compose power-user path, which continues to exist.

## Open Questions

None blocking. Items to resolve during implementation planning:

- Exact Prometheus + Alloy versions to pin and the checksum-manifest location.
- Whether to pre-compile a small "manifest bundle" into the npm package or fetch the manifest from a Tinstar-owned URL at runtime. Leaning toward shipping the manifest in the npm package and fetching only the binaries.
- Exact hotkey letter for the HUD (`T` is the working assumption; `H` and `Y` were also discussed).

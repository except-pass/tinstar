# NATS Server Auto-Start

**Date:** 2026-04-17
**Status:** Draft

## Problem

Tinstar's NATS traffic bridge and session readiness tracker connect to `nats://localhost:4222` on startup. If no NATS server is running, they retry every 5 seconds indefinitely, filling logs with `CONNECTION_REFUSED` warnings. The operator must install and start `nats-server` manually — unlike Prometheus and Alloy, which Tinstar auto-installs and manages.

## Solution

Manage `nats-server` as a supervised binary, the same way the observability stack manages Prometheus and Alloy. Extract the shared infrastructure (Supervisor, binary installer, lock, types) out of `src/server/observability/` into `src/server/infra/` so both the observability stack and the new NATS manager can reuse it.

## Architecture

### Shared infrastructure extraction

Move generic process/binary management from `observability/` to `infra/`:

| File | From | To | Changes |
|---|---|---|---|
| `supervisor.ts` | `observability/` | `infra/` | None |
| `binaries.ts` | `observability/` | `infra/` | Widen `component` in `DownloadProgress` from union to `string` |
| `lock.ts` | `observability/` | `infra/` | None |
| `types.ts` (shared subset) | `observability/types.ts` | `infra/types.ts` | Extract `ServiceState` (renamed from `ObservabilityState`), `SupervisorState`, `DownloadProgress` |

`observability/types.ts` keeps domain-specific types (`HudSnapshot`, `ModelBreakdown`) and re-exports the shared types from `../infra/types.ts` for backwards compatibility. `observability/index.ts`, `manifest.ts`, `config-render.ts`, `query.ts` stay in place — only their imports change.

### New files

**`src/server/nats/manifest.ts`**

NATS server v2.10.24 binary targets for darwin-arm64/x64, linux-arm64/x64. Same `BinaryTarget` shape as observability manifest. NATS distributes as `.tar.gz` on Linux, `.zip` on macOS. Checksums verified against the official `SHA256SUMS` file from the GitHub release. The `BinaryTarget` interface moves from `observability/manifest.ts` to `infra/types.ts` since both manifests need it.

```typescript
export function resolveNatsTarget(os: string, arch: string): BinaryTarget
```

**`src/server/nats/nats-manager.ts`**

```typescript
export class NatsManager {
  state: ServiceState          // idle → downloading → starting → ready | degraded
  url: string                  // nats://127.0.0.1:{port}

  constructor(opts?: { configRoot?: string; port?: number })
  async start(): Promise<void> // install binary + spawn + probe
  async stop(): Promise<void>  // drain + SIGTERM + SIGKILL escalation
}
```

**Lifecycle:**

1. `start()` resolves the binary target for the current platform
2. Calls `installBinary()` — downloads + verifies SHA256 if not cached
3. Creates a `Supervisor` with:
   - `args: ['-p', port, '-a', '127.0.0.1']` (listen on loopback only)
   - `probe`: connect with the `nats` npm package, then close
   - `expectedBinaryName: 'nats-server'`
   - `stateDir: ~/.config/tinstar/nats/`
4. Calls `supervisor.start()` — spawns detached, probes until ready (10s timeout)
5. Sets `this.url` to `nats://127.0.0.1:{port}`

**Probe function:** Uses the `nats` npm `connect()` + `close()`. This verifies the server is actually accepting client connections, not just listening on a port.

**Port:** Default 4222, configurable via `NATS_PORT` env var.

**State directory:** `~/.config/tinstar/nats/` — separate from observability.

### Integration in index.ts

**Startup (before NATS clients):**

```typescript
const natsManager = new NatsManager()
await natsManager.start()  // blocks until ready or degraded

const natsTraffic = new NatsTrafficBridge(sse, natsManager.url)
natsTraffic.start()

const readinessTracker = new SessionReadinessTracker(natsManager.url)
readinessTracker.start()
```

If `natsManager.state === 'degraded'`, the traffic bridge and readiness tracker still start — they have their own retry logic as a safety net. But in the happy path, NATS is already up and they connect immediately.

**Shutdown (added to the existing handler):**

```typescript
const shutdown = async () => {
  try { await natsTraffic.stop() } catch { /* ignore */ }
  try { await readinessTracker.stop() } catch { /* ignore */ }
  try { await natsManager.stop() } catch { /* ignore */ }
  try { await observability.stop() } catch { /* ignore */ }
  try { telemetryRoutes.stopPolling() } catch { /* ignore */ }
  try { docStore.flush() } catch { /* ignore */ }
  process.exit(0)
}
```

NATS clients drain first, then the server stops. Observability is independent and stops separately.

### What doesn't change

- `NatsTrafficBridge` keeps its retry/reconnect logic (safety net)
- `SessionReadinessTracker` keeps its connect logic
- `nats-channel-mcp` (per-session MCP adapter) is unaffected — it connects to whatever NATS URL is configured
- `~/.config/tinstar/config.json` NATS section (channelServerPackage, bunPath) is unaffected
- The `NATS_URL` env var is replaced by `NATS_PORT` for the managed server; if `NATS_URL` is set, skip auto-start (operator is managing NATS externally)

### Graceful degradation

If `NATS_URL` is explicitly set, `NatsManager` skips binary installation and server spawn entirely — it assumes an external NATS server. This lets advanced operators run their own NATS cluster while development machines get the auto-managed experience.

## Testing

- Unit tests for `NatsManager`: mock Supervisor, verify start/stop lifecycle
- Verify `installBinary` reuse works with NATS archive format (.zip)
- Integration: `TINSTAR_FAST_SIM=1` should skip real NATS start (same pattern as observability)
- Verify existing observability tests still pass after import path changes

## Risks

**Low risk:** The shared infra extraction is purely mechanical (move files, update imports). `tsc --noEmit` catches any broken import immediately. No logic changes to Supervisor, binaries, or lock.

**Medium risk:** NATS server binary checksums must be verified against official releases before merging. Wrong checksums = download failure on fresh machines.

# NATS Server Auto-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-start `nats-server` as a managed subprocess so NATS is always available when Tinstar runs.

**Architecture:** Extract shared binary/process infrastructure (`Supervisor`, `installBinary`, `lock`) from `src/server/observability/` into `src/server/infra/`. Add `NatsManager` in `src/server/nats/` that installs the nats-server binary, spawns it via Supervisor, and exposes a ready URL for downstream consumers. Integrate into `index.ts` startup/shutdown.

**Tech Stack:** Node.js child_process, `nats` npm package (already a dependency), vitest

---

### Task 1: Create `src/server/infra/types.ts` — shared service types

**Files:**
- Create: `src/server/infra/types.ts`

- [ ] **Step 1: Create the shared types file**

Extract `ServiceState` (renamed from `ObservabilityState`), `SupervisorState`, and `DownloadProgress` into a new shared module. Widen `DownloadProgress.component` from `'prometheus' | 'alloy'` to `string` so any managed binary can use it.

```typescript
// src/server/infra/types.ts

export type ServiceState =
  | 'idle'
  | 'downloading'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'download-failed'
  | 'disabled'

export interface DownloadProgress {
  component: string
  bytesReceived: number
  bytesTotal: number
}

export interface SupervisorState {
  pid: number
  binaryPath: string
  binaryHash: string
  port: number
  startedAt: number
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (new file, no consumers yet)

- [ ] **Step 3: Commit**

```bash
git add src/server/infra/types.ts
git commit -m "refactor: extract shared ServiceState types into infra/types"
```

---

### Task 2: Move `supervisor.ts` to `src/server/infra/`

**Files:**
- Create: `src/server/infra/supervisor.ts`
- Modify: `src/server/observability/supervisor.ts` (becomes re-export shim)
- Modify: `src/server/observability/__tests__/supervisor.test.ts:5` (update import)

- [ ] **Step 1: Create the infra copy with updated imports**

Copy `src/server/observability/supervisor.ts` to `src/server/infra/supervisor.ts`. Change the import on line 4 from `./types.js` to `./types.js` (same relative path, but now points to infra/types). Rename `ObservabilityState` → `ServiceState` throughout:

```typescript
// src/server/infra/supervisor.ts — line 4
import type { ServiceState, SupervisorState } from './types.js'
```

Replace all occurrences of `ObservabilityState` with `ServiceState` in the file (lines 4, 23, 27, 138).

- [ ] **Step 2: Turn observability/supervisor.ts into a re-export shim**

Replace the entire contents of `src/server/observability/supervisor.ts` with:

```typescript
// Re-export from shared infra for backwards compatibility.
export { Supervisor } from '../infra/supervisor.js'
export type { SupervisorOpts } from '../infra/supervisor.js'
```

- [ ] **Step 3: Update the supervisor test import**

In `src/server/observability/__tests__/supervisor.test.ts`, line 5:

```typescript
// Before:
import { Supervisor } from '../supervisor'
// After:
import { Supervisor } from '../../infra/supervisor'
```

- [ ] **Step 4: Run supervisor tests**

Run: `npx vitest run src/server/observability/__tests__/supervisor.test.ts`
Expected: All 7 tests pass

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/infra/supervisor.ts src/server/observability/supervisor.ts src/server/observability/__tests__/supervisor.test.ts
git commit -m "refactor: move Supervisor to infra/, shim in observability/"
```

---

### Task 3: Move `lock.ts` to `src/server/infra/`

**Files:**
- Create: `src/server/infra/lock.ts`
- Modify: `src/server/observability/lock.ts` (becomes re-export shim)
- Modify: `src/server/observability/__tests__/lock.test.ts:5` (update import)
- Modify: `src/server/observability/index.ts:7` (update import)

- [ ] **Step 1: Copy lock.ts to infra/**

Copy `src/server/observability/lock.ts` to `src/server/infra/lock.ts` unchanged (no type references to rename).

- [ ] **Step 2: Turn observability/lock.ts into a re-export shim**

```typescript
// Re-export from shared infra for backwards compatibility.
export { acquireLock, tryAcquireLock } from '../infra/lock.js'
export type { ReleaseFn } from '../infra/lock.js'
```

- [ ] **Step 3: Update the lock test import**

In `src/server/observability/__tests__/lock.test.ts`, line 5:

```typescript
// Before:
import { acquireLock, tryAcquireLock } from '../lock'
// After:
import { acquireLock, tryAcquireLock } from '../../infra/lock'
```

- [ ] **Step 4: Update observability/index.ts import**

In `src/server/observability/index.ts`, line 7:

```typescript
// Before:
import { acquireLock, type ReleaseFn } from './lock.js'
// After:
import { acquireLock, type ReleaseFn } from '../infra/lock.js'
```

- [ ] **Step 5: Run lock tests**

Run: `npx vitest run src/server/observability/__tests__/lock.test.ts`
Expected: All 5 tests pass

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/infra/lock.ts src/server/observability/lock.ts src/server/observability/__tests__/lock.test.ts src/server/observability/index.ts
git commit -m "refactor: move lock to infra/, shim in observability/"
```

---

### Task 4: Move `binaries.ts` to `src/server/infra/`

**Files:**
- Create: `src/server/infra/binaries.ts`
- Modify: `src/server/observability/binaries.ts` (becomes re-export shim)
- Modify: `src/server/observability/__tests__/binaries.test.ts:7-8` (update imports)
- Modify: `src/server/observability/index.ts:5` (update import)

- [ ] **Step 1: Copy binaries.ts to infra/ and update imports**

Copy `src/server/observability/binaries.ts` to `src/server/infra/binaries.ts`. Update line 8:

```typescript
// Before:
import type { BinaryTarget } from './manifest.js'
// After:
import type { BinaryTarget } from './types.js'
```

Also update the `DownloadProgress` import — the function uses it in `onProgress` callbacks. Since `DownloadProgress` is now in `./types.js`, add it to the import on line 8 (if not already covered). The current code references `'prometheus' | 'alloy'` in the onProgress type on line 96 — change that to `string` (it's the `component` field of the progress callback, now widened):

Line 96 changes from:
```typescript
if (onProgress) onProgress({ component: component as 'prometheus' | 'alloy', bytesReceived: received, bytesTotal: total })
```
to:
```typescript
if (onProgress) onProgress({ component, bytesReceived: received, bytesTotal: total })
```

And update the import at the top:
```typescript
import type { BinaryTarget, DownloadProgress } from './types.js'
```

- [ ] **Step 2: Move `BinaryTarget` into `infra/types.ts`**

Add the `BinaryTarget` interface to `src/server/infra/types.ts`:

```typescript
export interface BinaryTarget {
  component: string
  version: string
  url: string
  sha256: string
  executableRelPath: string
  archiveKind: 'tar.gz' | 'zip'
}
```

- [ ] **Step 3: Turn observability/binaries.ts into a re-export shim**

```typescript
// Re-export from shared infra for backwards compatibility.
export { installBinary } from '../infra/binaries.js'
export type { InstallResult, ProgressFn } from '../infra/binaries.js'
```

- [ ] **Step 4: Update observability/manifest.ts to import BinaryTarget from infra**

In `src/server/observability/manifest.ts`, add at line 1:

```typescript
import type { BinaryTarget } from '../infra/types.js'
```

Remove the local `BinaryTarget` interface definition (lines 3-12) and the local `Component` type. Keep the local `Component` type as a narrowed alias:

```typescript
export type Component = 'prometheus' | 'alloy'
```

Update `resolveBinaryTarget` to cast `component` to satisfy the wider `string` type in `BinaryTarget` (it already does — `component` is passed as a parameter).

- [ ] **Step 5: Update observability/index.ts import**

In `src/server/observability/index.ts`, line 5:

```typescript
// Before:
import { installBinary, type ProgressFn } from './binaries.js'
// After:
import { installBinary, type ProgressFn } from '../infra/binaries.js'
```

- [ ] **Step 6: Update observability/types.ts — re-export shared types**

Replace `src/server/observability/types.ts` with:

```typescript
// Re-export shared service types so existing consumers don't break.
export type { ServiceState as ObservabilityState, DownloadProgress, SupervisorState } from '../infra/types.js'

export interface ModelBreakdown {
  [model: string]: number
}

export interface HudSnapshot {
  window: 'today'
  state: import('../infra/types.js').ServiceState
  cost: { total: number | null; byModel: ModelBreakdown }
  tokens: { total: number | null }
  rate: { perMin: number | null; perHour: number | null }
  cacheHitPct: number | null
  autonomy: { ratio: number | null; cliSeconds: number | null; userSeconds: number | null }
  staleSeconds?: number
  progress?: import('../infra/types.js').DownloadProgress[]
  error?: string
}
```

- [ ] **Step 7: Update binaries test import**

In `src/server/observability/__tests__/binaries.test.ts`, lines 7-8:

```typescript
// Before:
import { installBinary } from '../binaries'
import type { BinaryTarget } from '../manifest'
// After:
import { installBinary } from '../../infra/binaries'
import type { BinaryTarget } from '../../infra/types'
```

- [ ] **Step 8: Run all observability tests**

Run: `npx vitest run src/server/observability/__tests__/`
Expected: All tests pass (supervisor, lock, binaries, types-smoke, stack, manifest, config-render, query)

- [ ] **Step 9: Full type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/server/infra/types.ts src/server/infra/binaries.ts src/server/observability/binaries.ts src/server/observability/manifest.ts src/server/observability/types.ts src/server/observability/index.ts src/server/observability/__tests__/binaries.test.ts
git commit -m "refactor: move binaries + BinaryTarget to infra/, update observability imports"
```

---

### Task 5: Create `src/server/nats/manifest.ts` — NATS binary targets

**Files:**
- Create: `src/server/nats/manifest.ts`
- Test: `src/server/nats/__tests__/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/nats/__tests__/manifest.test.ts
import { describe, it, expect } from 'vitest'
import { resolveNatsTarget } from '../manifest'

describe('resolveNatsTarget', () => {
  it('resolves linux-x64 to a tar.gz archive', () => {
    const t = resolveNatsTarget('linux', 'x64')
    expect(t.component).toBe('nats')
    expect(t.version).toBe('2.10.24')
    expect(t.archiveKind).toBe('tar.gz')
    expect(t.url).toContain('nats-server')
    expect(t.url).toContain('linux-amd64')
    expect(t.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(t.executableRelPath).toContain('nats-server')
  })

  it('resolves darwin-arm64 to a zip archive', () => {
    const t = resolveNatsTarget('darwin', 'arm64')
    expect(t.archiveKind).toBe('zip')
    expect(t.url).toContain('darwin-arm64')
  })

  it('throws for unsupported platform', () => {
    expect(() => resolveNatsTarget('win32', 'x64')).toThrow(/not supported/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/nats/__tests__/manifest.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the manifest**

Fetch the real checksums from the NATS v2.10.24 release, then create:

```typescript
// src/server/nats/manifest.ts
import type { BinaryTarget } from '../infra/types.js'

const VERSION = '2.10.24'

const CHECKSUMS: Record<string, string> = {
  'darwin-arm64': '<sha256 from release>',
  'darwin-x64':   '<sha256 from release>',
  'linux-arm64':  '<sha256 from release>',
  'linux-x64':    '<sha256 from release>',
}

const ARCH_MAP: Record<string, string> = { arm64: 'arm64', x64: 'amd64' }

type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64'

function variantKey(os: string, arch: string): PlatformKey {
  const mappedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  if (!mappedArch) throw new Error(`nats-server not supported on arch=${arch}`)
  if (os !== 'darwin' && os !== 'linux') throw new Error(`nats-server not supported on os=${os}`)
  return `${os}-${mappedArch}` as PlatformKey
}

export function resolveNatsTarget(os: string, arch: string): BinaryTarget {
  const key = variantKey(os, arch)
  const natsArch = ARCH_MAP[arch] ?? arch
  const ext = os === 'darwin' ? 'zip' : 'tar.gz'
  const dirName = `nats-server-v${VERSION}-${os}-${natsArch}`
  return {
    component: 'nats',
    version: VERSION,
    url: `https://github.com/nats-io/nats-server/releases/download/v${VERSION}/${dirName}.${ext}`,
    sha256: CHECKSUMS[key],
    executableRelPath: `${dirName}/nats-server`,
    archiveKind: ext,
  }
}
```

**IMPORTANT:** The `<sha256 from release>` placeholders MUST be replaced with real checksums. Fetch them at implementation time:
```bash
curl -sL https://github.com/nats-io/nats-server/releases/download/v2.10.24/SHA256SUMS | grep -E '(darwin|linux)-(amd64|arm64)'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/nats/__tests__/manifest.test.ts`
Expected: All 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server/nats/manifest.ts src/server/nats/__tests__/manifest.test.ts
git commit -m "feat: add NATS server binary manifest with platform targets"
```

---

### Task 6: Create `src/server/nats/nats-manager.ts`

**Files:**
- Create: `src/server/nats/nats-manager.ts`
- Test: `src/server/nats/__tests__/nats-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/server/nats/__tests__/nats-manager.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { NatsManager } from '../nats-manager'

describe('NatsManager', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('starts as idle with default port 4222', () => {
    const mgr = new NatsManager()
    expect(mgr.state).toBe('idle')
    expect(mgr.url).toBe('nats://127.0.0.1:4222')
  })

  it('respects NATS_PORT env var', () => {
    vi.stubEnv('NATS_PORT', '4333')
    const mgr = new NatsManager()
    expect(mgr.url).toBe('nats://127.0.0.1:4333')
  })

  it('skips start when NATS_URL is set (external server)', async () => {
    vi.stubEnv('NATS_URL', 'nats://remote:4222')
    const mgr = new NatsManager()
    await mgr.start()
    expect(mgr.state).toBe('ready')
    expect(mgr.url).toBe('nats://remote:4222')
  })

  it('skips start in fast-sim mode', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const mgr = new NatsManager()
    await mgr.start()
    expect(mgr.state).toBe('ready')
  })

  it('stop on an idle manager is a no-op', async () => {
    const mgr = new NatsManager()
    await mgr.stop()
    expect(mgr.state).toBe('idle')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/nats/__tests__/nats-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the NatsManager implementation**

```typescript
// src/server/nats/nats-manager.ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { connect } from 'nats'
import { Supervisor } from '../infra/supervisor.js'
import { installBinary } from '../infra/binaries.js'
import { resolveNatsTarget } from './manifest.js'
import { log } from '../logger.js'
import type { ServiceState } from '../infra/types.js'

const DEFAULT_PORT = 4222

export class NatsManager {
  state: ServiceState = 'idle'
  url: string

  private supervisor: Supervisor | null = null
  private readonly port: number
  private readonly configRoot: string
  private readonly external: boolean

  constructor(opts?: { configRoot?: string; port?: number }) {
    const externalUrl = process.env.NATS_URL
    this.external = !!externalUrl
    this.port = externalUrl
      ? 0
      : parseInt(process.env.NATS_PORT ?? String(opts?.port ?? DEFAULT_PORT), 10)
    this.url = externalUrl ?? `nats://127.0.0.1:${this.port}`
    this.configRoot = opts?.configRoot ?? join(homedir(), '.config', 'tinstar')
  }

  async start(): Promise<void> {
    if (this.external) {
      this.state = 'ready'
      log.info('nats', `using external NATS server at ${this.url}`)
      return
    }

    if (process.env.TINSTAR_FAST_SIM === '1') {
      this.state = 'ready'
      log.info('nats', 'fast-sim mode: skipping real NATS server')
      return
    }

    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      this.state = 'disabled'
      log.info('nats', `disabled: unsupported platform ${process.platform}`)
      return
    }

    const binRoot = join(this.configRoot, 'bin')
    const stateDir = join(this.configRoot, 'nats')
    mkdirSync(stateDir, { recursive: true })

    try {
      this.state = 'downloading'
      const target = resolveNatsTarget(process.platform, process.arch)
      log.info('nats', `installing nats-server@${target.version}`)
      const install = await installBinary(target, binRoot)
      log.info('nats', 'nats-server installed', { binaryPath: install.binaryPath })

      this.state = 'starting'
      this.supervisor = new Supervisor({
        name: 'nats-server',
        binaryPath: install.binaryPath,
        args: ['-a', '127.0.0.1', '-p', String(this.port)],
        stateDir,
        port: this.port,
        probe: () => this.probe(),
        expectedBinaryName: 'nats-server',
        onStateChange: (_name, s) => { this.state = s },
      })

      await this.supervisor.start()
      this.state = this.supervisor.state
      if (this.state === 'ready') {
        log.info('nats', `nats-server ready on ${this.url}`, { pid: this.supervisor.pid })
      } else {
        log.warn('nats', `nats-server degraded after start: ${this.state}`)
      }
    } catch (err) {
      this.state = 'degraded'
      log.error('nats', `failed to start nats-server: ${(err as Error).message}`)
    }
  }

  async stop(): Promise<void> {
    if (this.supervisor) {
      await this.supervisor.stop()
      this.supervisor = null
    }
    if (!this.external) this.state = 'idle'
    log.info('nats', 'nats-server stopped')
  }

  private async probe(): Promise<boolean> {
    try {
      const nc = await connect({ servers: this.url })
      await nc.close()
      return true
    } catch {
      return false
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/nats/__tests__/nats-manager.test.ts`
Expected: All 5 tests pass

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/nats/nats-manager.ts src/server/nats/__tests__/nats-manager.test.ts
git commit -m "feat: NatsManager — supervised nats-server with install, probe, fast-sim bypass"
```

---

### Task 7: Integrate NatsManager into `index.ts` startup and shutdown

**Files:**
- Modify: `src/server/index.ts:32-33` (add import)
- Modify: `src/server/index.ts:78-88` (update shutdown handler)
- Modify: `src/server/index.ts:94-101` (replace NATS startup)

- [ ] **Step 1: Add NatsManager import**

In `src/server/index.ts`, after line 32 (`import { NatsTrafficBridge } from './nats-traffic'`), add:

```typescript
import { NatsManager } from './nats/nats-manager.js'
```

- [ ] **Step 2: Replace NATS startup block**

Replace lines 94-101:

```typescript
  // Start NATS traffic bridge — subscribes to widget subjects and broadcasts via SSE
  const natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222'
  const natsTraffic = new NatsTrafficBridge(sse, natsUrl)
  natsTraffic.start()

  // Start session readiness tracker — listens for tinstar.ready.> signals
  const readinessTracker = new SessionReadinessTracker(natsUrl)
  readinessTracker.start()
```

With:

```typescript
  // Start managed NATS server (installs binary if needed, spawns, probes)
  const natsManager = new NatsManager()
  await natsManager.start()

  // Start NATS traffic bridge — subscribes to widget subjects and broadcasts via SSE
  const natsTraffic = new NatsTrafficBridge(sse, natsManager.url)
  natsTraffic.start()

  // Start session readiness tracker — listens for tinstar.ready.> signals
  const readinessTracker = new SessionReadinessTracker(natsManager.url)
  readinessTracker.start()
```

Note: `initBackend` is currently synchronous. The `await natsManager.start()` requires making it `async`. Check if callers can handle this — if `initBackend` is called with `void initBackend()` from the Vite plugin, wrapping the NATS block with `void (async () => { ... })()` is safer. Inspect the call site and choose accordingly.

- [ ] **Step 3: Update shutdown handler**

Replace lines 80-84:

```typescript
    const shutdown = async () => {
      try { await observability.stop() } catch { /* ignore */ }
      try { telemetryRoutes.stopPolling() } catch { /* ignore */ }
      try { docStore.flush() } catch { /* ignore */ }
      process.exit(0)
    }
```

With:

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

Note: `natsTraffic`, `readinessTracker`, and `natsManager` are declared after the shutdown handler registration (lines 78-88 vs 94-101). You'll need to hoist the declarations or restructure so the shutdown handler can reference them. The simplest approach: declare `let natsManager: NatsManager`, `let natsTraffic: NatsTrafficBridge`, `let readinessTracker: SessionReadinessTracker` before the shutdown block, then assign them after.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Verify with fast-sim**

Run: `TINSTAR_FAST_SIM=1 npx tsx src/server/standalone.ts &`
Wait 3 seconds, then check logs for: `[nats] fast-sim mode: skipping real NATS server`
Kill the server.

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: wire NatsManager into startup/shutdown — managed NATS server lifecycle"
```

---

### Task 8: Run full test suite and type-check

**Files:** None (verification only)

- [ ] **Step 1: Run all observability tests**

Run: `npx vitest run src/server/observability/__tests__/`
Expected: All tests pass — the re-export shims preserve all existing behavior

- [ ] **Step 2: Run all NATS tests**

Run: `npx vitest run src/server/nats/__tests__/`
Expected: All tests pass

- [ ] **Step 3: Full type-check**

Run: `npx tsc --noEmit`
Expected: PASS with no errors

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit any remaining fixes**

If any test failures were found and fixed, commit them:

```bash
git add -A
git commit -m "fix: resolve test failures from infra extraction"
```

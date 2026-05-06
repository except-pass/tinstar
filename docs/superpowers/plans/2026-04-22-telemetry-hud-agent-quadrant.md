# Telemetry HUD Agent Quadrant + Avatars — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 2×2 agent quadrant (BUSY × LLM) with procedural DiceBear avatars to the telemetry HUD, plus a visible close button and collapsed icon mirroring the minimap pattern.

**Architecture:** Server adds a cheap `burningSessions` Prometheus query (~0.7ms) and translates Claude-Code conversation UUIDs back to tinstar run IDs. The client renders live agents as procedural DiceBear `bottts-neutral` avatars seeded by `run.id`, placed in one of four cells by the combination of tinstar status (BUSY vs READY) and telemetry token rate (LLM vs quiet). Avatar generation is client-side, memoized, with a dynamic-import bundle split so first paint is never blocked.

**Tech Stack:** React + TypeScript, Vite, Tailwind, Prometheus HTTP API, DiceBear (`@dicebear/core` + `@dicebear/collection`).

**Spec:** `docs/superpowers/specs/2026-04-22-telemetry-hud-agent-quadrant-design.md`

---

## File Structure

**Server (new):**
- None — all server changes modify existing files.

**Server (modified):**
- `src/server/observability/query.ts` — add `burningSessions()` method
- `src/server/observability/types.ts` — add `burningRunIds` to `HudSnapshot`
- `src/server/observability/fast-sim.ts` — stub `burningRunIds` for FAST_SIM
- `src/server/api/telemetry.ts` — call `burningSessions`, translate to run IDs, attach to snapshot
- `src/server/index.ts` — provide the reverse lookup dep

**Client (new):**
- `src/components/agentAvatarCache.ts` — module-level SVG cache + lazy DiceBear import
- `src/components/CanvasHud/AgentAvatar.tsx` — one agent's button + ring + icon
- `src/components/CanvasHud/AgentQuadrant.tsx` — the 2×2 grid

**Client (modified):**
- `src/components/agentIcon.tsx` — add `seed` + `color` props, DiceBear fallback tier
- `src/components/CanvasHud/CanvasHud.tsx` — mount `<AgentQuadrant>`, add visible ✕ and collapsed icon
- `src/components/CanvasHud/index.ts` — re-export `AgentQuadrant` (optional, for tests)
- `src/components/InfiniteCanvas.tsx` — pass `runMap` + `onFocusRun` into `<CanvasHud>`
- `src/hooks/useTelemetryHud.ts` — no code change; consumes new `burningRunIds` field automatically via the type

**Tests (new):**
- `src/server/observability/__tests__/burning-sessions.test.ts`
- `src/server/api/__tests__/telemetry-burning.test.ts`
- `src/components/__tests__/agentAvatarCache.test.ts`
- `src/components/__tests__/agentIcon.test.tsx`
- `src/components/CanvasHud/__tests__/AgentQuadrant.test.tsx`
- `e2e/agent-quadrant.spec.ts`

---

## Task 1: Add `burningRunIds` field to `HudSnapshot` type

**Files:**
- Modify: `src/server/observability/types.ts`

- [ ] **Step 1: Add the field**

Edit `src/server/observability/types.ts`. Change the `HudSnapshot` interface to add the new optional field at the bottom:

```ts
export interface HudSnapshot {
  window: 'today'
  state: import('../infra/types.js').ServiceState
  cost: { total: number | null; byModel: ModelBreakdown }
  tokens: { total: number | null }
  rate: { perMin: number | null; perHour: number | null }
  cacheHitPct: number | null
  autonomy: { ratio: number | null; cliSeconds: number | null; userSeconds: number | null }
  /** Tinstar run IDs currently burning tokens (non-zero rate in the last 30s). */
  burningRunIds?: string[]
  staleSeconds?: number
  progress?: import('../infra/types.js').DownloadProgress[]
  error?: string
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors (optional field; no existing consumer is broken).

- [ ] **Step 3: Commit**

```bash
git add src/server/observability/types.ts
git commit -m "feat(telemetry): add burningRunIds to HudSnapshot (#telemetry-hud-avatars)"
```

---

## Task 2: `TelemetryQuery.burningSessions()` — failing test

**Files:**
- Create: `src/server/observability/__tests__/burning-sessions.test.ts`
- Will modify next task: `src/server/observability/query.ts`

- [ ] **Step 1: Inspect existing tests to match conventions**

Run: `ls src/server/observability/__tests__/`
Expected to see: `query.test.ts`, `stack.test.ts`.

Read the first ~30 lines of `src/server/observability/__tests__/query.test.ts` to see how Prometheus responses are mocked (likely a fetch mock or node test helpers).

- [ ] **Step 2: Write the failing test**

Create `src/server/observability/__tests__/burning-sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TelemetryQuery } from '../query.js'

describe('TelemetryQuery.burningSessions', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn() as any
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns the set of session_ids with non-zero token rate', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: { session_id: 'uuid-a' }, value: [1700000000, '42.5'] },
            { metric: { session_id: 'uuid-b' }, value: [1700000000, '8.1'] },
          ],
        },
      }),
    })

    const q = new TelemetryQuery('http://fake')
    const result = await q.burningSessions({ userEmail: 'x@example.com' })

    expect(result).toEqual(['uuid-a', 'uuid-b'])
    expect((global.fetch as any).mock.calls.length).toBe(1)
    const url = (global.fetch as any).mock.calls[0][0] as string
    expect(url).toContain('rate(claude_code_token_usage_tokens_total')
    expect(url).toContain('user_email%3D%22x%40example.com%22') // url-encoded
  })

  it('returns empty array when no series match', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'vector', result: [] } }),
    })
    const q = new TelemetryQuery('http://fake')
    expect(await q.burningSessions({ userEmail: 'x@example.com' })).toEqual([])
  })

  it('skips series that lack a session_id label', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: {}, value: [1700000000, '1'] },
            { metric: { session_id: 'uuid-c' }, value: [1700000000, '2'] },
          ],
        },
      }),
    })
    const q = new TelemetryQuery('http://fake')
    expect(await q.burningSessions({ userEmail: 'x@example.com' })).toEqual(['uuid-c'])
  })

  it('throws on non-success Prometheus response', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'error', error: 'boom' }),
    })
    const q = new TelemetryQuery('http://fake')
    await expect(q.burningSessions({ userEmail: 'x@example.com' })).rejects.toThrow(/boom/)
  })
})
```

- [ ] **Step 3: Run and verify FAIL**

Run: `npx vitest run src/server/observability/__tests__/burning-sessions.test.ts`
Expected: FAIL — `q.burningSessions is not a function`.

- [ ] **Step 4: Commit the failing test**

```bash
git add src/server/observability/__tests__/burning-sessions.test.ts
git commit -m "test(telemetry): add failing burningSessions tests (#telemetry-hud-avatars)"
```

---

## Task 3: Implement `burningSessions()`

**Files:**
- Modify: `src/server/observability/query.ts`

- [ ] **Step 1: Add the method**

In `src/server/observability/query.ts`, after the existing `todayHud` method and before `private secondsSinceLocalMidnight`, add:

```ts
  /**
   * Returns Claude Code conversation session_ids that have emitted tokens in
   * the last 30 seconds. Cheap: single PromQL aggregation, measured ~0.7ms
   * against a local Prometheus with ~60 token-metric series.
   */
  async burningSessions(opts: { userEmail: string }): Promise<string[]> {
    const filter = opts.userEmail ? `{user_email="${opts.userEmail}",type=~"input|output"}` : `{type=~"input|output"}`
    const query = `sum by (session_id) (rate(claude_code_token_usage_tokens_total${filter}[30s])) > 0`
    const vec = await this.instantVec(query)
    const out: string[] = []
    for (const r of vec) {
      const sid = r.metric.session_id
      if (sid) out.push(sid)
    }
    return out
  }
```

- [ ] **Step 2: Run tests to verify PASS**

Run: `npx vitest run src/server/observability/__tests__/burning-sessions.test.ts`
Expected: PASS — all four tests green.

- [ ] **Step 3: Run the full query test file to ensure no regressions**

Run: `npx vitest run src/server/observability/__tests__/query.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/observability/query.ts
git commit -m "feat(telemetry): implement burningSessions Prometheus query (#telemetry-hud-avatars)"
```

---

## Task 4: Add `getBurningRunIds` dep on telemetry routes — failing test

**Files:**
- Create: `src/server/api/__tests__/telemetry-burning.test.ts`

- [ ] **Step 1: Inspect existing telemetry tests to match conventions**

Read the first ~100 lines of `src/server/api/__tests__/telemetry.test.ts` to find how `createTelemetryRoutes` is invoked in tests (it has a `getSessionConversationId` dep — we'll be adding a sibling).

- [ ] **Step 2: Write the failing test**

Create `src/server/api/__tests__/telemetry-burning.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTelemetryRoutes } from '../telemetry.js'
import type { HudSnapshot } from '../../observability/types.js'

function fakeSse() {
  return { broadcastEvent: vi.fn() } as any
}

function fakeQuery(overrides: Partial<{
  todayHud: (opts: any) => Promise<HudSnapshot>
  burningSessions: (opts: any) => Promise<string[]>
}> = {}) {
  return {
    todayHud: overrides.todayHud ?? (async () => ({
      window: 'today', state: 'ready',
      cost: { total: 0, byModel: {} },
      tokens: { total: 0 }, rate: { perMin: 0, perHour: 0 },
      cacheHitPct: null,
      autonomy: { ratio: null, cliSeconds: null, userSeconds: null },
    })),
    burningSessions: overrides.burningSessions ?? (async () => []),
  } as any
}

describe('telemetry routes — burningRunIds translation', () => {
  it('attaches burningRunIds to the snapshot, translated from conversation UUIDs', async () => {
    const routes = createTelemetryRoutes({
      sse: fakeSse(),
      query: fakeQuery({
        burningSessions: async () => ['uuid-a', 'uuid-b', 'uuid-missing'],
      }),
      getState: () => 'ready',
      getProgress: () => [],
      getLastError: () => null,
      restart: async () => {},
      getDefaultUserEmail: () => 'x@example.com',
      getSessionConversationId: () => null,
      getRunIdsForConversationIds: (uuids) => {
        const map: Record<string, string> = { 'uuid-a': 'run-1', 'uuid-b': 'run-2' }
        return uuids.map(u => map[u]).filter((x): x is string => !!x)
      },
    })

    const res: any = { writeHead: vi.fn(), end: vi.fn() }
    await routes.handle({ method: 'GET', url: '/api/telemetry/hud' } as any, res, '/api/telemetry/hud')
    const body = JSON.parse(res.end.mock.calls[0][0]) as HudSnapshot
    expect(body.burningRunIds).toEqual(['run-1', 'run-2'])
  })

  it('leaves burningRunIds as empty array when no sessions are burning', async () => {
    const routes = createTelemetryRoutes({
      sse: fakeSse(),
      query: fakeQuery({ burningSessions: async () => [] }),
      getState: () => 'ready',
      getProgress: () => [],
      getLastError: () => null,
      restart: async () => {},
      getDefaultUserEmail: () => 'x@example.com',
      getSessionConversationId: () => null,
      getRunIdsForConversationIds: () => [],
    })
    const res: any = { writeHead: vi.fn(), end: vi.fn() }
    await routes.handle({ method: 'GET', url: '/api/telemetry/hud' } as any, res, '/api/telemetry/hud')
    const body = JSON.parse(res.end.mock.calls[0][0]) as HudSnapshot
    expect(body.burningRunIds).toEqual([])
  })

  it('degrades gracefully when burningSessions throws', async () => {
    const routes = createTelemetryRoutes({
      sse: fakeSse(),
      query: fakeQuery({ burningSessions: async () => { throw new Error('prom down') } }),
      getState: () => 'ready',
      getProgress: () => [],
      getLastError: () => null,
      restart: async () => {},
      getDefaultUserEmail: () => 'x@example.com',
      getSessionConversationId: () => null,
      getRunIdsForConversationIds: () => [],
    })
    const res: any = { writeHead: vi.fn(), end: vi.fn() }
    await routes.handle({ method: 'GET', url: '/api/telemetry/hud' } as any, res, '/api/telemetry/hud')
    const body = JSON.parse(res.end.mock.calls[0][0]) as HudSnapshot
    expect(body.burningRunIds).toEqual([])
    // Other fields still present
    expect(body.state).toBe('ready')
  })
})
```

- [ ] **Step 3: Run and verify FAIL**

Run: `npx vitest run src/server/api/__tests__/telemetry-burning.test.ts`
Expected: FAIL — `getRunIdsForConversationIds` not on the `TelemetryApiDeps` type / `burningSessions` not called.

- [ ] **Step 4: Commit the failing test**

```bash
git add src/server/api/__tests__/telemetry-burning.test.ts
git commit -m "test(telemetry): add failing burningRunIds translation tests (#telemetry-hud-avatars)"
```

---

## Task 5: Wire `burningRunIds` through telemetry routes

**Files:**
- Modify: `src/server/api/telemetry.ts`

- [ ] **Step 1: Extend the deps interface**

In `src/server/api/telemetry.ts`, update `TelemetryApiDeps`:

```ts
export interface TelemetryApiDeps {
  sse: SSEBroadcaster
  query: TelemetryQuery | null
  getState: () => ObservabilityState
  getProgress: () => HudSnapshot['progress']
  getLastError: () => string | null
  restart: () => Promise<void>
  getDefaultUserEmail: () => string
  getSessionConversationId: (sessionName: string) => string | null
  /** Inverse of getSessionConversationId — map conversation UUIDs back to tinstar run IDs. */
  getRunIdsForConversationIds: (conversationIds: string[]) => string[]
}
```

- [ ] **Step 2: Call `burningSessions` inside `buildSnapshot`**

Replace the entire `buildSnapshot` function body with one that adds the burning query. Edit the `buildSnapshot` function in `src/server/api/telemetry.ts`:

```ts
  async function buildSnapshot(sessionName?: string): Promise<HudSnapshot> {
    if (process.env.TINSTAR_FAST_SIM === '1') {
      const fake = makeFakeHud()
      if (sessionName) {
        const SESSION_SCALE = 0.3
        const scaledByModel: Record<string, number> = {}
        for (const [model, cost] of Object.entries(fake.cost.byModel)) {
          scaledByModel[model] = cost * SESSION_SCALE
        }
        return {
          ...fake,
          cost: { total: (fake.cost.total ?? 0) * SESSION_SCALE, byModel: scaledByModel },
          tokens: { total: Math.floor((fake.tokens.total ?? 0) * SESSION_SCALE) },
          rate: {
            perMin: (fake.rate.perMin ?? 0) * SESSION_SCALE,
            perHour: (fake.rate.perHour ?? 0) * SESSION_SCALE,
          },
        }
      }
      return fake
    }
    const state = deps.getState()
    const base: HudSnapshot = {
      window: 'today',
      state,
      cost: { total: null, byModel: {} },
      tokens: { total: null },
      rate: { perMin: null, perHour: null },
      cacheHitPct: null,
      autonomy: { ratio: null, cliSeconds: null, userSeconds: null },
      burningRunIds: [],
      progress: deps.getProgress(),
    }
    const lastError = deps.getLastError()
    if (lastError) base.error = lastError
    if (state !== 'ready' || !deps.query) return base
    const tzOffsetMinutes = new Date().getTimezoneOffset()
    try {
      const sessionId = sessionName ? deps.getSessionConversationId(sessionName) ?? undefined : undefined
      const [hud, burningConvIds] = await Promise.all([
        deps.query.todayHud({
          userEmail: deps.getDefaultUserEmail(),
          tzOffsetMinutes,
          sessionId,
        }),
        deps.query.burningSessions({ userEmail: deps.getDefaultUserEmail() }).catch(() => [] as string[]),
      ])
      const burningRunIds = deps.getRunIdsForConversationIds(burningConvIds)
      return { ...hud, burningRunIds }
    } catch (err) {
      return { ...base, state: 'degraded', error: (err as Error).message }
    }
  }
```

- [ ] **Step 3: Run the new tests**

Run: `npx vitest run src/server/api/__tests__/telemetry-burning.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the existing telemetry tests**

Run: `npx vitest run src/server/api/__tests__/telemetry.test.ts`
Expected: FAIL — existing tests instantiate `createTelemetryRoutes` without the new `getRunIdsForConversationIds` dep.

- [ ] **Step 5: Fix existing telemetry tests**

Open `src/server/api/__tests__/telemetry.test.ts`. Find every `createTelemetryRoutes({ ... })` call and add the missing dep. The simplest fix is to add, in each test deps object:

```ts
      getRunIdsForConversationIds: () => [],
```

Also find any place that constructs a fake `query` object (mock of `TelemetryQuery`). If any test mocks `query.todayHud` without `query.burningSessions`, add `burningSessions: async () => []` to that mock.

- [ ] **Step 6: Re-run all telemetry tests**

Run: `npx vitest run src/server/api/__tests__/telemetry.test.ts src/server/api/__tests__/telemetry-burning.test.ts`
Expected: PASS across both files.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/server/api/telemetry.ts src/server/api/__tests__/telemetry.test.ts
git commit -m "feat(telemetry): emit burningRunIds on HUD snapshots (#telemetry-hud-avatars)"
```

---

## Task 6: Provide the reverse conversation-UUID → run-ID lookup in `server/index.ts`

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Locate the telemetry routes construction**

Open `src/server/index.ts`. Find the block (currently around line 64-77) that reads:

```ts
  const telemetryRoutes = createTelemetryRoutes({
    sse,
    get query() { return observability.query },
    getState: () => observability.state,
    getProgress: () => observability.progress,
    getLastError: () => observability.lastError,
    restart: () => observability.restart(),
    getDefaultUserEmail: () => process.env.TINSTAR_USER_EMAIL ?? '',
    getSessionConversationId: (name: string) => {
      if (!sessionConfig) return null
      const sess = getSession(sessionConfig.dirs.sessions, name)
      return sess?.conversation?.id ?? null
    },
  })
```

- [ ] **Step 2: Add the reverse lookup**

Replace the block above with:

```ts
  const telemetryRoutes = createTelemetryRoutes({
    sse,
    get query() { return observability.query },
    getState: () => observability.state,
    getProgress: () => observability.progress,
    getLastError: () => observability.lastError,
    restart: () => observability.restart(),
    getDefaultUserEmail: () => process.env.TINSTAR_USER_EMAIL ?? '',
    getSessionConversationId: (name: string) => {
      if (!sessionConfig) return null
      const sess = getSession(sessionConfig.dirs.sessions, name)
      return sess?.conversation?.id ?? null
    },
    getRunIdsForConversationIds: (conversationIds) => {
      if (!sessionConfig || conversationIds.length === 0) return []
      const wanted = new Set(conversationIds)
      // Step 1: find session names whose conversation.id matches one of the wanted UUIDs.
      const sessionNamesByConv = new Map<string, string>() // conversationId -> sessionName
      for (const run of docStore.getAllRuns()) {
        // run.sessionId IS the tmux session name in the tinstar data model.
        const sess = getSession(sessionConfig.dirs.sessions, run.sessionId)
        const convId = sess?.conversation?.id
        if (convId && wanted.has(convId)) {
          sessionNamesByConv.set(convId, run.sessionId)
        }
      }
      // Step 2: find run IDs whose sessionId matches one of those session names.
      const wantedSessionNames = new Set(sessionNamesByConv.values())
      const out: string[] = []
      for (const run of docStore.getAllRuns()) {
        if (wantedSessionNames.has(run.sessionId)) out.push(run.id)
      }
      return out
    },
  })
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Smoke-run the server briefly to confirm startup**

Run: `TINSTAR_FAST_SIM=1 timeout 8 npm run dev 2>&1 | tail -20`
Expected: server boots without errors. Kill it.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(telemetry): wire conversation-UUID to run-ID lookup (#telemetry-hud-avatars)"
```

---

## Task 7: FAST_SIM stub for `burningRunIds`

**Files:**
- Modify: `src/server/observability/fast-sim.ts`
- Modify: `src/server/api/telemetry.ts`

- [ ] **Step 1: Extend the fake HUD**

Edit `src/server/observability/fast-sim.ts`. Replace the `makeFakeHud` return expression to include a deterministic-ish rotating set of run IDs:

```ts
export function makeFakeHud(t = Date.now()): HudSnapshot {
  const secs = (t / 1000) % 3600
  const cost = 0.10 + secs * 0.0015
  const tokens = Math.floor(1000 + secs * 85)
  const rate = 1200 + Math.sin(secs / 30) * 400
  // Rotate which fake run IDs are "burning" so the quadrant visibly animates in FAST_SIM.
  const phase = Math.floor(t / 4000) % 4
  const fakeBurning: string[] = []
  if (phase === 0) fakeBurning.push('fake-run-1', 'fake-run-3')
  if (phase === 1) fakeBurning.push('fake-run-2')
  if (phase === 2) fakeBurning.push('fake-run-1', 'fake-run-2', 'fake-run-3')
  // phase === 3 → empty
  return {
    window: 'today',
    state: 'ready',
    cost: {
      total: cost,
      byModel: {
        'claude-opus-4-6': cost * 0.88,
        'claude-haiku-4-5': cost * 0.12,
      },
    },
    tokens: { total: tokens },
    rate: { perMin: Math.max(0, rate), perHour: Math.max(0, rate * 60) },
    cacheHitPct: 0.65 + Math.sin(secs / 45) * 0.15,
    autonomy: { ratio: 4.5 + Math.sin(secs / 60), cliSeconds: 4500, userSeconds: 1000 },
    burningRunIds: fakeBurning,
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/observability/fast-sim.ts
git commit -m "feat(telemetry): FAST_SIM stub for burningRunIds (#telemetry-hud-avatars)"
```

---

## Task 8: Install DiceBear dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install**

Run: `npm install @dicebear/core @dicebear/collection`
Expected: both added to `dependencies` in `package.json`.

- [ ] **Step 2: Verify bundle-friendly import works**

Run: `node -e "import('@dicebear/core').then(m => console.log(typeof m.createAvatar))"`
Expected: prints `function`.

Run: `node -e "import('@dicebear/collection').then(m => console.log(typeof m.botttsNeutral))"`
Expected: prints `object`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add DiceBear for procedural agent avatars (#telemetry-hud-avatars)"
```

---

## Task 9: `agentAvatarCache` — failing test

**Files:**
- Create: `src/components/__tests__/agentAvatarCache.test.ts`
- Will modify next task: `src/components/agentAvatarCache.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/agentAvatarCache.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getAvatarDataUrl, __resetAvatarCacheForTests } from '../agentAvatarCache'

describe('agentAvatarCache', () => {
  beforeEach(() => {
    __resetAvatarCacheForTests()
  })

  it('returns null immediately on first call, then resolves', async () => {
    const sync = getAvatarDataUrl('seed-a', '#ff0000')
    expect(sync).toBeNull()
    // Wait a tick for the dynamic import to resolve.
    await new Promise(r => setTimeout(r, 50))
    const cached = getAvatarDataUrl('seed-a', '#ff0000')
    expect(typeof cached).toBe('string')
    expect(cached!.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('returns the same data URL for the same seed+color', async () => {
    getAvatarDataUrl('seed-b', '#00ff00')
    await new Promise(r => setTimeout(r, 50))
    const first = getAvatarDataUrl('seed-b', '#00ff00')
    const second = getAvatarDataUrl('seed-b', '#00ff00')
    expect(first).toBe(second)
  })

  it('produces distinct SVGs for distinct seeds', async () => {
    getAvatarDataUrl('seed-c', '#0000ff')
    getAvatarDataUrl('seed-d', '#0000ff')
    await new Promise(r => setTimeout(r, 50))
    const c = getAvatarDataUrl('seed-c', '#0000ff')
    const d = getAvatarDataUrl('seed-d', '#0000ff')
    expect(c).not.toBe(d)
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/components/__tests__/agentAvatarCache.test.ts`
Expected: FAIL — module `../agentAvatarCache` not found.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/components/__tests__/agentAvatarCache.test.ts
git commit -m "test(avatars): add failing agentAvatarCache tests (#telemetry-hud-avatars)"
```

---

## Task 10: Implement `agentAvatarCache`

**Files:**
- Create: `src/components/agentAvatarCache.ts`

- [ ] **Step 1: Create the module**

Create `src/components/agentAvatarCache.ts`:

```ts
/**
 * Client-side DiceBear avatar cache.
 *
 * Avatars are a pure function of (seed, color). They are generated
 * lazily on first request: the first call kicks off a dynamic import
 * of DiceBear and returns null. When the library has resolved and the
 * SVG has been rendered, it is stored in a module-level Map and all
 * subsequent calls return the cached data URL synchronously.
 *
 * Consumers should treat a null return as "not ready yet — render a
 * placeholder" and re-request on the next tick / state change.
 */

type Loaded = {
  createAvatar: typeof import('@dicebear/core').createAvatar
  botttsNeutral: typeof import('@dicebear/collection').botttsNeutral
}

let loadedPromise: Promise<Loaded> | null = null
let loaded: Loaded | null = null
const cache = new Map<string, string>()
const pending = new Set<string>()
const listeners = new Set<() => void>()

function keyOf(seed: string, color: string): string {
  return `${seed}:${color}`
}

function ensureLoaded(): Promise<Loaded> {
  if (loaded) return Promise.resolve(loaded)
  if (!loadedPromise) {
    loadedPromise = Promise.all([
      import('@dicebear/core'),
      import('@dicebear/collection'),
    ]).then(([core, col]) => {
      loaded = { createAvatar: core.createAvatar, botttsNeutral: col.botttsNeutral }
      return loaded
    })
  }
  return loadedPromise
}

function notify(): void {
  for (const fn of listeners) fn()
}

function normalizeHex(color: string): string {
  // DiceBear expects color strings without the leading '#'.
  return color.startsWith('#') ? color.slice(1) : color
}

/**
 * Get the cached avatar data URL, or null if it's not yet rendered.
 * On null, kicks off async generation that will fill the cache; subscribe
 * via `subscribeAvatarCache` to be notified when the avatar becomes ready.
 */
export function getAvatarDataUrl(seed: string, color: string): string | null {
  const k = keyOf(seed, color)
  const hit = cache.get(k)
  if (hit) return hit
  if (pending.has(k)) return null
  pending.add(k)
  ensureLoaded().then(({ createAvatar, botttsNeutral }) => {
    try {
      const svg = createAvatar(botttsNeutral, {
        seed,
        primaryColor: [normalizeHex(color)],
        backgroundColor: ['0a0f14'],
      }).toString()
      const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
      cache.set(k, dataUrl)
    } catch {
      // Leave the cache empty; consumers fall back to the placeholder.
    } finally {
      pending.delete(k)
      notify()
    }
  }).catch(() => {
    pending.delete(k)
    notify()
  })
  return null
}

/** Subscribe to cache updates. Returns an unsubscribe function. */
export function subscribeAvatarCache(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test-only: reset all state between test cases. */
export function __resetAvatarCacheForTests(): void {
  cache.clear()
  pending.clear()
  listeners.clear()
  loaded = null
  loadedPromise = null
}
```

- [ ] **Step 2: Run tests to verify PASS**

Run: `npx vitest run src/components/__tests__/agentAvatarCache.test.ts`
Expected: PASS — all three tests green.

Note: if the tests fail with "btoa is not defined," Vitest is running in Node-without-browser mode. Add to the failing test file at the top: `globalThis.btoa ??= (s: string) => Buffer.from(s, 'binary').toString('base64')`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/agentAvatarCache.ts src/components/__tests__/agentAvatarCache.test.ts
git commit -m "feat(avatars): lazy DiceBear cache keyed by seed+color (#telemetry-hud-avatars)"
```

---

## Task 11: Extend `<AgentIcon>` with seed/color fallback — failing test

**Files:**
- Create: `src/components/__tests__/agentIcon.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/agentIcon.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { AgentIcon } from '../agentIcon'
import { __resetAvatarCacheForTests } from '../agentAvatarCache'

describe('<AgentIcon>', () => {
  beforeEach(() => { __resetAvatarCacheForTests() })

  it('renders the provided emoji icon when given', () => {
    const { container } = render(<AgentIcon icon="⚡" seed="run-1" color="#ff0000" />)
    expect(container.textContent).toBe('⚡')
  })

  it('renders an <img> for URL icons', () => {
    const { container } = render(<AgentIcon icon="/foo.svg" seed="run-1" color="#ff0000" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('/foo.svg')
  })

  it('renders a colored placeholder circle when no icon and DiceBear not yet loaded', () => {
    const { container } = render(<AgentIcon seed="run-1" color="#abcdef" />)
    const placeholder = container.querySelector('[data-testid="agent-icon-placeholder"]')
    expect(placeholder).not.toBeNull()
    const style = placeholder!.getAttribute('style') ?? ''
    expect(style).toContain('#abcdef')
  })

  it('renders DiceBear <img> after the library resolves', async () => {
    const { container, rerender } = render(<AgentIcon seed="run-distinct" color="#123456" />)
    await new Promise(r => setTimeout(r, 60))
    rerender(<AgentIcon seed="run-distinct" color="#123456" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  })

  it('falls back to the fallback prop when given neither icon nor seed', () => {
    const { container } = render(<AgentIcon fallback={<span data-testid="fb">FB</span>} />)
    expect(container.querySelector('[data-testid="fb"]')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/components/__tests__/agentIcon.test.tsx`
Expected: FAIL — `seed` / `color` props not recognized; placeholder test element absent.

- [ ] **Step 3: Commit failing test**

```bash
git add src/components/__tests__/agentIcon.test.tsx
git commit -m "test(avatars): add failing AgentIcon seed/color fallback tests (#telemetry-hud-avatars)"
```

---

## Task 12: Implement `<AgentIcon>` seed/color fallback

**Files:**
- Modify: `src/components/agentIcon.tsx`

- [ ] **Step 1: Replace the component**

Overwrite `src/components/agentIcon.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { getAvatarDataUrl, subscribeAvatarCache } from './agentAvatarCache'

/**
 * Agent icon helpers.
 *
 * A template's `icon` field is either:
 *   - a short text glyph (emoji or unicode char), e.g. "⚡", "◆"
 *   - a URL/path to an image, e.g. "/agent-icons/anthropic.svg", "https://…"
 *
 * `isIconUrl` distinguishes the two so the UI can render `<img>` for images
 * and text for glyphs.
 */
export function isIconUrl(icon: string | undefined | null): icon is string {
  if (!icon) return false
  return icon.startsWith('/') || icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:')
}

interface AgentIconProps {
  icon?: string | undefined | null
  /** Seed for procedural DiceBear fallback when `icon` is absent. Usually run.id. */
  seed?: string | null
  /** Accent color for procedural DiceBear fallback. Usually run.color. Hex. */
  color?: string | null
  fallback?: React.ReactNode
  className?: string
}

/**
 * Renders an agent template icon. Fallback order:
 *   1. explicit `icon` (emoji or URL)
 *   2. procedural DiceBear `bottts-neutral` seeded by `seed`, tinted by `color`
 *   3. caller-provided `fallback`
 */
export function AgentIcon({ icon, seed, color, fallback, className = 'w-4 h-4' }: AgentIconProps) {
  if (isIconUrl(icon)) {
    return <img src={icon} alt="" aria-hidden="true" className={`${className} inline-block object-contain`} />
  }
  if (icon) {
    return <span aria-hidden="true">{icon}</span>
  }
  if (seed) {
    return <ProceduralAvatar seed={seed} color={color ?? '#64748b'} className={className} />
  }
  return <>{fallback ?? null}</>
}

function ProceduralAvatar({ seed, color, className }: { seed: string; color: string; className: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(() => getAvatarDataUrl(seed, color))

  useEffect(() => {
    if (dataUrl) return
    const unsubscribe = subscribeAvatarCache(() => {
      const hit = getAvatarDataUrl(seed, color)
      if (hit) setDataUrl(hit)
    })
    // Re-check once immediately in case the cache was populated between render and effect.
    const hit = getAvatarDataUrl(seed, color)
    if (hit) setDataUrl(hit)
    return unsubscribe
  }, [seed, color, dataUrl])

  if (dataUrl) {
    return <img src={dataUrl} alt="" aria-hidden="true" className={`${className} inline-block object-contain`} />
  }
  return (
    <span
      data-testid="agent-icon-placeholder"
      aria-hidden="true"
      className={`${className} inline-block rounded-full`}
      style={{ background: color, opacity: 0.6 }}
    />
  )
}
```

- [ ] **Step 2: Run tests to verify PASS**

Run: `npx vitest run src/components/__tests__/agentIcon.test.tsx`
Expected: PASS — all five tests green.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Run all tests to check for regressions**

Run: `npx vitest run`
Expected: PASS (existing consumers of `<AgentIcon>` only pass `icon` and `fallback` — the new props are optional).

- [ ] **Step 5: Commit**

```bash
git add src/components/agentIcon.tsx
git commit -m "feat(avatars): procedural DiceBear fallback in AgentIcon (#telemetry-hud-avatars)"
```

---

## Task 13: `AgentAvatar` component (the clickable button)

**Files:**
- Create: `src/components/CanvasHud/AgentAvatar.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/CanvasHud/AgentAvatar.tsx`:

```tsx
import { AgentIcon } from '../agentIcon'
import type { Run } from '../../domain/types'
import { resolveRunAccent } from '../runAccent'

interface Props {
  run: Run
  onClick: () => void
}

/**
 * A single agent's clickable avatar. Round ring tinted with run.color,
 * containing the AgentIcon (template icon or procedural DiceBear).
 * Click pans the canvas to this agent via onClick → onFocusRun(run.id).
 */
export function AgentAvatar({ run, onClick }: Props) {
  const color = resolveRunAccent(run.color)
  return (
    <button
      type="button"
      onClick={onClick}
      title={run.sessionId}
      data-testid="agent-avatar"
      data-run-id={run.id}
      className="relative inline-flex items-center justify-center"
      style={{
        width: 26,
        height: 26,
        borderRadius: '50%',
        border: `1.5px solid ${color}`,
        background: 'rgba(15,23,42,0.6)',
        padding: 0,
        cursor: 'pointer',
      }}
    >
      <AgentIcon
        icon={run.agentIcon}
        seed={run.id}
        color={color}
        className="w-5 h-5"
      />
    </button>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/CanvasHud/AgentAvatar.tsx
git commit -m "feat(quadrant): AgentAvatar button with ring and procedural face (#telemetry-hud-avatars)"
```

---

## Task 14: `AgentQuadrant` — failing test

**Files:**
- Create: `src/components/CanvasHud/__tests__/AgentQuadrant.test.tsx`
- Will modify next task: `src/components/CanvasHud/AgentQuadrant.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/CanvasHud/__tests__/AgentQuadrant.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AgentQuadrant } from '../AgentQuadrant'
import type { Run } from '../../../domain/types'

function fakeRun(overrides: Partial<Run>): Run {
  return {
    id: 'r1',
    sessionId: 'sess-1',
    status: 'running',
    color: '#22c55e',
    agentIcon: undefined,
    taskId: 't',
    initiative: '', epic: '', task: '',
    repo: '', worktree: '',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null,
    ...overrides,
  } as Run
}

describe('<AgentQuadrant>', () => {
  it('excludes stopped sessions', () => {
    const runMap = new Map([
      ['r1', fakeRun({ id: 'r1', status: 'stopped' })],
      ['r2', fakeRun({ id: 'r2', status: 'running' })],
    ])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={() => {}} />
    )
    const avatars = container.querySelectorAll('[data-testid="agent-avatar"]')
    expect(avatars.length).toBe(1)
    expect(avatars[0].getAttribute('data-run-id')).toBe('r2')
  })

  it('places a BUSY + LLM run in the WORKING cell', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'running' })]])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set(['r1'])} onFocusRun={() => {}} />
    )
    const cell = container.querySelector('[data-testid="quadrant-cell-working"]')
    expect(cell).not.toBeNull()
    expect(cell!.querySelector('[data-run-id="r1"]')).not.toBeNull()
  })

  it('places a BUSY + quiet run in the TOOL cell', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'running' })]])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={() => {}} />
    )
    expect(container.querySelector('[data-testid="quadrant-cell-tool"] [data-run-id="r1"]')).not.toBeNull()
  })

  it('places a READY + LLM run in the SUBAGENT cell', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'idle' })]])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set(['r1'])} onFocusRun={() => {}} />
    )
    expect(container.querySelector('[data-testid="quadrant-cell-subagent"] [data-run-id="r1"]')).not.toBeNull()
  })

  it('places a READY + quiet run in the IDLE cell (including needs_attention and creating)', () => {
    const runMap = new Map([
      ['r1', fakeRun({ id: 'r1', status: 'idle' })],
      ['r2', fakeRun({ id: 'r2', status: 'needs_attention' })],
      ['r3', fakeRun({ id: 'r3', status: 'creating' })],
    ])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={() => {}} />
    )
    const cell = container.querySelector('[data-testid="quadrant-cell-idle"]')
    expect(cell).not.toBeNull()
    expect(cell!.querySelectorAll('[data-testid="agent-avatar"]').length).toBe(3)
  })

  it('calls onFocusRun with the run ID when an avatar is clicked', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'running' })]])
    const onFocusRun = vi.fn()
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={onFocusRun} />
    )
    const btn = container.querySelector('[data-run-id="r1"]') as HTMLElement
    fireEvent.click(btn)
    expect(onFocusRun).toHaveBeenCalledWith('r1')
  })

  it('renders nothing visible when there are zero alive sessions', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'stopped' })]])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={() => {}} />
    )
    expect(container.querySelector('[data-testid="agent-quadrant"]')).toBeNull()
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/components/CanvasHud/__tests__/AgentQuadrant.test.tsx`
Expected: FAIL — `AgentQuadrant` module not found.

- [ ] **Step 3: Commit failing test**

```bash
git add src/components/CanvasHud/__tests__/AgentQuadrant.test.tsx
git commit -m "test(quadrant): add failing AgentQuadrant placement tests (#telemetry-hud-avatars)"
```

---

## Task 15: Implement `AgentQuadrant`

**Files:**
- Create: `src/components/CanvasHud/AgentQuadrant.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/CanvasHud/AgentQuadrant.tsx`:

```tsx
import { useMemo } from 'react'
import type { Run } from '../../domain/types'
import { AgentAvatar } from './AgentAvatar'

type CellKey = 'working' | 'subagent' | 'tool' | 'idle'

interface Props {
  runMap: Map<string, Run>
  burningRunIds: Set<string>
  onFocusRun: (runId: string) => void
}

/**
 * 2x2 quadrant showing every alive agent, placed by:
 *   x-axis: BUSY (status=running)   ↔  READY (idle/needs_attention/creating)
 *   y-axis: LLM (in burning set)    ↔  quiet (not)
 *
 * Cells:
 *   BUSY + LLM    → WORKING      (honest work)
 *   READY + LLM   → SUBAGENT     (parent idle, subagent burning)
 *   BUSY + quiet  → TOOL         (bash/file/build running, no LLM)
 *   READY + quiet → IDLE         (truly resting)
 *
 * Clicking an avatar calls onFocusRun to pan the canvas to that agent.
 */
export function AgentQuadrant({ runMap, burningRunIds, onFocusRun }: Props) {
  const alive = useMemo(() => {
    const out: Run[] = []
    for (const run of runMap.values()) {
      if (run.status !== 'stopped') out.push(run)
    }
    return out
  }, [runMap])

  const cells = useMemo(() => {
    const byCell: Record<CellKey, Run[]> = { working: [], subagent: [], tool: [], idle: [] }
    for (const run of alive) {
      const busy = run.status === 'running'
      const burning = burningRunIds.has(run.id)
      const key: CellKey =
        busy && burning ? 'working' :
        !busy && burning ? 'subagent' :
        busy && !burning ? 'tool' : 'idle'
      byCell[key].push(run)
    }
    return byCell
  }, [alive, burningRunIds])

  if (alive.length === 0) return null

  return (
    <div data-testid="agent-quadrant" className="mt-3">
      {/* Header row with axis labels */}
      <div className="grid grid-cols-[1fr_1fr] gap-[2px] text-[9px] font-semibold tracking-widest text-slate-400 mb-[2px]">
        <div className="text-center">BUSY</div>
        <div className="text-center">READY</div>
      </div>
      {/* Top row: LLM */}
      <div className="grid grid-cols-[1fr_1fr] gap-[2px]">
        <Cell label="WORKING" dataKey="working" runs={cells.working} onFocusRun={onFocusRun} axisLabel="LLM" />
        <Cell label="SUBAGENT" dataKey="subagent" runs={cells.subagent} onFocusRun={onFocusRun} />
      </div>
      {/* Bottom row: quiet */}
      <div className="grid grid-cols-[1fr_1fr] gap-[2px] mt-[2px]">
        <Cell label="TOOL" dataKey="tool" runs={cells.tool} onFocusRun={onFocusRun} axisLabel="quiet" />
        <Cell label="IDLE" dataKey="idle" runs={cells.idle} onFocusRun={onFocusRun} />
      </div>
    </div>
  )
}

interface CellProps {
  label: string
  dataKey: CellKey
  runs: Run[]
  onFocusRun: (runId: string) => void
  axisLabel?: string
}

function Cell({ label, dataKey, runs, onFocusRun, axisLabel }: CellProps) {
  return (
    <div
      data-testid={`quadrant-cell-${dataKey}`}
      style={{
        background: 'rgba(168,85,247,0.06)',
        border: '1px solid rgba(180,200,230,0.12)',
        borderRadius: 4,
        padding: 6,
        minHeight: 64,
        position: 'relative',
      }}
    >
      <div style={{
        fontSize: 8, letterSpacing: 1.5, opacity: 0.55,
        fontWeight: 700, color: '#cbd5e1', marginBottom: 4,
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>{label}</span>
        <span style={{ opacity: 0.6 }}>{runs.length > 0 ? runs.length : ''}</span>
      </div>
      {axisLabel && (
        <div style={{
          position: 'absolute', left: -26, top: '50%', transform: 'translateY(-50%) rotate(-90deg)',
          fontSize: 8, letterSpacing: 1.5, fontWeight: 700, color: '#94a3b8', opacity: 0.7,
          pointerEvents: 'none',
        }}>{axisLabel}</div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {runs.map(run => (
          <AgentAvatar
            key={run.id}
            run={run}
            onClick={() => onFocusRun(run.id)}
          />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run tests to verify PASS**

Run: `npx vitest run src/components/CanvasHud/__tests__/AgentQuadrant.test.tsx`
Expected: PASS — all seven tests green.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/CanvasHud/AgentQuadrant.tsx
git commit -m "feat(quadrant): 2x2 BUSY×LLM grid placing live agents (#telemetry-hud-avatars)"
```

---

## Task 16: Mount quadrant in `CanvasHud`, plumb `runMap` + `onFocusRun`

**Files:**
- Modify: `src/components/CanvasHud/CanvasHud.tsx`
- Modify: `src/components/InfiniteCanvas.tsx`

- [ ] **Step 1: Extend `CanvasHud` props**

Edit `src/components/CanvasHud/CanvasHud.tsx`. Replace the top imports and `Props` interface and the component signature:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { HudBar } from './HudBar'
import { AutonomyStat } from './AutonomyStat'
import { TelemetryBootstrap } from './TelemetryBootstrap'
import { AgentQuadrant } from './AgentQuadrant'
import { useTelemetryHud } from '../../hooks/useTelemetryHud'
import type { Run } from '../../domain/types'
import { fmtNum, fmtDollar, fmtRate } from './fmt'

const STORAGE_KEY = 'tinstar-hud-visible'

interface Props {
  toggleRef?: React.MutableRefObject<(() => void) | null>
  runMap: Map<string, Run>
  onFocusRun?: (runId: string) => void
}

export function CanvasHud({ toggleRef, runMap, onFocusRun }: Props) {
```

- [ ] **Step 2: Use `burningRunIds` from snapshot, render quadrant**

Still in `CanvasHud.tsx`, replace the final `return (...)` block (the "ready" state that renders HudBars) with one that also renders the quadrant:

```tsx
  const burningRunIds = new Set(snapshot.burningRunIds ?? [])

  return (
    <div style={wrapStyle} data-testid="canvas-hud">
      <HudBar icon="$" label="COST" value={costValue} fill={costFill} accent="gold" />
      {modelChips.length > 0 && (
        <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
          {modelChips.map(([model, cost]) => (
            <div key={model} style={{ flex: 1, padding: '4px 6px', fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace', borderRadius: 3,
                background: 'rgba(168,85,247,0.12)', borderLeft: '2px solid #a855f7' }}>
              <div style={{ fontSize: 8, opacity: 0.7, letterSpacing: 1 }}>{model.toUpperCase().slice(0, 10)}</div>
              <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{fmtDollar(cost)}</div>
            </div>
          ))}
        </div>
      )}
      <HudBar icon="⚡" label={tokensLabel} value={tokensValue} fill={tokensFill} accent="blue" />
      <HudBar icon="◎" label="CACHE HIT" value={cacheValue} fill={cacheFill} accent="green" />
      <AutonomyStat ratio={snapshot.autonomy.ratio} cliSeconds={snapshot.autonomy.cliSeconds} userSeconds={snapshot.autonomy.userSeconds} />
      {onFocusRun && (
        <AgentQuadrant runMap={runMap} burningRunIds={burningRunIds} onFocusRun={onFocusRun} />
      )}
    </div>
  )
```

- [ ] **Step 3: Plumb `runMap` + `onFocusRun` through `InfiniteCanvas`**

Edit `src/components/InfiniteCanvas.tsx`. Find line 1130:

```tsx
      {/* Telemetry HUD (top-right) */}
      <CanvasHud toggleRef={hudToggleRef} />
```

Replace with:

```tsx
      {/* Telemetry HUD (top-right) */}
      <CanvasHud toggleRef={hudToggleRef} runMap={runMap} onFocusRun={onFocusRun} />
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS. (AgentQuadrant tests don't go through CanvasHud; no new test needed here.)

- [ ] **Step 6: Manual smoke**

Run: `TINSTAR_FAST_SIM=1 npm run dev` (in one terminal).
Open the URL shown (typically `http://localhost:5280`).
Expected: telemetry HUD in top-right now shows a 2×2 quadrant below the existing bars. With FAST_SIM, fake-run-1/2/3 don't correspond to real runs (they won't map to tinstar runs), so the quadrant will be empty unless real sessions exist. Spawning a session should make an avatar appear.
Kill the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/components/CanvasHud/CanvasHud.tsx src/components/InfiniteCanvas.tsx
git commit -m "feat(hud): mount AgentQuadrant below existing bars (#telemetry-hud-avatars)"
```

---

## Task 17: Visible ✕ close button on HUD (on hover)

**Files:**
- Modify: `src/components/CanvasHud/CanvasHud.tsx`

- [ ] **Step 1: Add the close button + group class**

In `src/components/CanvasHud/CanvasHud.tsx`, change the outer `<div style={wrapStyle} data-testid="canvas-hud">` (appears twice — both in the `ready` branch and the bootstrap branch) to include the `group` class and a close button. The simplest refactor: extract a wrapper. Replace the two return sites with a common wrapper:

Find:

```tsx
  if (snapshot.state !== 'ready') {
    return (
      <div style={wrapStyle} data-testid="canvas-hud">
        <TelemetryBootstrap snap={snapshot} onRetry={handleRetry} />
      </div>
    )
  }
```

Replace with:

```tsx
  if (snapshot.state !== 'ready') {
    return (
      <HudShell wrapStyle={wrapStyle} onClose={toggle}>
        <TelemetryBootstrap snap={snapshot} onRetry={handleRetry} />
      </HudShell>
    )
  }
```

And find the final `return (<div style={wrapStyle} data-testid="canvas-hud">...</div>)` and wrap it the same way:

```tsx
  return (
    <HudShell wrapStyle={wrapStyle} onClose={toggle}>
      <HudBar icon="$" label="COST" value={costValue} fill={costFill} accent="gold" />
      {/* ... existing content unchanged ... */}
      {onFocusRun && (
        <AgentQuadrant runMap={runMap} burningRunIds={burningRunIds} onFocusRun={onFocusRun} />
      )}
    </HudShell>
  )
```

At the bottom of the file, add:

```tsx
function HudShell({
  wrapStyle, onClose, children,
}: { wrapStyle: React.CSSProperties; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={wrapStyle} data-testid="canvas-hud" className="group">
      <button
        onClick={onClose}
        className="absolute top-1 right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-slate-300"
        title="Hide telemetry (T)"
        data-testid="canvas-hud-close"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
      </button>
      {children}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/CanvasHud/CanvasHud.tsx
git commit -m "feat(hud): visible close button on hover (#telemetry-hud-avatars)"
```

---

## Task 18: Collapsed icon button when HUD is hidden

**Files:**
- Modify: `src/components/CanvasHud/CanvasHud.tsx`

- [ ] **Step 1: Replace the `if (!visible) return null` block**

In `src/components/CanvasHud/CanvasHud.tsx`, find:

```tsx
  if (!visible) return null
  if (!snapshot || snapshot.state === 'disabled') return null
```

Replace with:

```tsx
  if (!visible) {
    return (
      <button
        onClick={toggle}
        className="absolute top-3 right-3 bg-surface-panel border border-white/10 p-1.5 rounded-sm text-slate-500 hover:text-slate-300 transition-colors select-none z-30"
        title="Show telemetry (T)"
        data-testid="canvas-hud-toggle"
      >
        <span className="material-symbols-outlined text-base" style={{ fontSize: '16px' }}>insights</span>
      </button>
    )
  }
  if (!snapshot || snapshot.state === 'disabled') return null
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Manual verification**

Run: `TINSTAR_FAST_SIM=1 npm run dev`. Open the app.

- Press `T` → HUD should collapse to a small 📊 icon in the top-right.
- Click the icon → HUD reappears with ✕ visible on hover.
- Hover ✕, click → HUD collapses again.
- Refresh the page → the collapsed state should persist (localStorage key `tinstar-hud-visible`).

Kill dev server.

- [ ] **Step 4: Commit**

```bash
git add src/components/CanvasHud/CanvasHud.tsx
git commit -m "feat(hud): collapsed icon button matches minimap pattern (#telemetry-hud-avatars)"
```

---

## Task 19: E2E test — quadrant renders and avatars are clickable

**Files:**
- Create: `e2e/agent-quadrant.spec.ts`

- [ ] **Step 1: Inspect existing e2e conventions**

Run: `ls e2e/` and read the first test file to learn the helper pattern (how sessions are seeded, how the app is navigated, etc.).

- [ ] **Step 2: Write the test**

Create `e2e/agent-quadrant.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5280'

test('telemetry HUD shows close button and collapses', async ({ page }) => {
  await page.goto(BASE_URL)
  const hud = page.getByTestId('canvas-hud')
  await expect(hud).toBeVisible()

  // Hover to reveal close button
  await hud.hover()
  const closeBtn = page.getByTestId('canvas-hud-close')
  await expect(closeBtn).toBeVisible()
  await closeBtn.click()

  // Collapsed — the toggle button should now be visible
  await expect(page.getByTestId('canvas-hud-toggle')).toBeVisible()
  await expect(hud).toBeHidden()

  // T hotkey restores
  await page.keyboard.press('t')
  await expect(hud).toBeVisible()
})

test('quadrant is absent when no sessions exist', async ({ page }) => {
  await page.goto(BASE_URL)
  // In a fresh FAST_SIM workspace with no real sessions, the quadrant renders
  // nothing (alive count === 0). The HUD itself should still be present.
  await expect(page.getByTestId('canvas-hud')).toBeVisible()
  await expect(page.getByTestId('agent-quadrant')).toHaveCount(0)
})
```

- [ ] **Step 3: Run the e2e tests**

Run: `TINSTAR_FAST_SIM=1 npx playwright test e2e/agent-quadrant.spec.ts`
Expected: PASS (2 tests green).

If the tests fail because the dev server isn't auto-started by the Playwright config, look at `playwright.config.ts` for the `webServer` block and follow its pattern. Alternatively, start the dev server in another terminal (`TINSTAR_FAST_SIM=1 npm run dev`) and run the test against `BASE_URL=http://localhost:5280`.

- [ ] **Step 4: Commit**

```bash
git add e2e/agent-quadrant.spec.ts
git commit -m "test(e2e): quadrant + HUD toggle smoke tests (#telemetry-hud-avatars)"
```

---

## Task 20: Manual QA

- [ ] **Step 1: Start real server (not FAST_SIM)**

Run: `npm run dev`

- [ ] **Step 2: Checks**

Open the app. With real sessions running, verify:

1. **Quadrant visible below the existing COST / TOKENS / CACHE / autonomy bars** in the top-right.
2. **Every alive session shows an avatar.** Templated sessions keep their template emoji (e.g. ota-testing-tester's existing icon). Untemplated sessions show a distinct DiceBear robot face seeded by run.id — no two alike.
3. **Avatar ring color matches the session's accent color.**
4. **Status placement:** a session you know is running bash (`running` + no API) lands in TOOL. A session actively prompting Claude lands in WORKING. An idle session lands in IDLE.
5. **Click an avatar:** canvas pans to that agent's widget.
6. **Hover the HUD:** ✕ close button appears top-right. Click → HUD collapses to the 📊 icon.
7. **Press T:** HUD toggles.
8. **Refresh page:** HUD visibility persists.
9. **Reload with an untemplated session alive:** its avatar is the same face as before. Deterministic per run.id.

- [ ] **Step 3: If anything from step 2 fails, file it as a follow-up task** — not part of this plan unless it's a regression of existing behavior.

---

## Self-Review Checklist

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Two honest axes (BUSY × LLM) | Task 15 (quadrant cell logic) |
| Quadrant with 4 cells | Tasks 14, 15 |
| One avatar per alive session, colored ring | Tasks 13, 15 |
| DiceBear bottts-neutral, client-side, memoized | Tasks 8, 9, 10 |
| Lazy import, colored-circle placeholder | Tasks 10, 12 |
| Fallback hierarchy (template > DiceBear > legacy) | Task 12 |
| Click to focus on canvas | Tasks 13, 14 (test), 16 (wiring) |
| Visible ✕ close button | Task 17 |
| Collapsed icon button | Task 18 |
| Existing bars kept, nothing removed | Task 16 (step 2 preserves all bars) |
| `burningSessions` Prometheus query | Tasks 2, 3 |
| Reverse UUID → run ID lookup | Tasks 4, 5, 6 |
| FAST_SIM stub | Task 7 |
| Unit + E2E tests | Tasks 2, 4, 9, 11, 14, 19 |

**No placeholders:** each step contains either complete code, an exact command, or specific navigation instructions. No "TBD" / "TODO" / "add appropriate X" language.

**Type consistency checked:**
- `burningRunIds: string[]` (type) ↔ `new Set(snapshot.burningRunIds ?? [])` (consumer) ↔ `burningRunIds: Set<string>` (`<AgentQuadrant>` prop) — three layers, types consistent.
- `getRunIdsForConversationIds: (conversationIds: string[]) => string[]` matches call site in Task 5.
- `AgentIcon` new optional props `seed?: string | null`, `color?: string | null` — all call sites in Tasks 13 and 15 pass `run.id` (string) and `run.color`/accent (string), matching the optional type.
- `getAvatarDataUrl(seed: string, color: string): string | null` matches consumer in Task 12.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-22-telemetry-hud-agent-quadrant.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

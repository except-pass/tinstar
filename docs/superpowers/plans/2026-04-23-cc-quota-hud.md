# Claude Code Quota HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Code quota card to the Tinstar HUD (between AUTONOMY and AGENT QUADRANT) that shows 5-hour and 7-day quota with a race-metaphor clock + bar, plus an extra-usage gas-pump chip; emit the same data as OTel gauges through the existing `OtlpExporter` → Alloy → Prometheus pipeline.

**Architecture:** A server-side module (`src/server/cc-quota/`) fetches `https://api.anthropic.com/api/oauth/usage` using the OAuth token from `~/.claude/.credentials.json`, emits metrics via the project-wide `OtlpExporter`, and exposes `GET /api/cc-quota` with a 5-second cooldown. A React hook `useCcQuota` polls every 5 minutes (tab-visibility aware), and a `CcQuotaCard` component renders the clock + bar using SVG. No new runtime dependencies.

**Tech Stack:** Node/TypeScript backend (Vite plugin server), React + SVG frontend, Vitest + @testing-library/react for unit tests, Playwright for e2e.

**Spec:** [docs/superpowers/specs/2026-04-23-cc-quota-hud-design.md](../specs/2026-04-23-cc-quota-hud-design.md)

**Commit tag:** Every commit in this plan ends with `(#cc-quota-hud)` so Task Activity tracks them together.

---

## Task 1: Types, fetcher, and fetcher tests

**Files:**
- Create: `src/server/cc-quota/types.ts`
- Create: `src/server/cc-quota/fetcher.ts`
- Create: `src/server/cc-quota/__tests__/fetcher.test.ts`

- [ ] **Step 1: Create the types module**

```ts
// src/server/cc-quota/types.ts
export interface UsageBucket {
  utilization: number
  resets_at: string
}

export interface ExtraUsage {
  is_enabled: boolean
  used_credits: number | null
  currency: string
}

export interface RawUsage {
  five_hour: UsageBucket | null
  seven_day: UsageBucket | null
  seven_day_opus: UsageBucket | null
  seven_day_sonnet: UsageBucket | null
  extra_usage: ExtraUsage | null
}

export type FetchErrorCode =
  | 'no_creds'
  | 'expired_token'
  | 'http_4xx'
  | 'http_5xx'
  | 'network'

export interface FetchError {
  code: FetchErrorCode
  message: string
}

export class CcQuotaFetchError extends Error {
  constructor(public readonly info: FetchError) {
    super(info.message)
    this.name = 'CcQuotaFetchError'
  }
}

export interface CcQuotaSnapshot {
  fetchedAt: string          // ISO timestamp of the last completed attempt (success or failure)
  data: RawUsage | null      // last good data; null only if no fetch has ever succeeded
  error: FetchError | null   // set when the most recent fetch failed
}
```

- [ ] **Step 2: Write the failing fetcher tests**

```ts
// src/server/cc-quota/__tests__/fetcher.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchCcQuota } from '../fetcher'
import { CcQuotaFetchError } from '../types'

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'ccq-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  return home
}

function writeCreds(home: string, token: string) {
  writeFileSync(
    join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token } })
  )
}

describe('fetchCcQuota', () => {
  let home: string
  let origHome: string | undefined

  beforeEach(() => {
    home = makeFakeHome()
    origHome = process.env.HOME
    process.env.HOME = home
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env.HOME = origHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns parsed RawUsage on 200', async () => {
    writeCreds(home, 'tok-abc')
    const body = {
      five_hour: { utilization: 67, resets_at: '2026-04-23T15:49:59Z' },
      seven_day: { utilization: 89, resets_at: '2026-04-23T20:00:00Z' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 2, resets_at: '2026-04-23T21:00:00Z' },
      extra_usage: { is_enabled: true, used_credits: 8148, currency: 'USD' },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
    const out = await fetchCcQuota()
    expect(out.five_hour?.utilization).toBe(67)
    expect(out.seven_day_opus).toBeNull()
  })

  it('throws no_creds when credentials file is missing', async () => {
    await expect(fetchCcQuota()).rejects.toBeInstanceOf(CcQuotaFetchError)
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'no_creds' } })
  })

  it('throws no_creds when accessToken field is absent', async () => {
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({}))
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'no_creds' } })
  })

  it('throws expired_token on 401', async () => {
    writeCreds(home, 'stale')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'expired_token' } })
  })

  it('throws http_5xx on 503', async () => {
    writeCreds(home, 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'http_5xx' } })
  })

  it('throws network on fetch rejection', async () => {
    writeCreds(home, 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'network' } })
  })
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run src/server/cc-quota/__tests__/fetcher.test.ts`

Expected: all fail with `Cannot find module '../fetcher'` or similar.

- [ ] **Step 4: Implement the fetcher**

```ts
// src/server/cc-quota/fetcher.ts
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CcQuotaFetchError, type FetchErrorCode, type RawUsage } from './types'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

function throwAs(code: FetchErrorCode, message: string): never {
  throw new CcQuotaFetchError({ code, message })
}

function readAccessToken(): string {
  const path = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(path)) throwAs('no_creds', `no credentials at ${path}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throwAs('no_creds', `credentials not JSON: ${(err as Error).message}`)
  }
  const tok = (parsed as { claudeAiOauth?: { accessToken?: unknown } } | null)?.claudeAiOauth?.accessToken
  if (typeof tok !== 'string' || tok.length === 0) {
    throwAs('no_creds', 'claudeAiOauth.accessToken missing')
  }
  return tok
}

export async function fetchCcQuota(): Promise<RawUsage> {
  const token = readAccessToken()

  let res: Response
  try {
    res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}` } })
  } catch (err) {
    throwAs('network', (err as Error).message)
  }

  if (res.status === 401) throwAs('expired_token', 'oauth token expired')
  if (res.status >= 500) throwAs('http_5xx', `upstream ${res.status}`)
  if (!res.ok) throwAs('http_4xx', `upstream ${res.status}`)

  try {
    return (await res.json()) as RawUsage
  } catch (err) {
    throwAs('http_4xx', `malformed JSON: ${(err as Error).message}`)
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/server/cc-quota/__tests__/fetcher.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/cc-quota/types.ts src/server/cc-quota/fetcher.ts src/server/cc-quota/__tests__/fetcher.test.ts
git commit -m "cc-quota: fetcher + types (#cc-quota-hud)"
```

---

## Task 2: Metrics emission module

**Files:**
- Create: `src/server/cc-quota/metrics.ts`
- Create: `src/server/cc-quota/__tests__/metrics.test.ts`

Tinstar has an existing `OtlpExporter` (`src/server/stores/otlp-exporter.ts`) whose `pushMetric(m: Metric)` accepts `{ name, type, value, labels, timestamp }`. This module translates `RawUsage` into the metric names listed in the spec §5.3.

- [ ] **Step 1: Write the failing metrics tests**

```ts
// src/server/cc-quota/__tests__/metrics.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { emitCcQuotaMetrics, emitFetchCounter } from '../metrics'
import type { Metric } from '../../types'
import type { RawUsage } from '../types'

class StubExporter {
  pushed: Metric[] = []
  pushMetric(m: Metric) { this.pushed.push(m) }
}

const now = '2026-04-23T08:36:00.000Z'
const fixedNow = Date.parse(now)

function makeSample(overrides: Partial<RawUsage> = {}): RawUsage {
  return {
    five_hour:        { utilization: 67, resets_at: '2026-04-23T11:49:00.000Z' },
    seven_day:        { utilization: 89, resets_at: '2026-04-23T20:00:00.000Z' },
    seven_day_opus:   null,
    seven_day_sonnet: { utilization: 2, resets_at: '2026-04-23T21:00:00.000Z' },
    extra_usage:      { is_enabled: true, used_credits: 8148, currency: 'USD' },
    ...overrides,
  }
}

describe('emitCcQuotaMetrics', () => {
  let exp: StubExporter
  beforeEach(() => { exp = new StubExporter() })

  it('emits used_ratio and resets_at_seconds for each non-null bucket', () => {
    emitCcQuotaMetrics(exp, makeSample(), fixedNow)
    const names = exp.pushed.map(m => `${m.name}:${m.labels.window ?? ''}`)
    expect(names).toEqual(expect.arrayContaining([
      'cc_quota_used_ratio:5h',
      'cc_quota_used_ratio:7d',
      'cc_quota_used_ratio:7d_sonnet',
      'cc_quota_resets_at_seconds:5h',
      'cc_quota_resets_at_seconds:7d',
      'cc_quota_resets_at_seconds:7d_sonnet',
    ]))
    expect(names).not.toContain('cc_quota_used_ratio:7d_opus')
  })

  it('emits time_in_cycle and deficit for 5h and 7d only', () => {
    emitCcQuotaMetrics(exp, makeSample(), fixedNow)
    const fiveHourTime = exp.pushed.find(m => m.name === 'cc_quota_time_in_cycle_ratio' && m.labels.window === '5h')!
    // now = 08:36; reset = 11:49 → 3h13m away / 5h = ~0.643; time_in_cycle = 1 - 0.643 = ~0.357
    expect(fiveHourTime.value).toBeCloseTo(0.357, 2)
    const fiveHourDeficit = exp.pushed.find(m => m.name === 'cc_quota_deficit_ratio' && m.labels.window === '5h')!
    // used 67% = 0.67; deficit = 0.67 - 0.357 = ~0.313
    expect(fiveHourDeficit.value).toBeCloseTo(0.313, 2)
  })

  it('emits extra_usage gauges when present', () => {
    emitCcQuotaMetrics(exp, makeSample(), fixedNow)
    const enabled = exp.pushed.find(m => m.name === 'cc_extra_usage_enabled')!
    expect(enabled.value).toBe(1)
    const credits = exp.pushed.find(m => m.name === 'cc_extra_usage_credits_usd')!
    expect(credits.value).toBe(8148)
  })

  it('omits cc_extra_usage_credits_usd when used_credits is null', () => {
    emitCcQuotaMetrics(exp, makeSample({ extra_usage: { is_enabled: false, used_credits: null, currency: 'USD' } }), fixedNow)
    expect(exp.pushed.find(m => m.name === 'cc_extra_usage_credits_usd')).toBeUndefined()
    expect(exp.pushed.find(m => m.name === 'cc_extra_usage_enabled')!.value).toBe(0)
  })

  it('omits extra_usage gauges entirely when extra_usage is null', () => {
    emitCcQuotaMetrics(exp, makeSample({ extra_usage: null }), fixedNow)
    expect(exp.pushed.find(m => m.name.startsWith('cc_extra_usage_'))).toBeUndefined()
  })
})

describe('emitFetchCounter', () => {
  it('pushes result=ok', () => {
    const exp = new StubExporter()
    emitFetchCounter(exp, 'ok', fixedNow)
    expect(exp.pushed).toHaveLength(1)
    expect(exp.pushed[0]).toMatchObject({ name: 'cc_quota_fetch_total', type: 'counter', value: 1, labels: { result: 'ok' } })
  })
  it('pushes result=error', () => {
    const exp = new StubExporter()
    emitFetchCounter(exp, 'error', fixedNow)
    expect(exp.pushed[0].labels.result).toBe('error')
  })
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npx vitest run src/server/cc-quota/__tests__/metrics.test.ts`

Expected: fails with `Cannot find module '../metrics'`.

- [ ] **Step 3: Implement the metrics module**

```ts
// src/server/cc-quota/metrics.ts
import type { Metric } from '../types'
import type { RawUsage, UsageBucket } from './types'

export interface MetricSink {
  pushMetric(m: Metric): void
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

const CYCLE_MS: Record<'5h' | '7d', number> = {
  '5h': FIVE_HOUR_MS,
  '7d': SEVEN_DAY_MS,
}

type BucketKey = '5h' | '7d' | '7d_opus' | '7d_sonnet'

const BUCKET_WINDOW_KEYS: Array<[keyof RawUsage, BucketKey]> = [
  ['five_hour',        '5h'],
  ['seven_day',        '7d'],
  ['seven_day_opus',   '7d_opus'],
  ['seven_day_sonnet', '7d_sonnet'],
]

function timeInCycleRatio(bucket: UsageBucket, nowMs: number, cycleMs: number): number {
  const resetMs = Date.parse(bucket.resets_at)
  const remainingMs = resetMs - nowMs
  const ratio = 1 - remainingMs / cycleMs
  // clamp to [0, 1] — resets slightly in the past can produce >1 briefly
  return Math.max(0, Math.min(1, ratio))
}

export function emitCcQuotaMetrics(sink: MetricSink, data: RawUsage, nowMs: number = Date.now()): void {
  const ts = new Date(nowMs).toISOString()

  for (const [field, window] of BUCKET_WINDOW_KEYS) {
    const bucket = data[field] as UsageBucket | null
    if (!bucket) continue

    const usedRatio = bucket.utilization / 100
    sink.pushMetric({ name: 'cc_quota_used_ratio', type: 'gauge', value: usedRatio, labels: { window }, timestamp: ts })
    sink.pushMetric({ name: 'cc_quota_resets_at_seconds', type: 'gauge', value: Date.parse(bucket.resets_at) / 1000, labels: { window }, timestamp: ts })

    // time_in_cycle + deficit only defined for the two top-level windows
    if (window === '5h' || window === '7d') {
      const tic = timeInCycleRatio(bucket, nowMs, CYCLE_MS[window])
      sink.pushMetric({ name: 'cc_quota_time_in_cycle_ratio', type: 'gauge', value: tic, labels: { window }, timestamp: ts })
      sink.pushMetric({ name: 'cc_quota_deficit_ratio', type: 'gauge', value: usedRatio - tic, labels: { window }, timestamp: ts })
    }
  }

  if (data.extra_usage) {
    sink.pushMetric({
      name: 'cc_extra_usage_enabled',
      type: 'gauge',
      value: data.extra_usage.is_enabled ? 1 : 0,
      labels: {},
      timestamp: ts,
    })
    if (data.extra_usage.used_credits != null) {
      sink.pushMetric({
        name: 'cc_extra_usage_credits_usd',
        type: 'gauge',
        value: data.extra_usage.used_credits,
        labels: {},
        timestamp: ts,
      })
    }
  }
}

export function emitFetchCounter(sink: MetricSink, result: 'ok' | 'error', nowMs: number = Date.now()): void {
  sink.pushMetric({
    name: 'cc_quota_fetch_total',
    type: 'counter',
    value: 1,
    labels: { result },
    timestamp: new Date(nowMs).toISOString(),
  })
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `npx vitest run src/server/cc-quota/__tests__/metrics.test.ts`

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/cc-quota/metrics.ts src/server/cc-quota/__tests__/metrics.test.ts
git commit -m "cc-quota: metrics emission module (#cc-quota-hud)"
```

---

## Task 3: Service with cooldown, cache, and FAST_SIM fixture

**Files:**
- Create: `src/server/cc-quota/service.ts`
- Create: `src/server/cc-quota/fast-sim.ts`
- Create: `src/server/cc-quota/__tests__/service.test.ts`

- [ ] **Step 1: Write the failing service tests**

```ts
// src/server/cc-quota/__tests__/service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CcQuotaService } from '../service'
import type { MetricSink } from '../metrics'
import type { Metric } from '../../types'
import type { RawUsage } from '../types'
import { CcQuotaFetchError } from '../types'

const sample: RawUsage = {
  five_hour: { utilization: 40, resets_at: '2026-04-23T13:00:00.000Z' },
  seven_day: null, seven_day_opus: null, seven_day_sonnet: null,
  extra_usage: null,
}

class StubSink implements MetricSink {
  pushed: Metric[] = []
  pushMetric(m: Metric) { this.pushed.push(m) }
}

describe('CcQuotaService', () => {
  let sink: StubSink
  let fetcher: ReturnType<typeof vi.fn>
  let now: number

  beforeEach(() => {
    sink = new StubSink()
    fetcher = vi.fn<[], Promise<RawUsage>>()
    now = Date.parse('2026-04-23T10:00:00.000Z')
  })

  it('fetches, caches, and emits metrics on success', async () => {
    fetcher.mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })

    const snap = await svc.getSnapshot()
    expect(snap.data).toEqual(sample)
    expect(snap.error).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(sink.pushed.find(m => m.name === 'cc_quota_used_ratio')).toBeTruthy()
    expect(sink.pushed.find(m => m.name === 'cc_quota_fetch_total' && m.labels.result === 'ok')).toBeTruthy()
  })

  it('returns cached snapshot within the 5s cooldown when not forced', async () => {
    fetcher.mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    await svc.getSnapshot()

    now += 2000 // 2s later
    const snap = await svc.getSnapshot()
    expect(snap.data).toEqual(sample)
    expect(fetcher).toHaveBeenCalledTimes(1) // no new fetch
  })

  it('re-fetches when cooldown expires', async () => {
    fetcher.mockResolvedValueOnce(sample).mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    await svc.getSnapshot()

    now += 6000 // past cooldown
    await svc.getSnapshot()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('force=true still respects cooldown (prevents thrash)', async () => {
    fetcher.mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    await svc.getSnapshot()

    now += 1000
    await svc.getSnapshot({ force: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('preserves last good data on error and sets error code', async () => {
    fetcher.mockResolvedValueOnce(sample)
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    await svc.getSnapshot()

    now += 10000
    fetcher.mockRejectedValueOnce(new CcQuotaFetchError({ code: 'expired_token', message: 'stale' }))
    const snap = await svc.getSnapshot()
    expect(snap.data).toEqual(sample)
    expect(snap.error?.code).toBe('expired_token')
    expect(sink.pushed.filter(m => m.name === 'cc_quota_fetch_total' && m.labels.result === 'error')).toHaveLength(1)
  })

  it('returns error snapshot with null data when the very first fetch fails', async () => {
    fetcher.mockRejectedValueOnce(new CcQuotaFetchError({ code: 'no_creds', message: 'missing' }))
    const svc = new CcQuotaService({ fetcher, sink, now: () => now })
    const snap = await svc.getSnapshot()
    expect(snap.data).toBeNull()
    expect(snap.error?.code).toBe('no_creds')
  })
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npx vitest run src/server/cc-quota/__tests__/service.test.ts`

Expected: fails with `Cannot find module '../service'`.

- [ ] **Step 3: Implement the fast-sim fixture**

```ts
// src/server/cc-quota/fast-sim.ts
import type { RawUsage } from './types'

export function makeFakeCcQuota(nowMs: number = Date.now()): RawUsage {
  const resetFiveHour = new Date(nowMs + 3 * 60 * 60 * 1000 + 12 * 60 * 1000).toISOString() // +3h12m
  const resetWeek     = new Date(nowMs + 7 * 60 * 60 * 1000 + 23 * 60 * 1000).toISOString() // +7h23m
  const resetSonnet   = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString()

  return {
    five_hour:        { utilization: 67, resets_at: resetFiveHour },
    seven_day:        { utilization: 89, resets_at: resetWeek },
    seven_day_opus:   null,
    seven_day_sonnet: { utilization: 2,  resets_at: resetSonnet },
    extra_usage:      { is_enabled: true, used_credits: 8148, currency: 'USD' },
  }
}
```

- [ ] **Step 4: Implement the service**

```ts
// src/server/cc-quota/service.ts
import { fetchCcQuota } from './fetcher'
import { emitCcQuotaMetrics, emitFetchCounter, type MetricSink } from './metrics'
import { makeFakeCcQuota } from './fast-sim'
import { CcQuotaFetchError, type CcQuotaSnapshot, type RawUsage } from './types'

const COOLDOWN_MS = 5_000

export interface CcQuotaServiceOptions {
  /** Injected so tests can stub network. Defaults to the real endpoint fetcher. */
  fetcher?: () => Promise<RawUsage>
  /** Injected so tests can stub OtlpExporter. */
  sink?: MetricSink
  /** Injected clock for tests. */
  now?: () => number
}

const NOOP_SINK: MetricSink = { pushMetric: () => {} }

export class CcQuotaService {
  private readonly fetcher: () => Promise<RawUsage>
  private readonly sink: MetricSink
  private readonly now: () => number

  private lastAttemptMs = 0
  private cached: CcQuotaSnapshot = { fetchedAt: new Date(0).toISOString(), data: null, error: null }

  constructor(opts: CcQuotaServiceOptions = {}) {
    this.fetcher = opts.fetcher ?? (process.env.TINSTAR_FAST_SIM === '1'
      ? async () => makeFakeCcQuota(Date.now())
      : fetchCcQuota)
    this.sink = opts.sink ?? NOOP_SINK
    this.now = opts.now ?? Date.now
  }

  async getSnapshot(opts: { force?: boolean } = {}): Promise<CcQuotaSnapshot> {
    const nowMs = this.now()
    const sinceAttempt = nowMs - this.lastAttemptMs
    const mustWait = sinceAttempt < COOLDOWN_MS
    if (mustWait && !opts.force) return this.cached
    if (mustWait && opts.force) return this.cached // cooldown overrides force to prevent thrash

    this.lastAttemptMs = nowMs
    try {
      const data = await this.fetcher()
      emitCcQuotaMetrics(this.sink, data, nowMs)
      emitFetchCounter(this.sink, 'ok', nowMs)
      this.cached = { fetchedAt: new Date(nowMs).toISOString(), data, error: null }
    } catch (err) {
      emitFetchCounter(this.sink, 'error', nowMs)
      const error = err instanceof CcQuotaFetchError
        ? err.info
        : { code: 'network' as const, message: (err as Error).message }
      this.cached = { fetchedAt: new Date(nowMs).toISOString(), data: this.cached.data, error }
    }
    return this.cached
  }
}
```

- [ ] **Step 5: Run tests and confirm they pass**

Run: `npx vitest run src/server/cc-quota/__tests__/service.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/cc-quota/service.ts src/server/cc-quota/fast-sim.ts src/server/cc-quota/__tests__/service.test.ts
git commit -m "cc-quota: service with cooldown + fast-sim fixture (#cc-quota-hud)"
```

---

## Task 4: HTTP route + server wiring

**Files:**
- Modify: `src/server/api/routes.ts` (add `ccQuotaService` to `RouteContext`; add route handler)
- Modify: `src/server/index.ts` (instantiate service with the existing `OtlpExporter` instance and pass to context)
- Modify: `src/server/processors/otel-processor.ts` (expose its exporter so the service can reuse it)
- Create: `src/server/cc-quota/__tests__/route.test.ts`

Tinstar already has `OtlpExporter` inside `OTelProcessor`. The simplest wiring: move the exporter up one level — instantiate in `initBackend()` and inject into both `OTelProcessor` and `CcQuotaService`. That keeps to one flush loop.

- [ ] **Step 1: Expose exporter injection on OTelProcessor**

Open `src/server/processors/otel-processor.ts`. Replace the constructor and field:

```ts
// src/server/processors/otel-processor.ts (changes only)
export class OTelProcessor {
  private runSpanMap = new Map<string, { spanId: string; traceId: string }>()

  constructor(
    private bus: EventBus,
    private store: OTelStore,
    private exporter: OtlpExporter,   // ← injected, no longer instantiated inside
  ) {
    this.bind()
  }
  // (remove the `this.exporter.start()` line from the old constructor body — the caller owns lifecycle now)
```

- [ ] **Step 2: Write the failing route test**

```ts
// src/server/cc-quota/__tests__/route.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handleRequest, type RouteContext } from '../../api/routes'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CcQuotaService } from '../service'
import type { RawUsage } from '../types'

function makeReq(url: string): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage
}

interface CapturedRes {
  status: number
  body: string
  res: ServerResponse
}

function makeRes(): CapturedRes {
  const captured: CapturedRes = { status: 0, body: '', res: null as unknown as ServerResponse }
  const res = {
    headersSent: false, writableEnded: false,
    writeHead(status: number) { captured.status = status; return this },
    end(chunk?: string) { captured.body += chunk ?? ''; this.writableEnded = true; return this },
    on() { return this },
  } as unknown as ServerResponse
  captured.res = res
  return captured
}

function makeCtx(svc: CcQuotaService): RouteContext {
  return { ccQuotaService: svc } as unknown as RouteContext
}

describe('GET /api/cc-quota', () => {
  const sample: RawUsage = {
    five_hour: { utilization: 40, resets_at: '2026-04-23T13:00:00.000Z' },
    seven_day: null, seven_day_opus: null, seven_day_sonnet: null, extra_usage: null,
  }

  it('returns 200 with snapshot body', async () => {
    const svc = new CcQuotaService({ fetcher: async () => sample, now: () => 1000 })
    const ctx = makeCtx(svc)
    const r = makeRes()
    const handled = await handleRequest(ctx, makeReq('/api/cc-quota'), r.res)
    expect(handled).toBe(true)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({ data: sample, error: null })
  })

  it('honors ?force=1 after cooldown by re-fetching', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => { calls++; return sample })
    let now = 1000
    const svc = new CcQuotaService({ fetcher, now: () => now })
    const ctx = makeCtx(svc)

    await handleRequest(ctx, makeReq('/api/cc-quota'), makeRes().res)
    now += 6_000
    await handleRequest(ctx, makeReq('/api/cc-quota?force=1'), makeRes().res)
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 3: Run the test to confirm failure**

Run: `npx vitest run src/server/cc-quota/__tests__/route.test.ts`

Expected: fails with something like `Property 'ccQuotaService' does not exist on type 'RouteContext'` (compile-time) or handler returns false at runtime.

- [ ] **Step 4: Extend `RouteContext` and add the route**

In `src/server/api/routes.ts`, add to the `RouteContext` interface (inside the existing list, alongside `telemetryRoutes`):

```ts
// src/server/api/routes.ts — inside RouteContext interface, add field:
  ccQuotaService?: import('../cc-quota/service').CcQuotaService
```

And add a new route block. Place it near the other `/api/*` handlers — directly after the `// GET /api/otel/metrics` block is a natural spot:

```ts
// src/server/api/routes.ts — new block, placed after the /api/otel/metrics handler
  // GET /api/cc-quota[?force=1]
  if (method === 'GET' && ctx.ccQuotaService && url.startsWith('/api/cc-quota')) {
    const parsed = new URL(url, 'http://localhost')
    const force = parsed.searchParams.get('force') === '1'
    const snap = await ctx.ccQuotaService.getSnapshot({ force })
    json(res, snap)
    return true
  }
```

- [ ] **Step 5: Wire in `src/server/index.ts`**

Find the `initBackend()` function where `OTelProcessor` is constructed. Add an `OtlpExporter` and `CcQuotaService` to the build:

```ts
// src/server/index.ts — top of imports
import { OtlpExporter } from './stores/otlp-exporter'
import { CcQuotaService } from './cc-quota/service'
```

Inside `initBackend()`, just before `OTelProcessor` is instantiated, add:

```ts
// src/server/index.ts — inside initBackend(), above OTelProcessor construction
  const otlpExporter = new OtlpExporter()
  otlpExporter.start()
  const ccQuotaService = new CcQuotaService({ sink: otlpExporter })
```

Update the `OTelProcessor` constructor call to inject the shared exporter:

```ts
  new OTelProcessor(bus, otelStore, otlpExporter)
```

Add `ccQuotaService` to the returned context object (next to `telemetryRoutes`):

```ts
  return {
    docStore, otelStore, sse, bus, startSimulator, resetSimulator,
    sessionConfig, readyQueue, telemetryRoutes, ccQuotaService,
    get natsTraffic() { return natsTraffic },
    get readinessTracker() { return readinessTracker },
  }
```

- [ ] **Step 6: Run the route test and the existing suite**

```bash
npx vitest run src/server/cc-quota/__tests__/route.test.ts
npx tsc --noEmit
```

Expected: route test passes; `tsc` reports no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/processors/otel-processor.ts src/server/api/routes.ts src/server/index.ts src/server/cc-quota/__tests__/route.test.ts
git commit -m "cc-quota: /api/cc-quota route + shared OtlpExporter (#cc-quota-hud)"
```

---

## Task 5: Client hook `useCcQuota`

**Files:**
- Create: `src/hooks/useCcQuota.ts`
- Create: `src/hooks/__tests__/useCcQuota.test.tsx`

- [ ] **Step 1: Write the failing hook tests**

```tsx
// src/hooks/__tests__/useCcQuota.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { useCcQuota, __resetCcQuotaSingletonForTests } from '../useCcQuota'

function Probe({ onSnap }: { onSnap: (x: unknown) => void }) {
  const { snapshot, lastRefreshedAt, refresh } = useCcQuota()
  onSnap({ snapshot, lastRefreshedAt, refresh })
  return null
}

describe('useCcQuota', () => {
  beforeEach(() => {
    __resetCcQuotaSingletonForTests()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fetches once on mount and exposes snapshot', async () => {
    const body = { fetchedAt: '2026-04-23T10:00:00Z', data: { five_hour: null, seven_day: null, seven_day_opus: null, seven_day_sonnet: null, extra_usage: null }, error: null }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))

    const states: unknown[] = []
    render(<Probe onSnap={(s) => states.push(s)} />)

    await waitFor(() => expect((states.at(-1) as { snapshot: unknown }).snapshot).not.toBeNull())
    const last = states.at(-1) as { snapshot: typeof body, lastRefreshedAt: string | null }
    expect(last.snapshot).toEqual(body)
    expect(last.lastRefreshedAt).toBe('2026-04-23T10:00:00Z')
  })

  it('re-polls every 5 minutes', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ fetchedAt: '2026', data: null, error: null }), { status: 200 })
    }))

    render(<Probe onSnap={() => {}} />)
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1))
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000) })
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2))
  })

  it('refresh() hits /api/cc-quota?force=1', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ fetchedAt: '2026', data: null, error: null }), { status: 200 })
    }))

    let refresh: (() => void) | null = null
    render(<Probe onSnap={(s) => { refresh = (s as { refresh: () => void }).refresh }} />)
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1))
    act(() => { refresh!() })
    await waitFor(() => expect(calls.some(u => u.includes('force=1'))).toBe(true))
  })
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npx vitest run src/hooks/__tests__/useCcQuota.test.tsx`

Expected: `Cannot find module '../useCcQuota'`.

- [ ] **Step 3: Implement the hook**

```ts
// src/hooks/useCcQuota.ts
import { useEffect, useSyncExternalStore } from 'react'

// -------- types mirrored from the server (keep in sync with src/server/cc-quota/types.ts) --------
export interface UsageBucket { utilization: number; resets_at: string }
export interface ExtraUsage   { is_enabled: boolean; used_credits: number | null; currency: string }
export interface RawUsage {
  five_hour: UsageBucket | null
  seven_day: UsageBucket | null
  seven_day_opus: UsageBucket | null
  seven_day_sonnet: UsageBucket | null
  extra_usage: ExtraUsage | null
}
export interface CcQuotaSnapshot {
  fetchedAt: string
  data: RawUsage | null
  error: { code: string; message: string } | null
}

export interface UseCcQuota {
  snapshot: CcQuotaSnapshot | null
  lastRefreshedAt: string | null
  refreshing: boolean
  refresh: () => void
}

const POLL_MS = 5 * 60 * 1000

// -------- module-scoped singleton so the whole app shares one timer/fetch --------
interface SingletonState {
  snapshot: CcQuotaSnapshot | null
  refreshing: boolean
}
let state: SingletonState = { snapshot: null, refreshing: false }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inflight = false
let mountCount = 0

function emit() { for (const l of listeners) l() }
function setState(patch: Partial<SingletonState>) { state = { ...state, ...patch }; emit() }

async function doFetch(force: boolean) {
  if (inflight) return
  inflight = true
  setState({ refreshing: true })
  try {
    const res = await fetch(force ? '/api/cc-quota?force=1' : '/api/cc-quota')
    if (res.ok) {
      const body = (await res.json()) as CcQuotaSnapshot
      setState({ snapshot: body })
    }
  } catch {
    // network down; keep previous snapshot
  } finally {
    inflight = false
    setState({ refreshing: false })
  }
}

function ensurePolling() {
  if (timer) return
  void doFetch(false)
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void doFetch(false)
  }, POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
}

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', onVisibility)
}

function onVisibility() {
  if (document.visibilityState === 'visible') void doFetch(false)
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  mountCount += 1
  if (mountCount === 1) ensurePolling()
  return () => {
    listeners.delete(l)
    mountCount -= 1
    if (mountCount === 0) stopPolling()
  }
}

const getSnapshot = () => state
const getServerSnapshot = () => ({ snapshot: null, refreshing: false }) as SingletonState

export function useCcQuota(): UseCcQuota {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  useEffect(() => { /* no-op: subscription handles lifecycle */ }, [])
  return {
    snapshot: s.snapshot,
    lastRefreshedAt: s.snapshot?.fetchedAt ?? null,
    refreshing: s.refreshing,
    refresh: () => void doFetch(true),
  }
}

// Only used by tests. Keeps the module pure.
export function __resetCcQuotaSingletonForTests(): void {
  stopPolling()
  state = { snapshot: null, refreshing: false }
  listeners.clear()
  inflight = false
  mountCount = 0
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `npx vitest run src/hooks/__tests__/useCcQuota.test.tsx`

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCcQuota.ts src/hooks/__tests__/useCcQuota.test.tsx
git commit -m "cc-quota: useCcQuota hook with 5min poll + singleton (#cc-quota-hud)"
```

---

## Task 6: Clock subcomponent

**Files:**
- Create: `src/components/CanvasHud/CcQuotaClock.tsx`
- Create: `src/components/CanvasHud/__tests__/CcQuotaClock.test.tsx`

- [ ] **Step 1: Write the failing clock tests**

```tsx
// src/components/CanvasHud/__tests__/CcQuotaClock.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CcQuotaClock } from '../CcQuotaClock'

const now = Date.parse('2026-04-23T08:36:00.000Z')

describe('<CcQuotaClock>', () => {
  it('renders -- when bucket is null', () => {
    const { container, getByText } = render(<CcQuotaClock bucket={null} nowMs={now} />)
    expect(getByText(/--/)).toBeTruthy()
    // no quota fill path drawn
    expect(container.querySelector('[data-testid="quota-fill"]')).toBeNull()
  })

  it('renders the 150° cycle trough + a quota fill arc when data is present', () => {
    const bucket = { utilization: 33, resets_at: '2026-04-23T11:49:00.000Z' }
    const { container } = render(<CcQuotaClock bucket={bucket} nowMs={now} />)
    expect(container.querySelector('[data-testid="cycle-trough"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="quota-fill"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="reset-marker"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="hour-hand"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="minute-hand"]')).toBeNull() // per spec, no minute hand
  })

  it('classifies deficit as "warn" when used ratio exceeds time in cycle by 0<d<=0.20', () => {
    // now = 08:36, reset at 11:49 → ~35.7% through cycle. used = 50% → deficit ≈ 0.143 → warn
    const bucket = { utilization: 50, resets_at: '2026-04-23T11:49:00.000Z' }
    const { container } = render(<CcQuotaClock bucket={bucket} nowMs={now} />)
    expect(container.querySelector('[data-testid="quota-fill"]')!.getAttribute('data-state')).toBe('warn')
  })

  it('classifies deficit as "bad" when used exceeds time by more than 0.20', () => {
    // time ~35.7%, used 80% → deficit ≈ 0.44 → bad
    const bucket = { utilization: 80, resets_at: '2026-04-23T11:49:00.000Z' }
    const { container } = render(<CcQuotaClock bucket={bucket} nowMs={now} />)
    expect(container.querySelector('[data-testid="quota-fill"]')!.getAttribute('data-state')).toBe('bad')
  })
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npx vitest run src/components/CanvasHud/__tests__/CcQuotaClock.test.tsx`

Expected: `Cannot find module '../CcQuotaClock'`.

- [ ] **Step 3: Implement the clock**

```tsx
// src/components/CanvasHud/CcQuotaClock.tsx
import type { UsageBucket } from '../../hooks/useCcQuota'

interface Props {
  bucket: UsageBucket | null
  /** Injected for tests; defaults to live time. */
  nowMs?: number
}

const CYCLE_MS = 5 * 60 * 60 * 1000

// Clock geometry: viewBox 40x40, center (20,20), radius 15.
const CX = 20, CY = 20, R = 15

/** SVG clockwise 0° = 12 o'clock. `pointAt(0)` → top. */
function pointAt(angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180
  return { x: CX + R * Math.sin(rad), y: CY - R * Math.cos(rad) }
}

/**
 * Build an SVG arc path clockwise from `from` to `to` (angles in degrees CW from 12).
 * Callers must pass angles where `(to - from) mod 360` is the sweep length.
 */
function arcPath(fromDeg: number, toDeg: number): string {
  const a = pointAt(fromDeg)
  const b = pointAt(toDeg)
  const sweep = ((toDeg - fromDeg) % 360 + 360) % 360
  const largeArc = sweep > 180 ? 1 : 0
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
}

function hourOfDay12(ms: number): number {
  const d = new Date(ms)
  return (d.getHours() % 12) + d.getMinutes() / 60
}

type State = 'ok' | 'warn' | 'bad'

function classify(usedRatio: number, timeRatio: number): State {
  const deficit = usedRatio - timeRatio
  if (usedRatio >= 1 && timeRatio < 1) return 'bad'
  if (deficit > 0.20) return 'bad'
  if (deficit > 0) return 'warn'
  return 'ok'
}

const COLOR: Record<State, string> = {
  ok:   '#22d3ee',
  warn: '#f97316',
  bad:  '#ef4444',
}

export function CcQuotaClock({ bucket, nowMs }: Props) {
  const now = nowMs ?? Date.now()

  if (!bucket) {
    return (
      <svg viewBox="0 0 40 40" width="36" height="36" aria-label="5H quota (no data)">
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={3.5}/>
        <text x={CX} y={CY + 3} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.55)" fontFamily="JetBrains Mono, monospace">--</text>
      </svg>
    )
  }

  const resetMs = Date.parse(bucket.resets_at)
  const remainingMs = resetMs - now
  const timeRatio = Math.max(0, Math.min(1, 1 - remainingMs / CYCLE_MS))
  const usedRatio = Math.max(0, Math.min(1, bucket.utilization / 100))
  const state = classify(usedRatio, timeRatio)

  const resetHourAngle = hourOfDay12(resetMs) * 30             // reset position on clock face (deg CW from 12)
  const cycleStartAngle = (resetHourAngle - 150 + 360) % 360   // 150° before reset
  const remainingRatio = 1 - usedRatio                          // of the 150° window
  const fillStartAngle = (resetHourAngle - 150 * remainingRatio + 360) % 360
  const hourAngle = hourOfDay12(now) * 30

  const resetPt       = pointAt(resetHourAngle)
  const trailingEdge  = pointAt(fillStartAngle)

  const isFull = remainingRatio >= 0.9999

  return (
    <svg viewBox="0 0 40 40" width="36" height="36" aria-label={`5H quota ${Math.round(remainingRatio * 100)}% left`}>
      {/* outer trough (rest of the clock face, subtle) */}
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={3.5}/>
      {/* cycle trough (just the 150° window, dim) */}
      <path data-testid="cycle-trough" d={arcPath(cycleStartAngle, resetHourAngle)} fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth={3.5} strokeLinecap="butt"/>
      {/* quota fill (anchored to reset; retreats CW from cycle start) */}
      {usedRatio < 1 && (
        <path
          data-testid="quota-fill"
          data-state={state}
          d={arcPath(fillStartAngle, resetHourAngle)}
          fill="none"
          stroke={COLOR[state]}
          strokeWidth={3.5}
          strokeLinecap="butt"
        />
      )}
      {/* reset marker */}
      <circle data-testid="reset-marker" cx={resetPt.x} cy={resetPt.y} r={2} fill="#0a0f18" stroke="#f1f5f9" strokeWidth={1.1}/>
      {/* trailing-edge dot (quota's runner) — hidden when at cycle start or exhausted */}
      {!isFull && usedRatio < 1 && (
        <circle cx={trailingEdge.x} cy={trailingEdge.y} r={1.7} fill="#0a0f18" stroke={COLOR[state]} strokeWidth={1.2}/>
      )}
      {/* hour hand */}
      <g data-testid="hour-hand" transform={`rotate(${hourAngle} ${CX} ${CY})`}>
        <line x1={CX} y1={CY} x2={CX} y2={CY - (R - 3)} stroke="#f1f5f9" strokeWidth={1.5} strokeLinecap="round"/>
        <circle cx={CX} cy={CY} r={1.4} fill="#f1f5f9"/>
      </g>
    </svg>
  )
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `npx vitest run src/components/CanvasHud/__tests__/CcQuotaClock.test.tsx`

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/CanvasHud/CcQuotaClock.tsx src/components/CanvasHud/__tests__/CcQuotaClock.test.tsx
git commit -m "cc-quota: 5H clock subcomponent (#cc-quota-hud)"
```

---

## Task 7: 7D bar subcomponent

**Files:**
- Create: `src/components/CanvasHud/Cc7dBar.tsx`
- Create: `src/components/CanvasHud/__tests__/Cc7dBar.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/CanvasHud/__tests__/Cc7dBar.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Cc7dBar } from '../Cc7dBar'

const now = Date.parse('2026-04-23T08:36:00.000Z')

describe('<Cc7dBar>', () => {
  it('renders nothing quota-related when bucket is null (just --)', () => {
    const { container, getByText } = render(<Cc7dBar bucket={null} nowMs={now} />)
    expect(getByText(/--/)).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-fill"]')).toBeNull()
  })

  it('renders trough, playhead, trailing-edge dot and reset marker when bucket is present', () => {
    const bucket = { utilization: 89, resets_at: '2026-04-24T00:00:00.000Z' }
    const { container } = render(<Cc7dBar bucket={bucket} nowMs={now} />)
    expect(container.querySelector('[data-testid="bar-trough"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-fill"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-playhead"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-reset"]')).toBeTruthy()
  })

  it('shades a deficit rect when quota runner is ahead of time playhead', () => {
    // ~22h till reset on a 7d cycle → time_in_cycle ≈ 0.87. used 89% → small deficit ≈ 0.02 (warn)
    const bucket = { utilization: 89, resets_at: '2026-04-24T06:36:00.000Z' }
    const { container } = render(<Cc7dBar bucket={bucket} nowMs={now} />)
    const state = container.querySelector('[data-testid="bar-fill"]')!.getAttribute('data-state')
    expect(['warn', 'bad']).toContain(state)
    expect(container.querySelector('[data-testid="bar-deficit"]')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npx vitest run src/components/CanvasHud/__tests__/Cc7dBar.test.tsx`

Expected: fails with missing module.

- [ ] **Step 3: Implement the bar**

```tsx
// src/components/CanvasHud/Cc7dBar.tsx
import type { UsageBucket } from '../../hooks/useCcQuota'

interface Props {
  bucket: UsageBucket | null
  nowMs?: number
}

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000
const BAR_X = 0, BAR_Y = 6, BAR_W = 128, BAR_H = 8

type State = 'ok' | 'warn' | 'bad'
function classify(usedRatio: number, timeRatio: number): State {
  const deficit = usedRatio - timeRatio
  if (usedRatio >= 1 && timeRatio < 1) return 'bad'
  if (deficit > 0.20) return 'bad'
  if (deficit > 0)    return 'warn'
  return 'ok'
}
const COLOR: Record<State, string> = { ok: '#f59e0b', warn: '#f97316', bad: '#ef4444' }

export function Cc7dBar({ bucket, nowMs }: Props) {
  const now = nowMs ?? Date.now()

  if (!bucket) {
    return (
      <svg viewBox={`0 0 ${BAR_W + 2} 20`} width={BAR_W + 2} height={20} aria-label="7D quota (no data)">
        <rect x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H} rx={2} fill="rgba(255,255,255,0.09)"/>
        <text x={BAR_W / 2} y={18} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.55)" fontFamily="JetBrains Mono, monospace">--</text>
      </svg>
    )
  }

  const resetMs = Date.parse(bucket.resets_at)
  const remainingMs = resetMs - now
  const timeRatio = Math.max(0, Math.min(1, 1 - remainingMs / CYCLE_MS))
  const usedRatio = Math.max(0, Math.min(1, bucket.utilization / 100))
  const remainingRatio = 1 - usedRatio
  const state = classify(usedRatio, timeRatio)

  const playheadX = BAR_X + BAR_W * timeRatio
  const fillLeftX = BAR_X + BAR_W * usedRatio           // fill spans [fillLeftX, BAR_X+BAR_W]
  const fillWidth = BAR_W * remainingRatio

  const deficitStart = Math.min(playheadX, fillLeftX)
  const deficitEnd   = Math.max(playheadX, fillLeftX)
  const hasDeficit   = state !== 'ok' && usedRatio < 1

  return (
    <svg viewBox={`0 0 ${BAR_W + 4} 20`} width={BAR_W + 4} height={20}
         aria-label={`7D quota ${Math.round(remainingRatio * 100)}% left`}>
      {/* trough */}
      <rect data-testid="bar-trough" x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H} rx={2} fill="rgba(255,255,255,0.09)"/>
      {/* quota fill: anchored to right */}
      {usedRatio < 1 && (
        <rect
          data-testid="bar-fill"
          data-state={state}
          x={fillLeftX}
          y={BAR_Y}
          width={fillWidth}
          height={BAR_H}
          rx={2}
          fill={COLOR[state]}
        />
      )}
      {/* day ticks (6 interior) */}
      {[1, 2, 3, 4, 5, 6].map((i) => {
        const x = BAR_X + (BAR_W * i) / 7
        return <line key={i} x1={x} y1={BAR_Y} x2={x} y2={BAR_Y + BAR_H} stroke="rgba(255,255,255,0.3)" strokeWidth={1}/>
      })}
      {/* reset marker */}
      <circle data-testid="bar-reset" cx={BAR_X + BAR_W} cy={BAR_Y + BAR_H / 2} r={2.4} fill="#0a0f18" stroke="#f1f5f9" strokeWidth={1.2}/>
      {/* deficit shading */}
      {hasDeficit && (
        <rect
          data-testid="bar-deficit"
          x={deficitStart}
          y={BAR_Y}
          width={deficitEnd - deficitStart}
          height={BAR_H}
          fill={`${COLOR[state]}33`}
        />
      )}
      {/* playhead (time's runner) */}
      <line data-testid="bar-playhead" x1={playheadX} y1={BAR_Y - 2} x2={playheadX} y2={BAR_Y + BAR_H + 2} stroke="#f1f5f9" strokeWidth={1.5}/>
      {/* trailing-edge dot (quota's runner) — hidden when full */}
      {remainingRatio < 0.9999 && usedRatio < 1 && (
        <circle cx={fillLeftX} cy={BAR_Y + BAR_H / 2} r={1.7} fill="#0a0f18" stroke={COLOR[state]} strokeWidth={1.2}/>
      )}
    </svg>
  )
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `npx vitest run src/components/CanvasHud/__tests__/Cc7dBar.test.tsx`

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/CanvasHud/Cc7dBar.tsx src/components/CanvasHud/__tests__/Cc7dBar.test.tsx
git commit -m "cc-quota: 7D strip subcomponent (#cc-quota-hud)"
```

---

## Task 8: Assemble `CcQuotaCard` and place it in the HUD

**Files:**
- Create: `src/components/CanvasHud/CcQuotaCard.tsx`
- Create: `src/components/CanvasHud/__tests__/CcQuotaCard.test.tsx`
- Modify: `src/components/CanvasHud/hud.css` (append a small block for quota-card styles)
- Modify: `src/components/CanvasHud/CanvasHud.tsx` (insert the card between `<AutonomyStat>` and `<AgentQuadrant>`)

- [ ] **Step 1: Write the failing card tests**

```tsx
// src/components/CanvasHud/__tests__/CcQuotaCard.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CcQuotaCard } from '../CcQuotaCard'
import type { CcQuotaSnapshot } from '../../../hooks/useCcQuota'

function snap(partial: Partial<CcQuotaSnapshot['data']> = {}): CcQuotaSnapshot {
  return {
    fetchedAt: '2026-04-23T08:36:00.000Z',
    data: {
      five_hour:        { utilization: 67, resets_at: '2026-04-23T11:49:00.000Z' },
      seven_day:        { utilization: 89, resets_at: '2026-04-24T00:00:00.000Z' },
      seven_day_opus:   null,
      seven_day_sonnet: null,
      extra_usage:      { is_enabled: true, used_credits: 8148, currency: 'USD' },
      ...partial,
    },
    error: null,
  }
}

describe('<CcQuotaCard>', () => {
  it('renders % left for each bucket — NOT % used', () => {
    const { getByText, queryByText } = render(
      <CcQuotaCard snapshot={snap()} lastRefreshedAt={snap().fetchedAt} refreshing={false} refresh={() => {}} nowMs={Date.parse('2026-04-23T08:36:00Z')}/>
    )
    expect(getByText('33% left')).toBeTruthy()
    expect(getByText('11% left')).toBeTruthy()
    expect(queryByText(/67% used/)).toBeNull()
    expect(queryByText(/89% used/)).toBeNull()
  })

  it('shows gas pump ON with $X.XX when extra_usage is enabled', () => {
    const { getByText } = render(
      <CcQuotaCard snapshot={snap()} lastRefreshedAt={null} refreshing={false} refresh={() => {}} nowMs={Date.parse('2026-04-23T08:36:00Z')}/>
    )
    expect(getByText('$81.48')).toBeTruthy()
  })

  it('shows OFF when extra_usage.is_enabled=false', () => {
    const { getByText } = render(
      <CcQuotaCard snapshot={snap({ extra_usage: { is_enabled: false, used_credits: 0, currency: 'USD' } })} lastRefreshedAt={null} refreshing={false} refresh={() => {}}/>
    )
    expect(getByText('OFF')).toBeTruthy()
  })

  it('renders full skeleton with -- when snapshot has no data', () => {
    const empty: CcQuotaSnapshot = { fetchedAt: '2026-04-23T08:36:00.000Z', data: null, error: { code: 'no_creds', message: 'sign in' } }
    const { getAllByText, container } = render(
      <CcQuotaCard snapshot={empty} lastRefreshedAt={empty.fetchedAt} refreshing={false} refresh={() => {}}/>
    )
    // "--" appears in both rows for % left
    expect(getAllByText(/--/).length).toBeGreaterThanOrEqual(2)
    // the card container is still rendered
    expect(container.querySelector('[data-testid="cc-quota-card"]')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npx vitest run src/components/CanvasHud/__tests__/CcQuotaCard.test.tsx`

Expected: missing module error.

- [ ] **Step 3: Implement the card**

```tsx
// src/components/CanvasHud/CcQuotaCard.tsx
import './hud.css'
import { CcQuotaClock } from './CcQuotaClock'
import { Cc7dBar } from './Cc7dBar'
import type { CcQuotaSnapshot, ExtraUsage, UsageBucket } from '../../hooks/useCcQuota'

interface Props {
  snapshot: CcQuotaSnapshot | null
  lastRefreshedAt: string | null
  refreshing: boolean
  refresh: () => void
  /** Injected for tests. */
  nowMs?: number
}

function pctLeft(bucket: UsageBucket | null): string {
  if (!bucket) return '--'
  return `${Math.max(0, Math.round(100 - bucket.utilization))}% left`
}

function humanDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const hours = Math.floor(ms / 3_600_000)
  const mins  = Math.floor((ms % 3_600_000) / 60_000)
  if (hours <= 0) return `${mins}m`
  return `${hours}h ${mins}m`
}

function resetSubtitle(bucket: UsageBucket | null, nowMs: number): string {
  if (!bucket) return 'no data'
  const ms = Date.parse(bucket.resets_at) - nowMs
  return `resets ${humanDuration(ms)}`
}

function ageLabel(lastMs: number | null, nowMs: number): string {
  if (lastMs == null) return '—'
  const diffMin = Math.max(0, Math.floor((nowMs - lastMs) / 60_000))
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const h = Math.floor(diffMin / 60)
  return `${h}h ago`
}

function formatExtraUsage(extra: ExtraUsage | null): { text: string; on: boolean } | null {
  if (!extra) return null
  if (!extra.is_enabled) return { text: 'OFF', on: false }
  if (extra.used_credits == null) return { text: 'ON', on: true }
  // Empirical: `used_credits` is denominated in USD cents.
  return { text: `$${(extra.used_credits / 100).toFixed(2)}`, on: true }
}

function buildTooltip(s: CcQuotaSnapshot | null, nowMs: number): string {
  if (!s) return 'no data'
  const lines: string[] = []
  const d = s.data
  if (d?.five_hour)        lines.push(`5H resets ${new Date(d.five_hour.resets_at).toLocaleTimeString()}`)
  if (d?.seven_day)        lines.push(`7D resets ${new Date(d.seven_day.resets_at).toLocaleString()}`)
  if (d?.seven_day_sonnet) lines.push(`7D Sonnet ${Math.round(100 - d.seven_day_sonnet.utilization)}% left`)
  if (d?.seven_day_opus)   lines.push(`7D Opus ${Math.round(100 - d.seven_day_opus.utilization)}% left`)
  if (d?.extra_usage)      lines.push(`Extra usage ${d.extra_usage.is_enabled ? 'ON' : 'OFF'} · used_credits=${d.extra_usage.used_credits ?? 'null'}`)
  lines.push(`Fetched ${ageLabel(Date.parse(s.fetchedAt), nowMs)}`)
  if (s.error) lines.push(`⚠ ${s.error.code}: ${s.error.message}`)
  return lines.join('\n')
}

export function CcQuotaCard({ snapshot, lastRefreshedAt, refreshing, refresh, nowMs }: Props) {
  const now = nowMs ?? Date.now()
  const data = snapshot?.data ?? null
  const extra = formatExtraUsage(data?.extra_usage ?? null)
  const tooltip = buildTooltip(snapshot, now)
  const lastMs = lastRefreshedAt ? Date.parse(lastRefreshedAt) : null
  const isError = !!snapshot?.error

  return (
    <div data-testid="cc-quota-card" className="cc-quota-card" title={tooltip}>
      <div className="cc-quota-header">
        <span className="cc-quota-title">Claude Code</span>
        <div className="cc-quota-header-right">
          <button
            type="button"
            className={`cc-quota-refresh${isError ? ' err' : ''}${refreshing ? ' spin' : ''}`}
            onClick={refresh}
            aria-label="refresh quota"
          >
            <span className="material-symbols-outlined">refresh</span>
            <span>{ageLabel(lastMs, now)}</span>
          </button>
          {extra && (
            <span className={`cc-gas ${extra.on ? 'on' : 'off'}`}>
              <span className="material-symbols-outlined">local_gas_station</span>
              {extra.text}
            </span>
          )}
        </div>
      </div>

      <div className="cc-quota-row">
        <CcQuotaClock bucket={data?.five_hour ?? null} nowMs={now}/>
        <div className="cc-quota-text">
          <div className="cc-quota-big">{pctLeft(data?.five_hour ?? null)}</div>
          <div className="cc-quota-sub">5H · {resetSubtitle(data?.five_hour ?? null, now)}</div>
        </div>
      </div>

      <div className="cc-quota-row">
        <Cc7dBar bucket={data?.seven_day ?? null} nowMs={now}/>
        <div className="cc-quota-text">
          <div className="cc-quota-big">{pctLeft(data?.seven_day ?? null)}</div>
          <div className="cc-quota-sub">7D · {resetSubtitle(data?.seven_day ?? null, now)}</div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Append CSS to `hud.css`**

Open `src/components/CanvasHud/hud.css` and append:

```css
/* cc-quota card */
.cc-quota-card {
  background: rgba(8,14,22,0.55);
  border: 1px solid rgba(34,211,238,0.12);
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 8px;
}
.cc-quota-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.3);
  margin-bottom: 6px;
}
.cc-quota-header-right { display: flex; align-items: center; gap: 8px; }
.cc-quota-title { color: rgba(255,255,255,0.55); }
.cc-quota-refresh {
  background: transparent;
  border: 0;
  color: rgba(255,255,255,0.55);
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
}
.cc-quota-refresh .material-symbols-outlined { font-size: 12px; }
.cc-quota-refresh.err { color: #ef4444; }
.cc-quota-refresh.spin .material-symbols-outlined { animation: cc-spin 1.1s linear infinite; }
@keyframes cc-spin { to { transform: rotate(360deg); } }

.cc-gas {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.1em;
}
.cc-gas .material-symbols-outlined { font-size: 12px; line-height: 1; }
.cc-gas.on  { color: #6ee7b7; background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.36); }
.cc-gas.off { color: rgba(148,163,184,0.7); background: rgba(148,163,184,0.06); border: 1px solid rgba(148,163,184,0.22); }

.cc-quota-row { display: flex; align-items: center; gap: 10px; }
.cc-quota-row + .cc-quota-row { margin-top: 8px; }
.cc-quota-text { font-family: 'JetBrains Mono', monospace; font-size: 10px; line-height: 1.25; flex: 1; }
.cc-quota-big  { font-size: 11px; font-weight: 700; color: #f1f5f9; }
.cc-quota-sub  { color: rgba(255,255,255,0.5); font-size: 8.5px; }
```

- [ ] **Step 5: Place the card in the HUD**

In `src/components/CanvasHud/CanvasHud.tsx`, add the import at the top:

```ts
import { CcQuotaCard } from './CcQuotaCard'
import { useCcQuota } from '../../hooks/useCcQuota'
```

Inside the `CanvasHud` function, before the returned JSX, read the hook:

```ts
const { snapshot: ccQuota, lastRefreshedAt, refreshing, refresh } = useCcQuota()
```

And in the `HudShell` children, insert the card between `<AutonomyStat … />` and the `<AgentQuadrant … />` block (replace that section):

```tsx
      <AutonomyStat ratio={snapshot.autonomy.ratio} cliSeconds={snapshot.autonomy.cliSeconds} userSeconds={snapshot.autonomy.userSeconds} />
      <CcQuotaCard snapshot={ccQuota} lastRefreshedAt={lastRefreshedAt} refreshing={refreshing} refresh={refresh}/>
      {onFocusRun && (
        <AgentQuadrant
          runMap={runMap}
          burningRunIds={new Set(snapshot.burningRunIds ?? [])}
          onFocusRun={onFocusRun}
          selectedRunIds={selectedRunIds}
        />
      )}
```

- [ ] **Step 6: Run the full vitest suite + typecheck**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all tests pass; zero new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/CanvasHud/CcQuotaCard.tsx src/components/CanvasHud/__tests__/CcQuotaCard.test.tsx src/components/CanvasHud/hud.css src/components/CanvasHud/CanvasHud.tsx
git commit -m "cc-quota: assemble card and place in HUD (#cc-quota-hud)"
```

---

## Task 9: Playwright e2e coverage

**Files:**
- Create: `e2e/cc-quota.spec.ts`

- [ ] **Step 1: Write the e2e spec**

```ts
// e2e/cc-quota.spec.ts
import { test, expect } from '@playwright/test'

test.describe('cc-quota HUD card', () => {
  test('renders clock, 7D bar, % left values, and gas-pump chip with fast-sim data', async ({ page }) => {
    await page.goto('/')
    // HUD may be toggled off; press "t" to ensure it's visible
    await page.keyboard.press('KeyT')

    const card = page.getByTestId('cc-quota-card')
    await expect(card).toBeVisible()

    // % left text — with fast-sim fixture: 5h=67% used → 33% left; 7d=89% used → 11% left
    await expect(card).toContainText('33% left')
    await expect(card).toContainText('11% left')

    // gas pump chip — fast-sim has is_enabled=true, used_credits=8148 → $81.48
    await expect(card.getByText('$81.48')).toBeVisible()
  })
})
```

- [ ] **Step 2: Run the e2e spec**

Start the dev server in fast-sim mode in one terminal:

```bash
TINSTAR_FAST_SIM=1 npm run dev
```

In another terminal, run:

```bash
BASE_URL=http://localhost:5280 TINSTAR_FAST_SIM=1 npx playwright test e2e/cc-quota.spec.ts
```

Expected: the single test passes.

- [ ] **Step 3: Manually eyeball it**

Open `http://localhost:5280`, ensure the HUD is visible (press `t` if not), and confirm the card appears between AUTONOMY and AGENT QUADRANT with:

- 5H clock with cyan arc + hour hand + reset dot
- 7D bar with amber fill on the right + 6 interior ticks + playhead
- `⛽ $81.48` chip in the header
- `⟳ 0m ago` refresh button (click it; spinner animates once)

- [ ] **Step 4: Prometheus smoke check**

Query Prometheus (URL exposed by Tinstar's observability supervisor):

```bash
curl -s 'http://127.0.0.1:9090/api/v1/query?query=cc_quota_used_ratio'
```

Expected: a result with two series, `window="5h"` and `window="7d"`, each `value` a number in `[0,1]`.

- [ ] **Step 5: Commit**

```bash
git add e2e/cc-quota.spec.ts
git commit -m "cc-quota: playwright e2e for HUD card (#cc-quota-hud)"
```

---

## Completion checklist

- [ ] All 9 tasks committed, each commit message ends with `(#cc-quota-hud)`.
- [ ] `npx vitest run` passes.
- [ ] `npx tsc --noEmit` reports no new errors.
- [ ] `npx playwright test e2e/cc-quota.spec.ts` passes.
- [ ] Card is visible in the real HUD, `% left` matches the live `/api/cc-quota` response, gas pump chip reflects `extra_usage.is_enabled`.
- [ ] `curl 'http://127.0.0.1:9090/api/v1/query?query=cc_quota_used_ratio'` returns series with `window` labels.

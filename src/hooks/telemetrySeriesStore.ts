// Per-session telemetry series store: backfills 5 min of history once, then
// appends snapshot-tick samples on each call to `pushTick()`. Pushed by the
// existing telemetryStore listener wiring (see useTelemetrySeries).
//
// Why separate from telemetryStore: the snapshot fetch is hot (every 1.5s),
// the backfill is cold (once per mount). Keeping them separate avoids muddying
// telemetryStore's tight polling loop.

import { apiFetch } from '../apiClient'
import type { HudSeries } from '../server/observability/types'

/** Max samples retained per metric. 300 = 5 min at 1Hz; 320 = small headroom. */
const MAX_SAMPLES = 320

export interface SeriesSnapshot {
  /** Oldest → newest. Length up to MAX_SAMPLES. */
  cost: (number | null)[]
  tokens: (number | null)[]
  cache: (number | null)[]
  duty: (number | null)[]
}

export interface TickInput {
  tsSec: number
  cost: number | null
  tokens: number | null
  cache: number | null
  duty: number | null
}

type Listener = (snap: SeriesSnapshot) => void

interface PerSession {
  snap: SeriesSnapshot
  listeners: Set<Listener>
  backfillStarted: boolean
}

const store = new Map<string, PerSession>()

function emit(name: string) {
  const entry = store.get(name)
  if (!entry) return
  for (const fn of entry.listeners) fn(entry.snap)
}

function ensure(name: string): PerSession {
  let entry = store.get(name)
  if (!entry) {
    entry = {
      snap: { cost: [], tokens: [], cache: [], duty: [] },
      listeners: new Set(),
      backfillStarted: false,
    }
    store.set(name, entry)
  }
  return entry
}

async function backfill(name: string) {
  try {
    const r = await apiFetch(`/api/telemetry/session/${encodeURIComponent(name)}/series`)
    if (!r.ok) return
    const data = (await r.json()) as HudSeries
    const entry = store.get(name)
    if (!entry) return
    entry.snap = {
      cost:   data.series.cost.map(p => p[1]),
      tokens: data.series.tokens.map(p => p[1]),
      cache:  data.series.cache.map(p => p[1]),
      duty:   data.series.duty.map(p => p[1]),
    }
    emit(name)
  } catch {
    // Backfill is best-effort. If it fails, the tail will still accrue from snapshot ticks.
  }
}

function appendCapped<T>(arr: T[], v: T): T[] {
  const out = arr.length >= MAX_SAMPLES ? arr.slice(arr.length - MAX_SAMPLES + 1) : arr.slice()
  out.push(v)
  return out
}

export function pushTick(name: string, tick: TickInput): void {
  const entry = store.get(name)
  if (!entry) return
  entry.snap = {
    cost:   appendCapped(entry.snap.cost, tick.cost),
    tokens: appendCapped(entry.snap.tokens, tick.tokens),
    cache:  appendCapped(entry.snap.cache, tick.cache),
    duty:   appendCapped(entry.snap.duty, tick.duty),
  }
  emit(name)
}

export function subscribeSeries(name: string, listener: Listener): () => void {
  const entry = ensure(name)
  entry.listeners.add(listener)
  // Replay current state synchronously.
  listener(entry.snap)
  // First subscribe kicks the backfill.
  if (!entry.backfillStarted) {
    entry.backfillStarted = true
    void backfill(name)
  }
  return () => {
    const e = store.get(name)
    if (!e) return
    e.listeners.delete(listener)
    if (e.listeners.size === 0) store.delete(name)
  }
}

// --- Test-only helpers ---
export function _resetSeriesStoreForTests(): void { store.clear() }
export function pushTickForTests(name: string, tick: TickInput): void { pushTick(name, tick) }
export function _getSeriesForTests(name: string): SeriesSnapshot | null {
  return store.get(name)?.snap ?? null
}

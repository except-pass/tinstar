// Singleton store that batches per-session telemetry polling into ONE request.
//
// Why this exists:
// Each visible session widget used to poll GET /api/telemetry/session/<name>
// every 1.5s on its own interval. With 12+ widgets visible the browser
// connection pool saturated (ERR_INSUFFICIENT_RESOURCES on Tauri/Windows,
// degraded perf in regular browsers). The cascade of failed retries also
// caused render thrash and visual artifacts.
//
// This module replaces N intervals with one shared interval that fires a
// single batch request: GET /api/telemetry/sessions?names=foo,bar,baz.
// Components subscribe by session name and receive the latest snapshot via
// listener callbacks.

import type { HudSnapshot } from '../server/observability/types'
import { apiFetch } from '../apiClient'

const POLL_INTERVAL_MS = 1_500

type Listener = (snap: HudSnapshot | null) => void

interface StoreState {
  // Subscribers, keyed by session name. Multiple listeners per name are fine
  // (a session widget can be mounted multiple times in dev / strict mode).
  listeners: Map<string, Set<Listener>>
  // Latest snapshot keyed by session name. Used for new subscribers to get
  // an immediate value without waiting for the next tick.
  snapshots: Map<string, HudSnapshot | null>
  timer: ReturnType<typeof setInterval> | null
  inFlight: boolean
  // The promise of the current in-flight tick, if any. Lets tests wait for
  // a fire-and-forget tick (subscribe() kicks one without returning it).
  inFlightPromise: Promise<void> | null
}

const state: StoreState = {
  listeners: new Map(),
  snapshots: new Map(),
  timer: null,
  inFlight: false,
  inFlightPromise: null,
}

// --- Internal helpers ---

function activeNames(): string[] {
  const out: string[] = []
  for (const [name, set] of state.listeners) {
    if (set.size > 0) out.push(name)
  }
  return out
}

function tick(): Promise<void> {
  // Coalesce concurrent ticks: if a previous request hasn't finished, return
  // its promise so callers can await the same in-flight work. Prevents
  // pile-up under slow network and gives tests a deterministic wait point.
  if (state.inFlightPromise) return state.inFlightPromise
  const names = activeNames()
  if (names.length === 0) return Promise.resolve()
  state.inFlight = true
  const promise = (async () => {
    try {
      const qs = encodeURIComponent(names.join(','))
      const r = await apiFetch(`/api/telemetry/sessions?names=${qs}`)
      if (!r.ok) return
      const data = (await r.json()) as Record<string, HudSnapshot | null>
      for (const name of names) {
        const next = data[name] ?? null
        const prev = state.snapshots.get(name)
        // Cheap change detection — skip listener notifications when the
        // serialized payload is identical, matching the SSE-side optimization.
        if (JSON.stringify(prev) === JSON.stringify(next)) continue
        state.snapshots.set(name, next)
        const set = state.listeners.get(name)
        if (set) for (const fn of set) fn(next)
      }
    } catch {
      // Network glitch — next tick will retry.
    } finally {
      state.inFlight = false
      state.inFlightPromise = null
    }
  })()
  state.inFlightPromise = promise
  return promise
}

function ensureTimer(): void {
  if (state.timer) return
  state.timer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
}

function maybeStopTimer(): void {
  if (state.timer && activeNames().length === 0) {
    clearInterval(state.timer)
    state.timer = null
  }
}

// --- Public API ---

/**
 * Subscribe to telemetry snapshots for `name`. Returns an unsubscribe fn.
 *
 * On first subscribe for any name, the shared 1.5s interval starts. When the
 * last subscriber for the last name unsubscribes, the interval stops.
 *
 * If a snapshot is already cached for this name, the listener is invoked
 * synchronously with that value. Otherwise it must wait for the next tick.
 */
export function subscribe(name: string, listener: Listener): () => void {
  let set = state.listeners.get(name)
  if (!set) {
    set = new Set()
    state.listeners.set(name, set)
  }
  set.add(listener)

  // Replay cached value if we have one — keeps the UI snappy when a widget
  // remounts. Cast to non-null union: undefined means "never fetched yet".
  const cached = state.snapshots.get(name)
  if (cached !== undefined) listener(cached)

  ensureTimer()
  // Kick a tick right away so first-subscribe doesn't wait 1.5s for data.
  // tick() is no-op when already in flight or when names is empty.
  void tick()

  return () => {
    const s = state.listeners.get(name)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) {
      state.listeners.delete(name)
      // Drop cache for inactive sessions — keeps memory bounded over long
      // sessions where widgets come and go.
      state.snapshots.delete(name)
    }
    maybeStopTimer()
  }
}

// --- Test-only helpers ---

/** Reset all internal state. Test-only. */
export function _resetTelemetryStoreForTests(): void {
  if (state.timer) { clearInterval(state.timer); state.timer = null }
  state.listeners.clear()
  state.snapshots.clear()
  state.inFlight = false
  state.inFlightPromise = null
}

/** Force-run a tick. Test-only. */
export function _tickForTests(): Promise<void> {
  return tick()
}

/** Inspect current active names. Test-only. */
export function _activeNamesForTests(): string[] {
  return activeNames()
}

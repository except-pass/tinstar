import { useEffect, useState } from 'react'
import type { ProviderObservationSnapshotFor } from '../domain/provider-capabilities'
import { apiFetch } from '../apiClient'

const REFRESH_INTERVAL_MS = 30_000

export interface ProviderTelemetrySeriesSnapshot {
  tsSec: number[]
  tokens: Array<number | null>
  source: string | null
  freshness: 'fresh' | 'stale' | 'unknown'
  error: string | null
}

interface Entry {
  snapshot: ProviderTelemetrySeriesSnapshot | null
  listeners: Set<(snapshot: ProviderTelemetrySeriesSnapshot | null) => void>
  timer: ReturnType<typeof setInterval> | null
  inFlight: Promise<void> | null
}

const entries = new Map<string, Entry>()

export function useProviderTelemetrySeries(
  providerId: string | null,
  sessionId: string | null,
): ProviderTelemetrySeriesSnapshot | null {
  const key = providerId && sessionId
    ? JSON.stringify([providerId, sessionId])
    : null
  const [state, setState] = useState<{
    key: string | null
    snapshot: ProviderTelemetrySeriesSnapshot | null
  }>({ key: null, snapshot: null })
  useEffect(() => {
    if (!key || !providerId || !sessionId) return
    return subscribe(providerId, sessionId, snapshot => setState({ key, snapshot }))
  }, [key, providerId, sessionId])

  // Subscription effects run after render. Tagging the snapshot prevents one
  // frame of the previous session's history from appearing under the new key.
  return state.key === key ? state.snapshot : null
}

function subscribe(
  providerId: string,
  sessionId: string,
  listener: (snapshot: ProviderTelemetrySeriesSnapshot | null) => void,
): () => void {
  const key = JSON.stringify([providerId, sessionId])
  let entry = entries.get(key)
  if (!entry) {
    entry = { snapshot: null, listeners: new Set(), timer: null, inFlight: null }
    entries.set(key, entry)
  }
  entry.listeners.add(listener)
  listener(entry.snapshot)
  if (!entry.timer) {
    void refresh(key, providerId, sessionId, entry)
    entry.timer = setInterval(() => {
      void refresh(key, providerId, sessionId, entry!)
    }, REFRESH_INTERVAL_MS)
  }

  return () => {
    const current = entries.get(key)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size === 0) {
      if (current.timer) clearInterval(current.timer)
      entries.delete(key)
    }
  }
}

function refresh(
  key: string,
  providerId: string,
  sessionId: string,
  entry: Entry,
): Promise<void> {
  if (entry.inFlight) return entry.inFlight
  entry.inFlight = (async () => {
    try {
      const response = await apiFetch(
        `/api/telemetry/provider/${encodeURIComponent(providerId)}/session/${encodeURIComponent(sessionId)}/series`,
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const snapshot = await response.json() as ProviderObservationSnapshotFor<'historical-telemetry'>
      entry.snapshot = normalizeSeriesSnapshot(snapshot)
    } catch (error) {
      entry.snapshot = {
        ...(entry.snapshot ?? emptySeries()),
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      entry.inFlight = null
      if (entries.get(key) === entry) {
        for (const listener of entry.listeners) listener(entry.snapshot)
      }
    }
  })()
  return entry.inFlight
}

function normalizeSeriesSnapshot(
  snapshot: ProviderObservationSnapshotFor<'historical-telemetry'>,
): ProviderTelemetrySeriesSnapshot {
  if (snapshot.availability.state !== 'available') {
    const message = snapshot.availability.state === 'unsupported'
      ? snapshot.availability.reason
      : snapshot.availability.message ?? snapshot.availability.reason.replaceAll('-', ' ')
    return {
      ...emptySeries(),
      source: snapshot.source?.label ?? null,
      freshness: snapshot.freshness.state,
      error: message,
    }
  }

  const series = new Map(snapshot.availability.value.series.map(value => [value.metric, value]))
  const tokens = series.get('tokens')?.points ?? []
  return {
    tsSec: tokens.map(point => Date.parse(point.at) / 1_000),
    tokens: tokens.map(point => point.value),
    source: snapshot.source?.label ?? null,
    freshness: snapshot.freshness.state,
    error: null,
  }
}

function emptySeries(): ProviderTelemetrySeriesSnapshot {
  return {
    tsSec: [],
    tokens: [],
    source: null,
    freshness: 'unknown',
    error: null,
  }
}

/** Test-only reset for the keyed singleton. */
export function _resetProviderTelemetrySeriesForTests(): void {
  for (const entry of entries.values()) {
    if (entry.timer) clearInterval(entry.timer)
  }
  entries.clear()
}

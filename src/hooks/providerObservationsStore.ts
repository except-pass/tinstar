import { useMemo, useSyncExternalStore } from 'react'
import {
  parseProviderObservationViewWire,
  type ProviderAccountQuotaObservationWire,
  type ProviderCurrentObservationsWire,
  type ManagedProviderSessionWire,
  type ProviderSessionContextObservationWire,
  type ProviderSessionUsageObservationWire,
} from '../domain/provider-observation-wire'
import { apiFetch } from '../apiClient'

const POLL_INTERVAL_MS = 1_500
const EMPTY_OBSERVATIONS: ProviderCurrentObservationsWire = {
  version: 1,
  sessionUsage: [],
  sessionContext: [],
  providerQuota: [],
}

export interface ProviderObservationsState {
  observations: ProviderCurrentObservationsWire
  managedSessions: ManagedProviderSessionWire[]
  error: string | null
  loaded: boolean
}

export interface ProviderSessionObservations {
  providerId: string
  usage?: ProviderSessionUsageObservationWire
  context?: ProviderSessionContextObservationWire
}

export interface ProviderSessionObservationState {
  observations: ProviderSessionObservations[]
  error: string | null
  loaded: boolean
}

const SERVER_STATE: ProviderObservationsState = {
  observations: EMPTY_OBSERVATIONS,
  managedSessions: [],
  error: null,
  loaded: false,
}

let state: ProviderObservationsState = SERVER_STATE
let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function update(next: ProviderObservationsState): void {
  if (JSON.stringify(next) === JSON.stringify(state)) return
  state = next
  emit()
}

function describeFetchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fetchObservations(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const response = await apiFetch('/api/provider-observation-view')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const view = parseProviderObservationViewWire(await response.json())
      update({
        observations: view.observations,
        managedSessions: view.managedSessions,
        error: null,
        loaded: true,
      })
    } catch (error) {
      update({
        ...state,
        error: describeFetchError(error),
        loaded: true,
      })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

function ensurePolling(): void {
  if (timer) return
  void fetchObservations()
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void fetchObservations()
  }, POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void fetchObservations()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) ensurePolling()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopPolling()
  }
}

function getSnapshot(): ProviderObservationsState {
  return state
}

function getServerSnapshot(): ProviderObservationsState {
  return SERVER_STATE
}

export function useProviderObservations(): ProviderObservationsState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export function useProviderSessionObservations(
  sessionId: string | null,
): ProviderSessionObservations[] {
  return useProviderSessionObservationState(sessionId).observations
}

export function useProviderSessionObservationState(
  sessionId: string | null,
): ProviderSessionObservationState {
  const current = useProviderObservations()
  const observations = useMemo(() => {
    if (!sessionId) return []
    const managed = current.managedSessions.find(
      session => session.hostSessionId === sessionId,
    )
    const matchesSession = (providerId: string, providerSessionId: string): boolean => (
      managed
        ? managed.providerId === providerId
          && managed.providerSessionIds.includes(providerSessionId)
        : providerSessionId === sessionId
    )
    const byProvider = new Map<string, ProviderSessionObservations>()
    for (const usage of current.observations.sessionUsage) {
      if (!matchesSession(usage.providerId, usage.scope.sessionId)) continue
      byProvider.set(usage.providerId, { providerId: usage.providerId, usage })
    }
    for (const context of current.observations.sessionContext) {
      if (!matchesSession(context.providerId, context.scope.sessionId)) continue
      const existing = byProvider.get(context.providerId)
      byProvider.set(context.providerId, {
        providerId: context.providerId,
        ...existing,
        context,
      })
    }
    return [...byProvider.values()].sort((left, right) => (
      left.providerId.localeCompare(right.providerId)
    ))
  }, [current.managedSessions, current.observations, sessionId])
  return {
    observations,
    error: current.error,
    loaded: current.loaded,
  }
}

export function useProviderQuotaObservations(): {
  observations: ProviderAccountQuotaObservationWire[]
  error: string | null
  loaded: boolean
} {
  const current = useProviderObservations()
  return {
    observations: current.observations.providerQuota,
    error: current.error,
    loaded: current.loaded,
  }
}

/** Test-only reset for the module singleton. */
export function _resetProviderObservationsStoreForTests(): void {
  stopPolling()
  listeners.clear()
  inFlight = null
  state = SERVER_STATE
}

/** Test-only synchronization with the current request. */
export function _fetchProviderObservationsForTests(): Promise<void> {
  return fetchObservations()
}

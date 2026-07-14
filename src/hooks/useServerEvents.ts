/* eslint-disable no-var */
declare global { var __TINSTAR_BACKEND_PORT__: string | undefined }

import { useSyncExternalStore, useCallback } from 'react'
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget, TopicMetadata, PluginWidgetInstance } from '../domain/types'
import type { ConstellationGraph } from '../domain/constellationGraph'
import type { PinSet } from '../domain/pinSet'
import { isSystemSession, extractMarshal } from '../domain/system-sessions'
import { apiUrl } from '../apiClient'
import { dispatchWindowEvent } from '../lib/windowEvents'
import { removeHiddenRunId } from './useHiddenRuns'

/** Upsert-or-remove an item in an array by a key field. */
function upsertById<T>(arr: T[], item: T | null, id: string, key: keyof T & string): T[] {
  if (item === null) return arr.filter(x => x[key] !== id)
  const idx = arr.findIndex(x => x[key] === (item as T)[key])
  return idx >= 0 ? arr.map((x, i) => (i === idx ? item : x)) : [...arr, item]
}

interface ServerState {
  activeSpaceId: string
  spaces: Space[]
  initiatives: Initiative[]
  epics: Epic[]
  tasks: Task[]
  worktrees: Worktree[]
  runs: Run[]
  /** Marshal session (filtered out of `runs[]`). Drives the canvas-sidebar
   *  marshal panel; null until the snapshot or first run-delta arrives. */
  marshal: Run | null
  editorWidgets: EditorWidget[]
  browserWidgets: BrowserWidget[]
  imageWidgets: ImageWidget[]
  topicMetadata: TopicMetadata[]
  readyQueue: string[]
  pluginWidgets: PluginWidgetInstance[]
  constellationGraphs: ConstellationGraph[]
  pinSets: PinSet[]
}

const EMPTY_STATE: ServerState = {
  activeSpaceId: '',
  spaces: [],
  initiatives: [],
  epics: [],
  tasks: [],
  worktrees: [],
  runs: [],
  marshal: null,
  editorWidgets: [],
  browserWidgets: [],
  imageWidgets: [],
  topicMetadata: [],
  readyQueue: [],
  pluginWidgets: [],
  constellationGraphs: [],
  pinSets: [],
}

// ─── Singleton SSE store ───────────────────────────────────────────────
// All React consumers share a single EventSource via useSyncExternalStore.
// Previously each useServerEvents() call opened its own EventSource,
// exhausting the browser's 6-connection HTTP/1.1 limit and blocking
// all fetch() calls, terminal iframes, and other HTTP traffic.

let currentState: ServerState = EMPTY_STATE
/** Single snapshot for state + connection flags — one useSyncExternalStore subscriber per hook (not three). */
let uiBundle: { state: ServerState; connected: boolean; loading: boolean } = {
  state: EMPTY_STATE,
  connected: false,
  loading: true,
}
let listeners = new Set<() => void>()
let es: EventSource | null = null
let refCount = 0

function notify() {
  for (const fn of listeners) fn()
}

function getUiSnapshot() {
  return uiBundle
}

function pushState() {
  uiBundle = { ...uiBundle, state: currentState }
  notify()
}

function setConnected(c: boolean) {
  uiBundle = { ...uiBundle, connected: c }
  notify()
}


function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  refCount++

  if (refCount === 1) startSSE()

  return () => {
    listeners.delete(listener)
    refCount--
    if (refCount === 0) stopSSE()
  }
}

// ─── Generic channel API for non-React subscribers (plugins) ────────────
// Plugins used to open their own EventSource, exhausting the HTTP/1.1
// 6-connection cap (the same bug the singleton was created to fix).
// subscribeToChannel routes through this module's shared EventSource —
// one connection for the React app and every plugin combined.

type ChannelHandler = (payload: unknown) => void

interface ChannelBinding {
  handlers: Set<ChannelHandler>
  esListener: ((ev: MessageEvent) => void) | null
}

const channelBindings = new Map<string, ChannelBinding>()

function attachESListener(channel: string, binding: ChannelBinding): void {
  if (binding.esListener || !es) return
  const listener = (ev: MessageEvent) => {
    let payload: unknown
    try { payload = JSON.parse(ev.data) } catch {
      // eslint-disable-next-line no-console
      console.warn(`[sse-channel] dropped malformed frame on '${channel}'`)
      return
    }
    for (const h of binding.handlers) {
      try { h(payload) } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[sse-channel] handler for '${channel}' threw`, err)
      }
    }
  }
  binding.esListener = listener
  es.addEventListener(channel, listener)
}

function detachESListener(channel: string, binding: ChannelBinding): void {
  if (binding.esListener && es) {
    es.removeEventListener(channel, binding.esListener)
  }
  binding.esListener = null
}

/** Reattach all known channel listeners — called from startSSE after the
 *  EventSource is (re)created so bindings registered while SSE was stopped
 *  pick up the new connection. */
function reattachChannelListeners(): void {
  for (const [channel, binding] of channelBindings) {
    if (!binding.esListener) attachESListener(channel, binding)
  }
}

export function subscribeToChannel(channel: string, handler: ChannelHandler): () => void {
  let binding = channelBindings.get(channel)
  if (!binding) {
    binding = { handlers: new Set(), esListener: null }
    channelBindings.set(channel, binding)
  }
  binding.handlers.add(handler)
  refCount++
  if (refCount === 1) startSSE()
  attachESListener(channel, binding)
  return () => {
    binding!.handlers.delete(handler)
    if (binding!.handlers.size === 0) {
      detachESListener(channel, binding!)
      channelBindings.delete(channel)
    }
    refCount--
    if (refCount === 0) stopSSE()
  }
}

/** Test-only: clear singleton state between tests. Do not call in production. */
export function _resetServerEventsForTests(): void {
  if (es) {
    try { es.close() } catch {/* mock may not implement close */}
    es = null
  }
  listeners.clear()
  channelBindings.clear()
  refCount = 0
  currentState = EMPTY_STATE
  uiBundle = { state: EMPTY_STATE, connected: false, loading: true }
}

function startSSE() {
  if (es) return
  // No EventSource in non-browser environments (SSR, jsdom tests) — stay
  // disconnected rather than throwing on mount.
  if (typeof EventSource === 'undefined') return

  const devBase =
    import.meta.env.DEV && typeof __TINSTAR_BACKEND_PORT__ !== 'undefined'
      ? `http://${location.hostname}:${__TINSTAR_BACKEND_PORT__}`
      : null
  const sseUrl = devBase ? `${devBase}/api/events` : apiUrl('/api/events')

  es = new EventSource(sseUrl, { withCredentials: true })

  es.addEventListener('snapshot', (e: MessageEvent) => {
    const snapshot = JSON.parse(e.data) as ServerState & { ready_queue?: string[] }
    const { marshal, rest } = extractMarshal(snapshot.runs ?? [])
    currentState = {
      ...snapshot,
      readyQueue: snapshot.ready_queue ?? [],
      topicMetadata: snapshot.topicMetadata ?? [],
      pluginWidgets: snapshot.pluginWidgets ?? [],
      constellationGraphs: snapshot.constellationGraphs ?? [],
      pinSets: snapshot.pinSets ?? [],
      // System sessions (e.g. marshal) have dedicated UI — never enter the
      // run set that feeds the canvas/hierarchy/sessions list. They live on
      // `marshal` instead.
      runs: rest,
      marshal,
    }
    uiBundle = { ...uiBundle, state: currentState, loading: false }
    notify()
  })

  es.addEventListener('delta', (e: MessageEvent) => {
    const delta = JSON.parse(e.data) as {
      eventType: string
      entity: string
      id: string
      data: unknown
    }
    currentState = applyDelta(currentState, delta)
    pushState()
  })

  const forwardedEvents = ['file_watch', 'nats_traffic', 'telemetry:hud', 'canvas:viewport', 'projects_changed', 'download:push'] as const
  for (const evt of forwardedEvents) {
    es.addEventListener(evt, (e: MessageEvent) => {
      try { dispatchWindowEvent(`tinstar:${evt}`, JSON.parse(e.data)) } catch (err) { console.warn(`[sse] malformed ${evt} event:`, (err as Error).message) }
    })
  }

  es.addEventListener('heartbeat', () => {
    // Keep-alive, no action needed
  })

  es.addEventListener('ready_queue_update', (e: MessageEvent) => {
    const { queue } = JSON.parse(e.data) as { queue: string[] }
    currentState = { ...currentState, readyQueue: queue }
    pushState()
  })

  es.onopen = () => { setConnected(true) }
  es.onerror = () => { setConnected(false) }

  // Re-attach any plugin-registered channel listeners after the new EventSource is up.
  reattachChannelListeners()

  const onBeforeUnload = () => es?.close()
  window.addEventListener('beforeunload', onBeforeUnload)
}

function stopSSE() {
  if (es) {
    es.close()
    es = null
  }
}

export function applyDelta(prev: ServerState, delta: { entity: string; id: string; data: unknown }): ServerState {
  if (delta.entity === 'all' && delta.data === null) {
    return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [], constellationGraphs: [], pinSets: [] }
  }

  if (delta.entity === 'space') {
    return { ...prev, spaces: upsertById(prev.spaces, delta.data as Space | null, delta.id, 'id') }
  }

  if (delta.entity === 'initiative') {
    return { ...prev, initiatives: upsertById(prev.initiatives, delta.data as Initiative | null, delta.id, 'id') }
  }

  if (delta.entity === 'epic') {
    return { ...prev, epics: upsertById(prev.epics, delta.data as Epic | null, delta.id, 'id') }
  }

  if (delta.entity === 'task') {
    return { ...prev, tasks: upsertById(prev.tasks, delta.data as Task | null, delta.id, 'id') }
  }

  if (delta.entity === 'worktree') {
    return { ...prev, worktrees: upsertById(prev.worktrees, delta.data as Worktree | null, delta.id, 'id') }
  }

  if (delta.entity === 'run') {
    if (delta.data === null) {
      // Could be either a marshal delete or a regular run delete.
      if (prev.marshal && prev.marshal.id === delta.id) {
        return { ...prev, marshal: null }
      }
      // Prune any stale hidden-runs entry for this id. Run ids are the reusable
      // session name, so leaving the id in the hidden set would make a future
      // same-named run born hidden (grayed in the sidebar, absent from canvas).
      // Removal is the universal, cross-tab signal — the server orders it before
      // any re-creation, so a reused name can never inherit the stale flag.
      removeHiddenRunId(delta.id)
      return { ...prev, runs: prev.runs.filter(r => r.id !== delta.id) }
    }
    const run = delta.data as Run
    const mergeRun = (prevRun: Run | undefined, next: Run): Run => ({
      ...prevRun,
      ...next,
      // Run deltas carry the full run object, but a cleared attention is
      // stored server-side as `attention: undefined`, which JSON.stringify
      // drops from the SSE payload entirely. The spread-merge above would
      // then inherit the stale attention from prevRun forever (a background
      // run's breakthrough card would never return to invisibility), so take
      // attention from the incoming run explicitly: absent key = cleared.
      attention: next.attention,
      // Same undefined-drop hazard as `attention` above: clearing a run's
      // friendly name stores `name: undefined`, which JSON.stringify omits from
      // the SSE payload, so the spread would inherit the stale name forever and
      // the run could never fall back to showing its id again.
      name: next.name,
      touchedFiles: next.touchedFiles ?? prevRun?.touchedFiles ?? [],
      recapEntries: next.recapEntries ?? prevRun?.recapEntries ?? [],
    })
    if (isSystemSession(run)) {
      return { ...prev, marshal: mergeRun(prev.marshal ?? undefined, run) }
    }
    const exists = prev.runs.some(r => r.id === run.id)
    return {
      ...prev,
      runs: exists
        ? prev.runs.map(r => (r.id === run.id ? mergeRun(r, run) : r))
        : [...prev.runs, mergeRun(undefined, run)],
    }
  }

  if (delta.entity === 'editorWidget') {
    return { ...prev, editorWidgets: upsertById(prev.editorWidgets, delta.data as EditorWidget | null, delta.id, 'id') }
  }

  if (delta.entity === 'browserWidget') {
    return { ...prev, browserWidgets: upsertById(prev.browserWidgets, delta.data as BrowserWidget | null, delta.id, 'id') }
  }

  if (delta.entity === 'imageWidget') {
    return { ...prev, imageWidgets: upsertById(prev.imageWidgets, delta.data as ImageWidget | null, delta.id, 'id') }
  }

  if (delta.entity === 'topicMetadata') {
    return { ...prev, topicMetadata: upsertById(prev.topicMetadata, delta.data as TopicMetadata | null, delta.id, 'subject') }
  }

  if (delta.entity === 'pluginWidget') {
    return { ...prev, pluginWidgets: upsertById(prev.pluginWidgets, delta.data as PluginWidgetInstance | null, delta.id, 'id') }
  }

  if (delta.entity === 'constellationGraph') {
    return { ...prev, constellationGraphs: upsertById(prev.constellationGraphs, delta.data as ConstellationGraph | null, delta.id, 'spaceId') }
  }

  if (delta.entity === 'pinSet') {
    return { ...prev, pinSets: upsertById(prev.pinSets, delta.data as PinSet | null, delta.id, 'spaceId') }
  }

  if (delta.entity === 'commit') {
    dispatchWindowEvent('tinstar:commit-delta', undefined)
    return prev
  }

  return prev
}

/** Apply an optimistic update to the shared state */
export function applyOptimistic(entity: string, data: unknown): void {
  const prev = currentState
  const entityMap: Record<string, { stateKey: keyof ServerState; key: string }> = {
    initiative: { stateKey: 'initiatives', key: 'id' },
    epic: { stateKey: 'epics', key: 'id' },
    task: { stateKey: 'tasks', key: 'id' },
    editorWidget: { stateKey: 'editorWidgets', key: 'id' },
    browserWidget: { stateKey: 'browserWidgets', key: 'id' },
    imageWidget: { stateKey: 'imageWidgets', key: 'id' },
    pluginWidget: { stateKey: 'pluginWidgets', key: 'id' },
    run: { stateKey: 'runs', key: 'id' },
  }
  const mapping = entityMap[entity]
  if (!mapping) return
  const arr = prev[mapping.stateKey] as unknown as Array<{ id: string }>
  const item = data as { id: string }
  currentState = { ...prev, [mapping.stateKey]: upsertById(arr, item, item[mapping.key as keyof typeof item] as string, mapping.key as keyof typeof item) }
  pushState()
}

// ─── React hook (all consumers share the single SSE connection) ────────

export function useServerEvents(): {
  state: ServerState
  connected: boolean
  loading: boolean
  addOptimistic: (entity: string, data: unknown) => void
  disconnect: () => void
} {
  const bundle = useSyncExternalStore(subscribe, getUiSnapshot)
  const state = bundle.state
  const isConnected = bundle.connected
  const isLoading = bundle.loading

  const addOptimistic = useCallback((entity: string, data: unknown) => {
    applyOptimistic(entity, data)
  }, [])

  const disconnect = useCallback(() => {
    stopSSE()
  }, [])

  return { state, connected: isConnected, loading: isLoading, addOptimistic, disconnect }
}

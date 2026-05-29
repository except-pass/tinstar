/* eslint-disable no-var */
declare global { var __TINSTAR_BACKEND_PORT__: string | undefined }

import { useSyncExternalStore, useCallback } from 'react'
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget, NatsTrafficWidget, TopicMetadata, PluginWidgetInstance } from '../domain/types'
import { isSystemSession, extractMarshal } from '../domain/system-sessions'
import { apiUrl } from '../apiClient'
import { dispatchWindowEvent } from '../lib/windowEvents'

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
  natsTrafficWidgets: NatsTrafficWidget[]
  topicMetadata: TopicMetadata[]
  readyQueue: string[]
  pluginWidgets: PluginWidgetInstance[]
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
  natsTrafficWidgets: [],
  topicMetadata: [],
  readyQueue: [],
  pluginWidgets: [],
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

  es.addEventListener('file_watch', (e: MessageEvent) => {
    try { dispatchWindowEvent('tinstar:file_watch', JSON.parse(e.data)) } catch { /* malformed — drop */ }
  })

  es.addEventListener('nats_traffic', (e: MessageEvent) => {
    try { dispatchWindowEvent('tinstar:nats_traffic', JSON.parse(e.data)) } catch { /* malformed — drop */ }
  })

  es.addEventListener('telemetry:hud', (e: MessageEvent) => {
    try { dispatchWindowEvent('tinstar:telemetry:hud', JSON.parse(e.data)) } catch { /* malformed — drop */ }
  })

  es.addEventListener('canvas:viewport', (e: MessageEvent) => {
    try { dispatchWindowEvent('tinstar:canvas:viewport', JSON.parse(e.data)) } catch { /* malformed — drop */ }
  })

  es.addEventListener('projects_changed', (e: MessageEvent) => {
    try { dispatchWindowEvent('tinstar:projects_changed', JSON.parse(e.data)) } catch { /* malformed — drop */ }
  })

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

function applyDelta(prev: ServerState, delta: { entity: string; id: string; data: unknown }): ServerState {
  if (delta.entity === 'all' && delta.data === null) {
    return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [] }
  }

  if (delta.entity === 'space') {
    if (delta.data === null) return { ...prev, spaces: prev.spaces.filter(s => s.id !== delta.id) }
    const space = delta.data as Space
    const exists = prev.spaces.some(s => s.id === space.id)
    return { ...prev, spaces: exists ? prev.spaces.map(s => s.id === space.id ? space : s) : [...prev.spaces, space] }
  }

  if (delta.entity === 'initiative') {
    if (delta.data === null) return { ...prev, initiatives: prev.initiatives.filter(i => i.id !== delta.id) }
    const init = delta.data as Initiative
    const exists = prev.initiatives.some(i => i.id === init.id)
    return { ...prev, initiatives: exists ? prev.initiatives.map(i => i.id === init.id ? init : i) : [...prev.initiatives, init] }
  }

  if (delta.entity === 'epic') {
    if (delta.data === null) return { ...prev, epics: prev.epics.filter(e => e.id !== delta.id) }
    const epic = delta.data as Epic
    const exists = prev.epics.some(e => e.id === epic.id)
    return { ...prev, epics: exists ? prev.epics.map(e => e.id === epic.id ? epic : e) : [...prev.epics, epic] }
  }

  if (delta.entity === 'task') {
    if (delta.data === null) return { ...prev, tasks: prev.tasks.filter(t => t.id !== delta.id) }
    const task = delta.data as Task
    const exists = prev.tasks.some(t => t.id === task.id)
    return { ...prev, tasks: exists ? prev.tasks.map(t => t.id === task.id ? task : t) : [...prev.tasks, task] }
  }

  if (delta.entity === 'worktree') {
    if (delta.data === null) return { ...prev, worktrees: prev.worktrees.filter(w => w.id !== delta.id) }
    const wt = delta.data as Worktree
    const exists = prev.worktrees.some(w => w.id === wt.id)
    return { ...prev, worktrees: exists ? prev.worktrees.map(w => w.id === wt.id ? wt : w) : [...prev.worktrees, wt] }
  }

  if (delta.entity === 'run') {
    if (delta.data === null) {
      // Could be either a marshal delete or a regular run delete.
      if (prev.marshal && prev.marshal.id === delta.id) {
        return { ...prev, marshal: null }
      }
      return { ...prev, runs: prev.runs.filter(r => r.id !== delta.id) }
    }
    const run = delta.data as Run
    const mergeRun = (prevRun: Run | undefined, next: Run): Run => ({
      ...prevRun,
      ...next,
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
    const ews = prev.editorWidgets
    if (delta.data === null) return { ...prev, editorWidgets: ews.filter(w => w.id !== delta.id) }
    const w = delta.data as EditorWidget
    const idx = ews.findIndex(x => x.id === w.id)
    return { ...prev, editorWidgets: idx >= 0 ? ews.map((x, i) => (i === idx ? w : x)) : [...ews, w] }
  }

  if (delta.entity === 'browserWidget') {
    const bws = prev.browserWidgets
    if (delta.data === null) return { ...prev, browserWidgets: bws.filter(w => w.id !== delta.id) }
    const w = delta.data as BrowserWidget
    const idx = bws.findIndex(x => x.id === w.id)
    return { ...prev, browserWidgets: idx >= 0 ? bws.map((x, i) => (i === idx ? w : x)) : [...bws, w] }
  }

  if (delta.entity === 'imageWidget') {
    const iws = prev.imageWidgets
    if (delta.data === null) return { ...prev, imageWidgets: iws.filter(w => w.id !== delta.id) }
    const w = delta.data as ImageWidget
    const idx = iws.findIndex(x => x.id === w.id)
    return { ...prev, imageWidgets: idx >= 0 ? iws.map((x, i) => (i === idx ? w : x)) : [...iws, w] }
  }

  if (delta.entity === 'natsTrafficWidget') {
    const nws = prev.natsTrafficWidgets
    if (delta.data === null) return { ...prev, natsTrafficWidgets: nws.filter(w => w.id !== delta.id) }
    const w = delta.data as NatsTrafficWidget
    const idx = nws.findIndex(x => x.id === w.id)
    return { ...prev, natsTrafficWidgets: idx >= 0 ? nws.map((x, i) => (i === idx ? w : x)) : [...nws, w] }
  }

  if (delta.entity === 'topicMetadata') {
    const tms = prev.topicMetadata
    if (delta.data === null) return { ...prev, topicMetadata: tms.filter(m => m.subject !== delta.id) }
    const m = delta.data as TopicMetadata
    const idx = tms.findIndex(x => x.subject === m.subject)
    return { ...prev, topicMetadata: idx >= 0 ? tms.map((x, i) => (i === idx ? m : x)) : [...tms, m] }
  }

  if (delta.entity === 'pluginWidget') {
    const pws = prev.pluginWidgets
    if (delta.data === null) return { ...prev, pluginWidgets: pws.filter(w => w.id !== delta.id) }
    const w = delta.data as PluginWidgetInstance
    const idx = pws.findIndex(x => x.id === w.id)
    return { ...prev, pluginWidgets: idx >= 0 ? pws.map((x, i) => (i === idx ? w : x)) : [...pws, w] }
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
  if (entity === 'initiative') {
    const init = data as Initiative
    const exists = prev.initiatives.some(i => i.id === init.id)
    currentState = { ...prev, initiatives: exists ? prev.initiatives.map(i => i.id === init.id ? init : i) : [...prev.initiatives, init] }
  } else if (entity === 'epic') {
    const epic = data as Epic
    const exists = prev.epics.some(e => e.id === epic.id)
    currentState = { ...prev, epics: exists ? prev.epics.map(e => e.id === epic.id ? epic : e) : [...prev.epics, epic] }
  } else if (entity === 'task') {
    const task = data as Task
    const exists = prev.tasks.some(t => t.id === task.id)
    currentState = { ...prev, tasks: exists ? prev.tasks.map(t => t.id === task.id ? task : t) : [...prev.tasks, task] }
  } else if (entity === 'editorWidget') {
    const w = data as EditorWidget
    const exists = prev.editorWidgets.some(x => x.id === w.id)
    currentState = { ...prev, editorWidgets: exists ? prev.editorWidgets.map(x => x.id === w.id ? w : x) : [...prev.editorWidgets, w] }
  } else if (entity === 'browserWidget') {
    const w = data as BrowserWidget
    const exists = prev.browserWidgets.some(x => x.id === w.id)
    currentState = { ...prev, browserWidgets: exists ? prev.browserWidgets.map(x => x.id === w.id ? w : x) : [...prev.browserWidgets, w] }
  } else if (entity === 'imageWidget') {
    const w = data as ImageWidget
    const exists = prev.imageWidgets.some(x => x.id === w.id)
    currentState = { ...prev, imageWidgets: exists ? prev.imageWidgets.map(x => x.id === w.id ? w : x) : [...prev.imageWidgets, w] }
  } else if (entity === 'natsTrafficWidget') {
    const w = data as NatsTrafficWidget
    const exists = prev.natsTrafficWidgets.some(x => x.id === w.id)
    currentState = { ...prev, natsTrafficWidgets: exists ? prev.natsTrafficWidgets.map(x => x.id === w.id ? w : x) : [...prev.natsTrafficWidgets, w] }
  } else if (entity === 'pluginWidget') {
    const w = data as PluginWidgetInstance
    const exists = prev.pluginWidgets.some(x => x.id === w.id)
    currentState = { ...prev, pluginWidgets: exists ? prev.pluginWidgets.map(x => x.id === w.id ? w : x) : [...prev.pluginWidgets, w] }
  } else {
    return
  }
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

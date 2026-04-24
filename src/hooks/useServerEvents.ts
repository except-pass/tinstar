/* eslint-disable no-var */
declare global { var __TINSTAR_BACKEND_PORT__: string | undefined }

import { useSyncExternalStore, useCallback } from 'react'
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget, NatsTrafficWidget } from '../domain/types'

interface ServerState {
  activeSpaceId: string
  spaces: Space[]
  initiatives: Initiative[]
  epics: Epic[]
  tasks: Task[]
  worktrees: Worktree[]
  runs: Run[]
  editorWidgets: EditorWidget[]
  browserWidgets: BrowserWidget[]
  imageWidgets: ImageWidget[]
  natsTrafficWidgets: NatsTrafficWidget[]
  readyQueue: string[]
}

const EMPTY_STATE: ServerState = {
  activeSpaceId: '',
  spaces: [],
  initiatives: [],
  epics: [],
  tasks: [],
  worktrees: [],
  runs: [],
  editorWidgets: [],
  browserWidgets: [],
  imageWidgets: [],
  natsTrafficWidgets: [],
  readyQueue: [],
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

function startSSE() {
  if (es) return

  const sseUrl = import.meta.env.DEV && typeof __TINSTAR_BACKEND_PORT__ !== 'undefined'
    ? `http://${location.hostname}:${__TINSTAR_BACKEND_PORT__}/api/events`
    : '/api/events'

  es = new EventSource(sseUrl)

  es.addEventListener('snapshot', (e: MessageEvent) => {
    const snapshot = JSON.parse(e.data) as ServerState & { ready_queue?: string[] }
    currentState = { ...snapshot, readyQueue: snapshot.ready_queue ?? [] }
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
    window.dispatchEvent(new CustomEvent('tinstar:file_watch', { detail: JSON.parse(e.data) }))
  })

  es.addEventListener('nats_traffic', (e: MessageEvent) => {
    window.dispatchEvent(new CustomEvent('tinstar:nats_traffic', { detail: JSON.parse(e.data) }))
  })

  es.addEventListener('telemetry:hud', (e: MessageEvent) => {
    try {
      window.dispatchEvent(new CustomEvent('tinstar:telemetry:hud', { detail: JSON.parse(e.data) }))
    } catch {
      // malformed event — drop silently
    }
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
    return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [], editorWidgets: [], browserWidgets: [], imageWidgets: [] }
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
    if (delta.data === null) return { ...prev, runs: prev.runs.filter(r => r.id !== delta.id) }
    const run = delta.data as Run
    const exists = prev.runs.some(r => r.id === run.id)
    const mergeRun = (prevRun: Run | undefined, next: Run): Run => ({
      ...prevRun,
      ...next,
      touchedFiles: next.touchedFiles ?? prevRun?.touchedFiles ?? [],
      recapEntries: next.recapEntries ?? prevRun?.recapEntries ?? [],
    })
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

  if (delta.entity === 'commit') {
    window.dispatchEvent(new Event('tinstar:commit-delta'))
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

/* eslint-disable no-var */
declare global { var __TINSTAR_BACKEND_PORT__: string | undefined }

import { useState, useEffect, useRef, useCallback } from 'react'
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget } from '../domain/types'
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
  readyQueue: [],
}

export function useServerEvents(): {
  state: ServerState
  connected: boolean
  loading: boolean
  addOptimistic: (entity: string, data: unknown) => void
  disconnect: () => void
} {
  const [state, setState] = useState<ServerState>(EMPTY_STATE)
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const esRef = useRef<EventSource | null>(null)

  const addOptimistic = useCallback((entity: string, data: unknown) => {
    setState(prev => {
      if (entity === 'initiative') {
        const init = data as Initiative
        const exists = prev.initiatives.some(i => i.id === init.id)
        return { ...prev, initiatives: exists ? prev.initiatives.map(i => i.id === init.id ? init : i) : [...prev.initiatives, init] }
      }
      if (entity === 'epic') {
        const epic = data as Epic
        const exists = prev.epics.some(e => e.id === epic.id)
        return { ...prev, epics: exists ? prev.epics.map(e => e.id === epic.id ? epic : e) : [...prev.epics, epic] }
      }
      if (entity === 'task') {
        const task = data as Task
        const exists = prev.tasks.some(t => t.id === task.id)
        return { ...prev, tasks: exists ? prev.tasks.map(t => t.id === task.id ? task : t) : [...prev.tasks, task] }
      }
      if (entity === 'editorWidget') {
        const w = data as EditorWidget
        const exists = prev.editorWidgets.some(x => x.id === w.id)
        return { ...prev, editorWidgets: exists ? prev.editorWidgets.map(x => x.id === w.id ? w : x) : [...prev.editorWidgets, w] }
      }
      if (entity === 'browserWidget') {
        const w = data as BrowserWidget
        const exists = prev.browserWidgets.some(x => x.id === w.id)
        return { ...prev, browserWidgets: exists ? prev.browserWidgets.map(x => x.id === w.id ? w : x) : [...prev.browserWidgets, w] }
      }
      if (entity === 'imageWidget') {
        const w = data as ImageWidget
        const exists = prev.imageWidgets.some(x => x.id === w.id)
        return { ...prev, imageWidgets: exists ? prev.imageWidgets.map(x => x.id === w.id ? w : x) : [...prev.imageWidgets, w] }
      }
      return prev
    })
  }, [])

  useEffect(() => {
    // In dev mode, connect SSE directly to the backend to bypass the Vite proxy
    // (the proxy blocks other requests while an SSE connection is active)
    const sseUrl = import.meta.env.DEV && typeof __TINSTAR_BACKEND_PORT__ !== 'undefined'
      ? `http://${location.hostname}:${__TINSTAR_BACKEND_PORT__}/api/events`
      : '/api/events'
    const es = new EventSource(sseUrl)
    esRef.current = es

    es.addEventListener('snapshot', (e: MessageEvent) => {
      const snapshot = JSON.parse(e.data) as ServerState & { ready_queue?: string[] }
      setState({ ...snapshot, readyQueue: snapshot.ready_queue ?? [] })
      setLoading(false)
    })

    es.addEventListener('delta', (e: MessageEvent) => {
      const delta = JSON.parse(e.data) as {
        eventType: string
        entity: string
        id: string
        data: unknown
      }

      setState((prev) => {
        // If entity is 'all' and data is null, it's a clear
        if (delta.entity === 'all' && delta.data === null) {
          return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [], editorWidgets: [], browserWidgets: [], imageWidgets: [] }
        }

        if (delta.entity === 'space') {
          if (delta.data === null) {
            return { ...prev, spaces: prev.spaces.filter(s => s.id !== delta.id) }
          }
          const space = delta.data as Space
          const exists = prev.spaces.some(s => s.id === space.id)
          return {
            ...prev,
            spaces: exists
              ? prev.spaces.map(s => s.id === space.id ? space : s)
              : [...prev.spaces, space],
          }
        }

        if (delta.entity === 'initiative') {
          if (delta.data === null) {
            return { ...prev, initiatives: prev.initiatives.filter(i => i.id !== delta.id) }
          }
          const init = delta.data as Initiative
          const exists = prev.initiatives.some(i => i.id === init.id)
          return {
            ...prev,
            initiatives: exists
              ? prev.initiatives.map(i => i.id === init.id ? init : i)
              : [...prev.initiatives, init],
          }
        }

        if (delta.entity === 'epic') {
          if (delta.data === null) {
            return { ...prev, epics: prev.epics.filter(e => e.id !== delta.id) }
          }
          const epic = delta.data as Epic
          const exists = prev.epics.some(e => e.id === epic.id)
          return {
            ...prev,
            epics: exists
              ? prev.epics.map(e => e.id === epic.id ? epic : e)
              : [...prev.epics, epic],
          }
        }

        if (delta.entity === 'task') {
          if (delta.data === null) {
            return { ...prev, tasks: prev.tasks.filter(t => t.id !== delta.id) }
          }
          const task = delta.data as Task
          const exists = prev.tasks.some(t => t.id === task.id)
          return {
            ...prev,
            tasks: exists
              ? prev.tasks.map(t => t.id === task.id ? task : t)
              : [...prev.tasks, task],
          }
        }

        if (delta.entity === 'worktree') {
          if (delta.data === null) {
            return { ...prev, worktrees: prev.worktrees.filter(w => w.id !== delta.id) }
          }
          const wt = delta.data as Worktree
          const exists = prev.worktrees.some(w => w.id === wt.id)
          return {
            ...prev,
            worktrees: exists
              ? prev.worktrees.map(w => w.id === wt.id ? wt : w)
              : [...prev.worktrees, wt],
          }
        }

        if (delta.entity === 'run') {
          if (delta.data === null) {
            return { ...prev, runs: prev.runs.filter(r => r.id !== delta.id) }
          }
          const run = delta.data as Run
          const exists = prev.runs.some(r => r.id === run.id)
          return {
            ...prev,
            runs: exists
              ? prev.runs.map(r => r.id === run.id ? run : r)
              : [...prev.runs, run],
          }
        }

        if (delta.entity === 'editorWidget') {
          const ews = prev.editorWidgets
          if (delta.data === null) {
            return { ...prev, editorWidgets: ews.filter(w => w.id !== delta.id) }
          }
          const w = delta.data as EditorWidget
          const idx = ews.findIndex(x => x.id === w.id)
          return {
            ...prev,
            editorWidgets: idx >= 0 ? ews.map((x, i) => (i === idx ? w : x)) : [...ews, w],
          }
        }

        if (delta.entity === 'browserWidget') {
          const bws = prev.browserWidgets
          if (delta.data === null) {
            return { ...prev, browserWidgets: bws.filter(w => w.id !== delta.id) }
          }
          const w = delta.data as BrowserWidget
          const idx = bws.findIndex(x => x.id === w.id)
          return {
            ...prev,
            browserWidgets: idx >= 0 ? bws.map((x, i) => (i === idx ? w : x)) : [...bws, w],
          }
        }

        if (delta.entity === 'imageWidget') {
          const iws = prev.imageWidgets
          if (delta.data === null) {
            return { ...prev, imageWidgets: iws.filter(w => w.id !== delta.id) }
          }
          const w = delta.data as ImageWidget
          const idx = iws.findIndex(x => x.id === w.id)
          return {
            ...prev,
            imageWidgets: idx >= 0 ? iws.map((x, i) => (i === idx ? w : x)) : [...iws, w],
          }
        }

        if (delta.entity === 'commit') {
          // Commits are fetched on-demand by CommitActivityPanel; just notify it to refresh
          window.dispatchEvent(new Event('tinstar:commit-delta'))
          return prev
        }

        return prev
      })
    })

    es.addEventListener('heartbeat', () => {
      // Keep-alive, no action needed
    })

    es.addEventListener('ready_queue_update', (e: MessageEvent) => {
      const { queue } = JSON.parse(e.data) as { queue: string[] }
      setState(prev => ({ ...prev, readyQueue: queue }))
    })

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)

    // Close SSE before page unload so the proxy can clean up the connection
    // (prevents Vite dev proxy from hanging on page refresh)
    const onBeforeUnload = () => es.close()
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      es.close()
      esRef.current = null
    }
  }, [])

  const disconnect = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
  }, [])

  return { state, connected, loading, addOptimistic, disconnect }
}

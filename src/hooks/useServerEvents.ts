import { useState, useEffect, useRef } from 'react'
import type { Initiative, Epic, Task, Worktree, Run, Space } from '../domain/types'

interface ServerState {
  activeSpaceId: string
  spaces: Space[]
  initiatives: Initiative[]
  epics: Epic[]
  tasks: Task[]
  worktrees: Worktree[]
  runs: Run[]
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
  readyQueue: [],
}

export function useServerEvents(): {
  state: ServerState
  connected: boolean
  loading: boolean
} {
  const [state, setState] = useState<ServerState>(EMPTY_STATE)
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/events')
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
          return { ...prev, initiatives: [], epics: [], tasks: [], worktrees: [], runs: [] }
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

    return () => {
      es.close()
      esRef.current = null
    }
  }, [])

  return { state, connected, loading }
}

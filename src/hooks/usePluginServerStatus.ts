import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'

export interface PluginServerStatus {
  status: 'up' | 'down' | 'unknown'
  startable: boolean
  checkedAt: number
  /** 'server' = a plugin-declared server block (start/log popover); 'nats' = the
   *  Saloon's host NATS broker light (informational). Defaults to 'server'. */
  kind?: 'server' | 'nats'
}

const SLOW_POLL_MS = 5000
const FAST_POLL_MS = 1500
const FAST_WINDOW_MS = 30_000

type StatusMap = Record<string, PluginServerStatus>

/** Polls /api/plugin-servers/status while mounted. After start(), polls fast
 *  (~1.5s) for up to 30s so the dot flips green quickly, then returns to ~5s. */
export function usePluginServerStatus(): {
  statuses: StatusMap
  start: (pluginId: string) => Promise<void>
} {
  const [statuses, setStatuses] = useState<StatusMap>({})
  const fastUntilRef = useRef(0)

  const refetch = useCallback(async () => {
    try {
      const r = await apiFetch('/api/plugin-servers/status')
      const j = (await r.json()) as { ok: boolean; data?: StatusMap }
      if (j.ok && j.data) setStatuses(j.data)
    } catch { /* transient; next tick retries */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (cancelled) return
      await refetch()
      if (cancelled) return
      const fast = Date.now() < fastUntilRef.current
      timer = setTimeout(tick, fast ? FAST_POLL_MS : SLOW_POLL_MS)
    }
    void tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [refetch])

  const start = useCallback(async (pluginId: string) => {
    setStatuses((prev) => ({
      ...prev,
      [pluginId]: { ...(prev[pluginId] ?? { startable: true, checkedAt: 0 }), status: 'unknown' },
    }))
    fastUntilRef.current = Date.now() + FAST_WINDOW_MS
    try { await apiFetch(`/api/plugin-servers/${pluginId}/start`, { method: 'POST' }) } catch { /* surfaced via log */ }
    await refetch()
  }, [refetch])

  return { statuses, start }
}

import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { PluginServerStatus } from './usePluginServerStatus'

const POLL_MS = 5000

/** Host NATS broker reachability, shaped as a PluginServerStatus so the Saloon's
 *  palette tile renders the same health dot as server-backed plugins. Returns
 *  null until the first probe resolves (tile shows no dot meanwhile). */
export function useNatsBrokerStatus(): PluginServerStatus | null {
  const [status, setStatus] = useState<PluginServerStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (cancelled) return
      try {
        const r = await apiFetch('/api/nats-traffic/status')
        // The route only ever emits 'up' | 'down' (NatsTrafficBridge.brokerConnection);
        // don't type a 'degraded' state the producer can't send.
        const j = (await r.json()) as { ok: boolean; data?: { connection: 'up' | 'down' } }
        if (!cancelled && j.ok && j.data) {
          setStatus({ status: j.data.connection === 'up' ? 'up' : 'down', startable: false, kind: 'nats', checkedAt: Date.now() })
        }
      } catch { /* transient; next tick retries */ }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  return status
}

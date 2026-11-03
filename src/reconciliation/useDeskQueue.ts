import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { DeskQueue } from '../shared/reconciliationQueue'

export function useDeskQueue() {
  const [queue, setQueue] = useState<DeskQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, pending: AbortController | null = null
    async function read() {
      pending = new AbortController()
      const deadline = setTimeout(() => pending?.abort(), 60_000)
      try {
        const res = await apiFetch('/api/reconciliation/queue', { signal: pending.signal })
        const body = await res.json()
        if (!res.ok || !body.ok || !Array.isArray(body.data?.items)) throw new Error('queue unavailable')
        if (!stopped) { setQueue(body.data); setError(null) }
      } catch { if (!stopped) setError('Queue source unavailable; retained items are last-known. Readiness requires verification.') }
      finally { clearTimeout(deadline); if (!stopped) timer = setTimeout(() => void read(), 20_000) }
    }
    void read()
    return () => { stopped = true; clearTimeout(timer); pending?.abort() }
  }, [])
  return { queue, error }
}

import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import { WORKFLOW_SAVED } from './workflowSaved'
import type { DeskQueue } from '../shared/reconciliationQueue'

export function useDeskQueue() {
  const [queue, setQueue] = useState<DeskQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, pending: AbortController | null = null
    async function read() {
      clearTimeout(timer)
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      const deadline = setTimeout(() => controller.abort(), 60_000)
      try {
        const res = await apiFetch('/api/reconciliation/queue', { signal: controller.signal, headers: { 'X-Tinstar-UI': '1' } })
        const body = await res.json()
        if (!res.ok || !body.ok || !Array.isArray(body.data?.items)) throw new Error('queue unavailable')
        if (!stopped && pending === controller) { setQueue(body.data); setError(null) }
      } catch { if (!stopped && pending === controller) setError('Queue source unavailable; retained items are last-known. Readiness requires verification.') }
      finally { clearTimeout(deadline); if (!stopped && pending === controller) timer = setTimeout(() => void read(), 20_000) }
    }
    const refresh = () => { void read() }
    window.addEventListener(WORKFLOW_SAVED, refresh)
    void read()
    return () => { window.removeEventListener(WORKFLOW_SAVED, refresh); stopped = true; clearTimeout(timer); pending?.abort() }
  }, [])
  return { queue, error }
}

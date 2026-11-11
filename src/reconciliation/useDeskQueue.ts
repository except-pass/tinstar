import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import { WORKFLOW_SAVED } from './workflowSaved'
import type { ReviewQueueRead } from '../shared/reviews'
import type { DeskQueue } from '../shared/reconciliationQueue'

export const useDeskQueue = () => useQueueRead<DeskQueue>(false)
export const useReviewQueue = () => useQueueRead<ReviewQueueRead>(true)

function useQueueRead<T extends DeskQueue | ReviewQueueRead>(reviewsOnly: boolean) {
  const [queue, setQueue] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, pending: AbortController | null = null
    async function read(force = false) {
      clearTimeout(timer)
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      const deadline = setTimeout(() => controller.abort(), 60_000)
      try {
        const res = await apiFetch(`/api/reconciliation/queue${reviewsOnly ? `?view=reviews${force ? '&refresh=1' : ''}` : ''}`, { signal: controller.signal, headers: { 'X-Tinstar-UI': '1' } })
        const body = await res.json()
        if (!res.ok || !body.ok || !Array.isArray(reviewsOnly ? body.data?.reviews?.items : body.data?.items)) throw new Error('queue unavailable')
        if (!stopped && pending === controller) { setQueue(body.data); setError(null) }
      } catch { if (!stopped && pending === controller) setError('Queue source unavailable; retained items are last-known. Readiness requires verification.') }
      finally { clearTimeout(deadline); if (!stopped && pending === controller) timer = setTimeout(() => void read(), 20_000) }
    }
    const refresh = () => { void read(true) }
    window.addEventListener(WORKFLOW_SAVED, refresh)
    void read()
    return () => { window.removeEventListener(WORKFLOW_SAVED, refresh); stopped = true; clearTimeout(timer); pending?.abort() }
  }, [reviewsOnly])
  return { queue, error }
}

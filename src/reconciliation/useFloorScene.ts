import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { FloorScene } from './presentation'
import { SmartSearchIndex, updateSearchIndex } from '../shared/smartSearch'
import { completeSceneSources } from './sceneFreshness'

const refreshInterval = 30_000
const readFailure = 'Scene read unavailable. Last-known records are retained; absence conclusions are suspended.'
/** One sequential read for polling, focus, manual refresh and acknowledged card
 * mutations. Publish the entire scene at once; classifications/counts derive from it. */
export function useFloorScene(active = true, history = false) {
  const search = useRef<SmartSearchIndex>()
  if (!search.current) search.current = new SmartSearchIndex()
  const activeView = useRef(active)
  activeView.current = active
  const [read, setRead] = useState<{ scene: FloorScene | null; error: string | null; refreshing: boolean; lastSuccessfulSyncAt: string | null }>({ scene: null, error: null, refreshing: false, lastSuccessfulSyncAt: null })
  const [now, setNow] = useState(Date.now)
  const reader = useRef<(force: boolean, mutated?: boolean) => Promise<void>>()
  const refresh = useCallback(() => reader.current?.(true) ?? Promise.resolve(), [])
  // Call after a confirmed card change. A response already in flight predates
  // that change and must be discarded before a forced follow-up read publishes.
  const refreshAfterMutation = useCallback(() => reader.current?.(true, true) ?? Promise.resolve(), [])
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, lastAttempt = 0, revision = 0, again = false
    let pending: Promise<void> | null = null, controller: AbortController | null = null
    const schedule = () => {
      clearTimeout(timer)
      if (!stopped) timer = setTimeout(() => {
        if (activeView.current && document.visibilityState !== 'hidden') void readScene(false)
        else schedule()
      }, refreshInterval)
    }
    function readScene(force: boolean, mutated = false): Promise<void> {
      if (stopped) return Promise.resolve()
      if (mutated) { revision++; again = true }
      if (pending) return pending
      clearTimeout(timer)
      setRead(current => ({ ...current, refreshing: true }))
      pending = (async () => {
        do {
          const expected = revision
          again = false
          lastAttempt = Date.now()
          controller = new AbortController()
          const deadline = setTimeout(() => controller?.abort(), 60_000)
          try {
            const response = await apiFetch(`/api/reconciliation/scene${force || history ? `?${new URLSearchParams({ ...(force ? { refresh: '1' } : {}), ...(history ? { history: '1' } : {}) })}` : ''}`, { signal: controller.signal })
            if (!response.ok) throw new Error('read failed')
            const body = await response.json() as { ok: boolean; data?: FloorScene }
            if (!body.ok || !body.data) throw new Error('scene missing')
            if (!stopped && expected === revision) {
              const scene = body.data, at = Date.now()
              updateSearchIndex(scene, search.current!)
              setRead(current => ({ ...current, scene, error: null, lastSuccessfulSyncAt: completeSceneSources(scene, at) ? scene.coverage.intentions.observedAt : current.lastSuccessfulSyncAt }))
              setNow(at)
            }
          } catch {
            if (!stopped && expected === revision) setRead(current => ({ ...current, scene: current.scene ? { ...current.scene, searchReadFailed: true } : null, error: readFailure }))
          } finally { clearTimeout(deadline) }
          // Wait for the previous request to finish before forcing a read: the
          // backend's shared source read may still be running after client abort.
          force = true
        } while (again && !stopped)
      })().finally(() => {
        pending = null; controller = null
        if (!stopped) { setRead(current => ({ ...current, refreshing: false })); schedule() }
      })
      return pending
    }
    reader.current = readScene
    const focus = () => { if (activeView.current && document.visibilityState !== 'hidden' && Date.now() - lastAttempt >= refreshInterval) void readScene(true) }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    void readScene(false)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => { stopped = true; reader.current = undefined; clearTimeout(timer); clearInterval(clock); controller?.abort(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [history])
  return { ...read, now, refresh, refreshAfterMutation }
}

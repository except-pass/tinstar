import { useEffect, useRef } from 'react'
import { apiFetch } from '../apiClient'

let nextId = 0

export interface ResourceWatchCallbacks {
  onSubscribed(absolutePath: string, data: Record<string, unknown>): void
  onSubscribeFailed(): void
  onCleanup?(): void
}

export function useResourceWatch(
  sessionId: string,
  filePath: string,
  mode: 'content' | 'notify',
  prefix: string,
  callbacks: ResourceWatchCallbacks,
): { absolutePathRef: React.RefObject<string | null> } {
  const absolutePathRef = useRef<string | null>(null)
  const subscriberIdRef = useRef(`${prefix}-${nextId++}`)

  const { onSubscribed, onSubscribeFailed, onCleanup } = callbacks

  useEffect(() => {
    const subscriberId = subscriberIdRef.current
    let cancelled = false

    apiFetch('/api/file-watch/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, filePath, subscriberId, mode }),
    })
      .then(r => r.json())
      .then((body: { ok?: boolean; data?: Record<string, unknown> & { absolutePath?: string } }) => {
        if (cancelled) return
        if (body.ok && body.data?.absolutePath) {
          absolutePathRef.current = body.data.absolutePath
          onSubscribed(body.data.absolutePath, body.data)
        }
      })
      .catch(() => {
        if (!cancelled) onSubscribeFailed()
      })

    return () => {
      cancelled = true
      onCleanup?.()
      const absPath = absolutePathRef.current
      if (absPath) {
        apiFetch('/api/file-watch/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ absolutePath: absPath, subscriberId }),
        }).catch((err) => { console.warn(`[${prefix}] unsubscribe failed:`, (err as Error).message) })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, filePath])

  return { absolutePathRef }
}

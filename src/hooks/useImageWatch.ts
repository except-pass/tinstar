import { useEffect, useState, useRef } from 'react'
import { apiFetch } from '../apiClient'
import { useWindowEvent } from '../lib/windowEvents'

interface ImageWatchState {
  connected: boolean
  lastUpdatedAt: Date | null
}

let nextId = 0

export function useImageWatch(sessionId: string, filePath: string): ImageWatchState {
  const [connected, setConnected] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const absolutePathRef = useRef<string | null>(null)
  const subscriberIdRef = useRef(`image-watch-${nextId++}`)

  useEffect(() => {
    const subscriberId = subscriberIdRef.current
    let cancelled = false

    apiFetch('/api/file-watch/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, filePath, subscriberId, mode: 'notify' }),
    })
      .then(r => r.json())
      .then((body: { ok?: boolean; data?: { absolutePath?: string } }) => {
        if (cancelled) return
        if (body.ok && body.data?.absolutePath) {
          absolutePathRef.current = body.data.absolutePath
          setConnected(true)
        }
      })
      .catch(() => {
        if (!cancelled) setConnected(false)
      })

    return () => {
      cancelled = true
      setConnected(false)
      const absPath = absolutePathRef.current
      if (absPath) {
        apiFetch('/api/file-watch/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ absolutePath: absPath, subscriberId }),
        }).catch(() => {})
      }
    }
  }, [sessionId, filePath])

  useWindowEvent('tinstar:file_watch', (detail) => {
    const d = detail as { path: string; type: string; timestamp?: number } | undefined
    if (!d) return
    if (d.path === absolutePathRef.current && d.type === 'updated' && d.timestamp) {
      setLastUpdatedAt(new Date(d.timestamp))
    }
  })

  return { connected, lastUpdatedAt }
}

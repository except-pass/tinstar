import { useEffect, useState, useRef } from 'react'

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

    fetch('/api/file-watch/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, filePath, subscriberId, mode: 'notify' }),
    })
      .then(r => r.json())
      .then((data: { ok?: boolean; absolutePath?: string }) => {
        if (cancelled) return
        if (data.ok && data.absolutePath) {
          absolutePathRef.current = data.absolutePath
          setConnected(true)
        }
      })
      .catch(() => {
        if (!cancelled) setConnected(false)
      })

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path: string; type: string; timestamp?: number }
      if (detail.path === absolutePathRef.current && detail.type === 'updated' && detail.timestamp) {
        setLastUpdatedAt(new Date(detail.timestamp))
      }
    }
    window.addEventListener('tinstar:file_watch', handler)

    return () => {
      cancelled = true
      window.removeEventListener('tinstar:file_watch', handler)
      setConnected(false)
      const absPath = absolutePathRef.current
      if (absPath) {
        fetch('/api/file-watch/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ absolutePath: absPath, subscriberId }),
        }).catch(() => {})
      }
    }
  }, [sessionId, filePath])

  return { connected, lastUpdatedAt }
}

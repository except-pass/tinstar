import { useEffect, useState, useRef } from 'react'
import { apiFetch } from '../apiClient'

interface FileWatchState {
  content: string | null
  connected: boolean
  lastUpdatedAt: Date | null
}

let nextId = 0

export function useFileWatch(sessionId: string, filePath: string): FileWatchState {
  const [content, setContent] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const absolutePathRef = useRef<string | null>(null)
  const subscriberIdRef = useRef(`file-watch-${nextId++}`)

  useEffect(() => {
    const subscriberId = subscriberIdRef.current
    let cancelled = false

    apiFetch('/api/file-watch/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, filePath, subscriberId, mode: 'content' }),
    })
      .then(r => r.json())
      .then((data: { ok?: boolean; absolutePath?: string; content?: string }) => {
        if (cancelled) return
        if (data.ok && data.absolutePath) {
          absolutePathRef.current = data.absolutePath
          setConnected(true)
          if (data.content !== undefined) {
            setContent(data.content)
            setLastUpdatedAt(new Date())
          }
        }
      })
      .catch(() => {
        if (!cancelled) setConnected(false)
      })

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path: string; type: string; data?: string }
      if (detail.path !== absolutePathRef.current) return
      if (detail.type === 'content' && detail.data !== undefined) {
        setContent(detail.data)
        setConnected(true)
        setLastUpdatedAt(new Date())
      } else if (detail.type === 'error') {
        setConnected(false)
      }
    }
    window.addEventListener('tinstar:file_watch', handler)

    return () => {
      cancelled = true
      window.removeEventListener('tinstar:file_watch', handler)
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

  return { content, connected, lastUpdatedAt }
}

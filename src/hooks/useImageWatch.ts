import { useEffect, useState } from 'react'

interface ImageWatchState {
  connected: boolean
  lastUpdatedAt: Date | null
}

export function useImageWatch(sessionId: string, filePath: string): ImageWatchState {
  const [connected, setConnected] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)

  useEffect(() => {
    const url = `/api/image-watch?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`
    const es = new EventSource(url)

    es.onopen = () => {
      setConnected(true)
    }

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; timestamp?: number }
        if (msg.type === 'updated' && msg.timestamp) {
          setLastUpdatedAt(new Date(msg.timestamp))
        }
      } catch {
        // ignore malformed
      }
    }

    es.onerror = () => {
      setConnected(false)
    }

    return () => {
      setConnected(false)
      es.close()
    }
  }, [sessionId, filePath])

  return { connected, lastUpdatedAt }
}

import { useEffect, useState } from 'react'

interface FileWatchState {
  content: string | null
  connected: boolean
  lastUpdatedAt: Date | null
}

export function useFileWatch(sessionId: string, filePath: string): FileWatchState {
  const [content, setContent] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)

  useEffect(() => {
    const url = `/api/file-watch?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`
    const es = new EventSource(url)

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; data: string }
        if (msg.type === 'content') {
          setContent(msg.data)
          setConnected(true)
          setLastUpdatedAt(new Date())
        } else if (msg.type === 'error') {
          setConnected(false)
        }
      } catch {
        // ignore malformed
      }
    }

    es.onerror = () => {
      setConnected(false)
    }

    return () => {
      es.close()
    }
  }, [sessionId, filePath])

  return { content, connected, lastUpdatedAt }
}

import { useState, useCallback } from 'react'
import { useWindowEvent } from '../lib/windowEvents'
import { useResourceWatch } from './useResourceWatch'

interface FileWatchState {
  content: string | null
  connected: boolean
  lastUpdatedAt: Date | null
}

export function useFileWatch(sessionId: string, filePath: string): FileWatchState {
  const [content, setContent] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)

  const onSubscribed = useCallback((_absPath: string, data: Record<string, unknown>) => {
    setConnected(true)
    if (data.content !== undefined) {
      setContent(data.content as string)
      setLastUpdatedAt(new Date())
    }
  }, [])

  const onSubscribeFailed = useCallback(() => { setConnected(false) }, [])

  const { absolutePathRef } = useResourceWatch(sessionId, filePath, 'content', 'file-watch', {
    onSubscribed,
    onSubscribeFailed,
  })

  useWindowEvent('tinstar:file_watch', (detail) => {
    const d = detail as { path: string; type: string; data?: string } | undefined
    if (!d || d.path !== absolutePathRef.current) return
    if (d.type === 'content' && d.data !== undefined) {
      setContent(d.data)
      setConnected(true)
      setLastUpdatedAt(new Date())
    } else if (d.type === 'error') {
      setConnected(false)
    }
  })

  return { content, connected, lastUpdatedAt }
}

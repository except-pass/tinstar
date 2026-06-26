import { useState, useCallback } from 'react'
import { useWindowEvent } from '../lib/windowEvents'
import { useResourceWatch } from './useResourceWatch'

interface ImageWatchState {
  connected: boolean
  lastUpdatedAt: Date | null
}

export function useImageWatch(sessionId: string, filePath: string): ImageWatchState {
  const [connected, setConnected] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)

  const onSubscribed = useCallback(() => { setConnected(true) }, [])
  const onSubscribeFailed = useCallback(() => { setConnected(false) }, [])
  const onCleanup = useCallback(() => { setConnected(false) }, [])

  const { absolutePathRef } = useResourceWatch(sessionId, filePath, 'notify', 'image-watch', {
    onSubscribed,
    onSubscribeFailed,
    onCleanup,
  })

  useWindowEvent('tinstar:file_watch', (detail) => {
    const d = detail as { path: string; type: string; timestamp?: number } | undefined
    if (!d) return
    if (d.path === absolutePathRef.current && d.type === 'updated' && d.timestamp) {
      setLastUpdatedAt(new Date(d.timestamp))
    }
  })

  return { connected, lastUpdatedAt }
}

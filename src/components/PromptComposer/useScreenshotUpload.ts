import { useCallback, useEffect, useRef, useState } from 'react'

export type TileStatus = 'pending' | 'ready' | 'error'

export interface Tile {
  clientId: string
  previewUrl: string // blob URL for client-side preview
  status: TileStatus
  path?: string // absolute path on disk, populated on 'ready'
  errorMessage?: string
}

interface Envelope<T> {
  data?: T
  error?: { code: string; message: string }
}

let counter = 0
function nextClientId(): string {
  counter += 1
  return `screenshot-${Date.now()}-${counter}`
}

export interface UseScreenshotUploadReturn {
  tiles: Tile[]
  pendingCount: number
  /**
   * Upload a blob. Returns a promise that resolves to the absolute server path
   * on success, or rejects on failure (tile is marked 'error' either way).
   */
  startUpload(file: File): Promise<string>
  /** Remove a tile from the gallery (does not delete the file on disk). */
  removeTile(clientId: string): void
  /** Revoke all blob URLs and clear the tile list (call after successful submit). */
  clearAll(): void
}

export function useScreenshotUpload(): UseScreenshotUploadReturn {
  const [tiles, setTiles] = useState<Tile[]>([])
  // Track blob URLs so we can revoke on remove
  const blobUrlsRef = useRef<Map<string, string>>(new Map())

  // Revoke any remaining blob URLs when the component unmounts
  useEffect(() => {
    const urls = blobUrlsRef.current
    return () => {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url)
      }
      urls.clear()
    }
  }, [])

  const startUpload = useCallback(async (file: File): Promise<string> => {
    const clientId = nextClientId()
    const previewUrl = URL.createObjectURL(file)
    blobUrlsRef.current.set(clientId, previewUrl)
    setTiles(prev => [...prev, { clientId, previewUrl, status: 'pending' }])

    const form = new FormData()
    form.append('file', file)

    try {
      const res = await fetch('/api/screenshots', { method: 'POST', body: form })
      const body = (await res.json()) as Envelope<{ path: string }>
      if (!res.ok || body.error) {
        const message = body.error?.message ?? `HTTP ${res.status}`
        setTiles(prev => prev.map(t =>
          t.clientId === clientId ? { ...t, status: 'error', errorMessage: message } : t,
        ))
        throw new Error(message)
      }
      const path = body.data!.path
      setTiles(prev => prev.map(t =>
        t.clientId === clientId ? { ...t, status: 'ready', path } : t,
      ))
      return path
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTiles(prev => prev.map(t =>
        t.clientId === clientId && t.status !== 'error'
          ? { ...t, status: 'error', errorMessage: message }
          : t,
      ))
      throw err
    }
  }, [])

  const removeTile = useCallback((clientId: string) => {
    const url = blobUrlsRef.current.get(clientId)
    if (url) {
      URL.revokeObjectURL(url)
      blobUrlsRef.current.delete(clientId)
    }
    setTiles(prev => prev.filter(t => t.clientId !== clientId))
  }, [])

  const clearAll = useCallback(() => {
    for (const url of blobUrlsRef.current.values()) {
      URL.revokeObjectURL(url)
    }
    blobUrlsRef.current.clear()
    setTiles([])
  }, [])

  const pendingCount = tiles.filter(t => t.status === 'pending').length

  return { tiles, pendingCount, startUpload, removeTile, clearAll }
}

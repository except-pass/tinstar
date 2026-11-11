import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { ReleasesRead } from '../shared/releases'

/** One app-wide sequential observation also supplies the unique-PR navigation badge. */
export function useReleases() {
  const [data, setData] = useState<ReleasesRead | null>(null), [error, setError] = useState<string | null>(null)
  const refreshRef = useRef<(tag?: string) => void>(() => {})
  const tagRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, pending: AbortController | null = null
    async function read() {
      if (pending || stopped) return
      pending = new AbortController()
      const deadline = setTimeout(() => pending?.abort(), 60_000)
      try {
        const res = await apiFetch(`/api/releases${tagRef.current ? `?tag=${encodeURIComponent(tagRef.current)}` : ''}`, { signal: pending.signal }), body = await res.json()
        if (!res.ok || !body.ok || !Array.isArray(body.data?.pulls)) throw new Error('Release observation unavailable')
        if (!stopped) { setData(body.data); setError(null) }
      } catch { if (!stopped) setError('Release sources unavailable. Retained records are last known; deployment remains unknown.') }
      finally { clearTimeout(deadline); pending = null; if (!stopped) timer = setTimeout(() => void read(), 20_000) }
    }
    refreshRef.current = tag => { tagRef.current = tag; clearTimeout(timer); void read() }
    void read()
    return () => { stopped = true; clearTimeout(timer); pending?.abort() }
  }, [])
  return { data, error, refresh: useCallback((tag?: string) => refreshRef.current(tag), []) }
}

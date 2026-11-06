import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { PullsRead } from '../shared/pulls'

export function usePulls() {
  const [data, setData] = useState<PullsRead | null>(null), [error, setError] = useState<string | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    let stopped = false, pending: AbortController | null = null, timer: ReturnType<typeof setTimeout>
    async function read() {
      if (pending || stopped) return
      pending = new AbortController()
      const deadline = setTimeout(() => pending?.abort(), 90_000)
      try {
        const response = await apiFetch('/api/pulls', { signal: pending.signal }), body = await response.json()
        if (!response.ok || !body.ok || !Array.isArray(body.data?.pulls)) throw new Error(body.error?.message ?? 'PR inventory unavailable.')
        if (!stopped) { setData(body.data); setError(null) }
      } catch (error) { if (!stopped) setError((error as Error).name === 'AbortError' ? 'PR inventory timed out. Retry after checking GitHub access.' : (error as Error).message) }
      finally { clearTimeout(deadline); pending = null; if (!stopped) timer = setTimeout(() => void read(), 60_000) }
    }
    refreshRef.current = () => { clearTimeout(timer); void read() }
    void read()
    return () => { stopped = true; clearTimeout(timer); pending?.abort() }
  }, [])
  return { data, error, refresh: useCallback(() => refreshRef.current(), []) }
}

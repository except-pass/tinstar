import { useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { FloorScene } from './presentation'

/** Sequential, bounded polling. A failure retains the labeled last-known scene. */
export function useFloorScene() {
  const [scene, setScene] = useState<FloorScene | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let pending: AbortController | null = null
    async function read() {
      pending = new AbortController()
      const deadline = setTimeout(() => pending?.abort(), 60_000)
      try {
        const response = await apiFetch('/api/reconciliation/scene', { signal: pending.signal })
        if (!response.ok) throw new Error('read failed')
        const body = await response.json() as { ok: boolean; data?: FloorScene }
        if (!body.ok || !body.data) throw new Error('scene missing')
        if (!stopped) { setScene(body.data); setError(null); setNow(Date.now()) }
      } catch {
        if (!stopped) setError('Scene read unavailable. Last-known records are retained; absence conclusions are suspended.')
      } finally {
        clearTimeout(deadline)
        if (!stopped) timer = setTimeout(() => void read(), 20_000)
      }
    }
    void read()
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => { stopped = true; clearTimeout(timer); clearInterval(clock); pending?.abort() }
  }, [])
  return { scene, error, now }
}

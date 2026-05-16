import { useEffect, useRef, useState } from 'react'
import { apiUrl } from '../apiClient'

export function useBackendReachable(): boolean {
  const [reachable, setReachable] = useState<boolean>(false)
  const cancelRef = useRef(false)

  useEffect(() => {
    cancelRef.current = false
    let delay = 1000
    let timer: ReturnType<typeof setTimeout> | null = null

    const probe = async () => {
      if (cancelRef.current) return
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 3000)
        const res = await fetch(apiUrl('/api/state'), { signal: ctrl.signal })
        clearTimeout(t)
        if (cancelRef.current) return
        if (res.ok) {
          setReachable(true)
          return
        }
      } catch {
        if (cancelRef.current) return
      }
      setReachable(false)
      delay = Math.min(delay * 2, 30000)
      timer = setTimeout(probe, delay)
    }
    probe()

    return () => {
      cancelRef.current = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return reachable
}

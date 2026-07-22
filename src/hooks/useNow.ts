import { useEffect, useState } from 'react'

/** Current epoch millis, re-rendered every `intervalMs` (default 30s) so relative
 *  timestamps ("3m ago") tick forward on their own without a manual refresh. One
 *  ticking clock per consumer that then feeds many child timestamps keeps them in
 *  agreement and avoids a timer per row. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

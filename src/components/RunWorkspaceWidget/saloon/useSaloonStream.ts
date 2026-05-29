import { useEffect, useRef, useState } from 'react'
import { subjectMatches } from './subjectMatches'
import { EV } from '../../../lib/windowEvents'

export interface SaloonEvent {
  timestamp: string
  subject: string
  data: string
  direction: 'inbound' | 'outbound'
  sender?: string
}

const MAX_EVENTS = 200

interface Options {
  subscriptions: string[]
}

export function useSaloonStream({ subscriptions }: Options): SaloonEvent[] {
  const [events, setEvents] = useState<SaloonEvent[]>([])
  const subsRef = useRef(subscriptions)
  subsRef.current = subscriptions

  const batchRef = useRef<SaloonEvent[]>([])
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const flush = () => {
      rafRef.current = null
      const batch = batchRef.current
      batchRef.current = []
      if (batch.length === 0) return
      setEvents(prev => {
        const next = [...prev, ...batch]
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
      })
    }

    const handler = (e: Event) => {
      const event = (e as CustomEvent).detail as SaloonEvent
      if (!subsRef.current.some(pattern => subjectMatches(event.subject, pattern))) return
      batchRef.current.push(event)
      if (rafRef.current === null) {
        // rAF may be unavailable in fake-timer envs — fall back to setTimeout(0)
        rafRef.current = (typeof requestAnimationFrame === 'function')
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 0) as unknown as number)
      }
    }

    window.addEventListener(EV.natsTraffic, handler)
    return () => {
      window.removeEventListener(EV.natsTraffic, handler)
      if (rafRef.current !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafRef.current)
        else clearTimeout(rafRef.current)
      }
      batchRef.current = []
    }
  }, [])

  return events
}

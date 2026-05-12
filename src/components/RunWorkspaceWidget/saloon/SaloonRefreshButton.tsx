import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  sessionName: string
  natsControlOrphanedAt: string | null
}

type Mode = 'idle' | 'inFlight' | 'permaDisabled'

const IDLE_TITLE_HEALTHY = 'Reconnect Saloon observer'
const IDLE_TITLE_ORPHANED = 'Reconnect Saloon — session is orphaned'
const IN_FLIGHT_TITLE = 'Reconnecting…'

export function SaloonRefreshButton({ sessionName, natsControlOrphanedAt }: Props) {
  const [mode, setMode] = useState<Mode>('idle')
  const [errorTitle, setErrorTitle] = useState<string | null>(null)
  // Reserved for Task 5 — orphan-restart popover state lives here.
  void sessionName

  // Fix 1: ref-guarded in-flight check — prevents two clicks that race before
  // React re-renders from both firing.
  const acceptingClicksRef = useRef(true)

  // Fix 2: track the error-clear timer so we can cancel it on unmount and
  // before scheduling a new one.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const baseTitle = natsControlOrphanedAt ? IDLE_TITLE_ORPHANED : IDLE_TITLE_HEALTHY
  const title = mode === 'inFlight'
    ? IN_FLIGHT_TITLE
    : (errorTitle ?? baseTitle)

  const onClick = useCallback(async () => {
    if (!acceptingClicksRef.current) return
    acceptingClicksRef.current = false
    setMode('inFlight')
    setErrorTitle(null)
    try {
      const res = await fetch('/api/nats-traffic/bounce', { method: 'POST' })
      if (res.status === 503) {
        const body = await res.json().catch(() => ({}))
        setErrorTitle(body?.error?.message ?? 'NATS bridge is disabled in tinstar config')
        setMode('permaDisabled')
        // permaDisabled: leave acceptingClicksRef false permanently
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // Fix 3: non-Error throw guard applied uniformly
        const msg = body?.error?.message ?? 'unknown error'
        setErrorTitle(`Refresh failed: ${msg}`)
        setMode('idle')
        acceptingClicksRef.current = true
        // Clear the error after 4s, matching the spec.
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setErrorTitle(null), 4000)
        return
      }
      setMode('idle')
      acceptingClicksRef.current = true
    } catch (err) {
      // Fix 3: guard against non-Error throws
      const msg = err instanceof Error ? err.message : String(err)
      setErrorTitle(`Refresh failed: ${msg}`)
      setMode('idle')
      acceptingClicksRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setErrorTitle(null), 4000)
    }
  }, [])

  const disabled = mode !== 'idle'
  const iconName = mode === 'inFlight' ? 'progress_activity' : 'refresh'
  const iconClass = mode === 'inFlight' ? 'animate-spin' : ''

  return (
    <button
      data-testid="saloon-refresh-btn"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="text-slate-500 hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span className={`material-symbols-outlined text-sm ${iconClass}`}>{iconName}</span>
    </button>
  )
}

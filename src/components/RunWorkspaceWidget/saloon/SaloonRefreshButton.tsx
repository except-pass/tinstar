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
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [restartInFlight, setRestartInFlight] = useState(false)

  // Fix 1: ref-guarded in-flight check — prevents two clicks that race before
  // React re-renders from both firing.
  const acceptingClicksRef = useRef(true)

  // Fix 2: track the error-clear timer so we can cancel it on unmount and
  // before scheduling a new one.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const popoverRef = useRef<HTMLDivElement | null>(null)

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const onCancelRestart = useCallback(() => {
    if (restartInFlight) return
    setPopoverOpen(false)
    setRestartError(null)
  }, [restartInFlight])

  // Click-outside and Escape handlers for the popover
  useEffect(() => {
    if (!popoverOpen) return

    const handleMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onCancelRestart()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancelRestart()
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [popoverOpen, onCancelRestart])

  const baseTitle = natsControlOrphanedAt ? IDLE_TITLE_ORPHANED : IDLE_TITLE_HEALTHY
  const title = mode === 'inFlight'
    ? IN_FLIGHT_TITLE
    : (errorTitle ?? baseTitle)

  const onClick = useCallback(async () => {
    if (!acceptingClicksRef.current) return
    acceptingClicksRef.current = false
    // Read orphan state at click time so a flip during in-flight still wins
    const orphanedAtClickTime = natsControlOrphanedAt
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
      // If orphaned at click time, show restart popover
      if (orphanedAtClickTime) {
        setPopoverOpen(true)
        setRestartError(null)
      }
    } catch (err) {
      // Fix 3: guard against non-Error throws
      const msg = err instanceof Error ? err.message : String(err)
      setErrorTitle(`Refresh failed: ${msg}`)
      setMode('idle')
      acceptingClicksRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setErrorTitle(null), 4000)
    }
  }, [natsControlOrphanedAt])

  const onConfirmRestart = useCallback(async () => {
    setRestartInFlight(true)
    setRestartError(null)
    try {
      const encoded = encodeURIComponent(sessionName)
      const stopRes = await fetch(`/api/sessions/${encoded}/stop`, { method: 'POST' })
      if (!stopRes.ok) {
        const body = await stopRes.json().catch(() => ({}))
        const msg = body?.error?.message ?? 'unknown error'
        setRestartError(msg)
        setRestartInFlight(false)
        return
      }
      const startRes = await fetch(`/api/sessions/${encoded}/start`, { method: 'POST' })
      if (!startRes.ok) {
        const body = await startRes.json().catch(() => ({}))
        const msg = body?.error?.message ?? 'unknown error'
        setRestartError(msg)
        setRestartInFlight(false)
        return
      }
      setPopoverOpen(false)
      setRestartError(null)
      setRestartInFlight(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setRestartError(msg)
      setRestartInFlight(false)
    }
  }, [sessionName])

  const disabled = mode !== 'idle'
  const iconName = mode === 'inFlight' ? 'progress_activity' : 'refresh'
  const iconClass = mode === 'inFlight' ? 'animate-spin' : ''

  return (
    <span className="relative inline-flex">
      <button
        data-testid="saloon-refresh-btn"
        title={title}
        disabled={disabled}
        onClick={onClick}
        className="text-slate-500 hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className={`material-symbols-outlined text-sm ${iconClass}`}>{iconName}</span>
      </button>
      {popoverOpen && (
        <div
          ref={popoverRef}
          data-testid="saloon-orphan-popover"
          className="absolute top-full left-0 mt-1 z-50 w-72 rounded border border-slate-700 bg-surface-panel p-3 shadow-lg text-xs text-slate-200"
        >
          <p className="mb-2">
            Session control socket is orphaned. Restart the session to recover dynamic subscriptions? This will kill the agent process.
          </p>
          {restartError && (
            <p data-testid="saloon-orphan-error" className="mb-2 text-rose-400">{restartError}</p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              data-testid="saloon-orphan-cancel"
              autoFocus
              disabled={restartInFlight}
              onClick={onCancelRestart}
              className="px-2 py-1 rounded border border-slate-600 hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              data-testid="saloon-orphan-restart"
              disabled={restartInFlight}
              onClick={onConfirmRestart}
              className="px-2 py-1 rounded border border-rose-600 text-rose-300 hover:bg-rose-600/20 disabled:opacity-50"
            >
              {restartInFlight ? 'Restarting…' : 'Restart session'}
            </button>
          </div>
        </div>
      )}
    </span>
  )
}

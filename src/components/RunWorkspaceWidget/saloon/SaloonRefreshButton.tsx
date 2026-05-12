import { useCallback, useState } from 'react'

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

  const baseTitle = natsControlOrphanedAt ? IDLE_TITLE_ORPHANED : IDLE_TITLE_HEALTHY
  const title = mode === 'inFlight'
    ? IN_FLIGHT_TITLE
    : (errorTitle ?? baseTitle)

  const onClick = useCallback(async () => {
    if (mode !== 'idle') return
    setMode('inFlight')
    setErrorTitle(null)
    try {
      const res = await fetch('/api/nats-traffic/bounce', { method: 'POST' })
      if (res.status === 503) {
        const body = await res.json().catch(() => ({}))
        setErrorTitle(body?.error?.message ?? 'NATS bridge is disabled in tinstar config')
        setMode('permaDisabled')
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErrorTitle(`Refresh failed: ${body?.error?.message ?? 'unknown error'}`)
        setMode('idle')
        // Clear the error after 4s, matching the spec.
        setTimeout(() => setErrorTitle(null), 4000)
        return
      }
      setMode('idle')
    } catch (err) {
      setErrorTitle(`Refresh failed: ${(err as Error).message}`)
      setMode('idle')
      setTimeout(() => setErrorTitle(null), 4000)
    }
  }, [mode])

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

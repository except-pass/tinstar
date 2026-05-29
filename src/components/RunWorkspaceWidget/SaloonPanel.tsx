import { useCallback, useState } from 'react'
import { SaloonRefreshButton } from './saloon/SaloonRefreshButton'
import { SubscriptionsList } from './saloon/SubscriptionsList'
import { StreamView } from './saloon/StreamView'
import { useSaloonStream } from './saloon/useSaloonStream'
import { useNatsStatus } from './saloon/useNatsStatus'

interface Props {
  sessionName: string
  subscriptions: string[]
  natsEnabled: boolean
  natsControlOrphanedAt: string | null
  onCollapse?: () => void
}

export function SaloonPanel({
  sessionName,
  subscriptions,
  natsControlOrphanedAt,
  onCollapse,
}: Props) {
  // SSOT: the dot + topic list reflect the channel-server's observed state,
  // probed live — never session.nats config / CLI flags / .mcp.json. The
  // `subscriptions` prop is only a pre-probe placeholder so the panel isn't
  // blank for the moment before the first probe lands.
  const { status, loading, refresh } = useNatsStatus(sessionName)
  const effectiveSubs = status?.subscriptions ?? subscriptions
  const conn = status?.connection ?? 'probing'
  const dot = ({
    open: { cls: 'bg-emerald-400 shadow-[0_0_6px_#34d399]', title: `NATS connected — ${effectiveSubs.length} subject${effectiveSubs.length === 1 ? '' : 's'}` },
    degraded: { cls: 'bg-amber-400 shadow-[0_0_6px_#fbbf24]', title: `NATS degraded${status?.natsState ? ` (${status.natsState})` : ''} — click to re-probe` },
    down: { cls: 'bg-slate-600', title: 'No live NATS connection — click to re-probe' },
    probing: { cls: 'bg-slate-500 animate-pulse', title: 'Checking NATS…' },
  } as const)[conn]
  const events = useSaloonStream({ subscriptions: effectiveSubs })
  const [mutedSet, setMutedSet] = useState<Set<string>>(new Set())
  const [splitPercent, setSplitPercent] = useState(40)

  const toggleMute = useCallback((subject: string) => {
    setMutedSet(prev => {
      const next = new Set(prev)
      if (next.has(subject)) next.delete(subject)
      else next.add(subject)
      return next
    })
  }, [])

  const unmuteAll = useCallback(() => setMutedSet(new Set()), [])

  // Divider drag
  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const parent = (e.currentTarget.parentElement as HTMLElement)
    const startY = e.clientY
    const startPct = splitPercent
    const rect = parent.getBoundingClientRect()
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      const pct = Math.min(85, Math.max(15, startPct + (dy / rect.height) * 100))
      setSplitPercent(pct)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <section className="flex flex-col flex-1 min-h-0 bg-surface-panel">
      <div className="panel-header flex items-center gap-2">
        <button
          type="button"
          data-testid="saloon-dot"
          data-status={conn}
          onClick={() => refresh()}
          title={dot.title}
          className={`inline-block w-2 h-2 p-0 border-0 rounded-full shrink-0 cursor-pointer ${dot.cls} ${loading ? 'animate-pulse' : ''}`}
        />
        <SaloonRefreshButton
          sessionName={sessionName}
          natsControlOrphanedAt={natsControlOrphanedAt}
        />
        <h3 className="panel-label">Saloon</h3>
        <span className="text-2xs font-mono text-slate-600 ml-auto">
          {effectiveSubs.length} subs
        </span>
        {onCollapse && (
          <button onClick={onCollapse} className="text-slate-500 hover:text-primary">
            <span className="material-symbols-outlined text-sm">chevron_right</span>
          </button>
        )}
      </div>

      <div style={{ height: `${splitPercent}%` }} className="min-h-[60px] overflow-y-auto scrollbar-thin">
        <SubscriptionsList
          sessionName={sessionName}
          subscriptions={effectiveSubs}
          mutedSet={mutedSet}
          onToggleMute={toggleMute}
        />
      </div>

      <div
        onPointerDown={onDividerPointerDown}
        className="h-1 shrink-0 bg-slate-800 hover:bg-slate-600 cursor-row-resize flex items-center justify-center"
      >
        <div className="w-5 h-0.5 bg-slate-600 rounded-full" />
      </div>

      <div style={{ height: `${100 - splitPercent}%` }} className="min-h-[60px] flex flex-col">
        <StreamView
          sessionName={sessionName}
          events={events}
          mutedSet={mutedSet}
          onUnmuteAll={unmuteAll}
        />
      </div>
    </section>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { HudBar } from './HudBar'
import { AutonomyStat } from './AutonomyStat'
import { AgentQuadrant } from './AgentQuadrant'
import { TelemetryBootstrap } from './TelemetryBootstrap'
import { useTelemetryHud } from '../../hooks/useTelemetryHud'
import { fmtNum, fmtDollar, fmtRate } from './fmt'
import type { Run } from '../../domain/types'

const STORAGE_KEY = 'tinstar-hud-visible'

interface Props {
  toggleRef?: React.MutableRefObject<(() => void) | null>
  runMap: Map<string, Run>
  onFocusRun?: (runId: string) => void
  selectedRunIds?: Set<string>
}

export function CanvasHud({ toggleRef, runMap, onFocusRun, selectedRunIds }: Props) {
  const { snapshot } = useTelemetryHud()
  const [visible, setVisible] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored !== 'false'
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(visible))
  }, [visible])

  const toggle = useCallback(() => setVisible(v => !v), [])

  const handleRetry = useCallback(() => {
    fetch('/api/telemetry/restart', { method: 'POST' })
      .catch(err => console.error('telemetry restart failed', err))
  }, [])

  useEffect(() => {
    if (toggleRef) toggleRef.current = toggle
    return () => { if (toggleRef) toggleRef.current = null }
  }, [toggleRef, toggle])

  if (!visible) {
    return (
      <button
        onClick={toggle}
        className="absolute top-3 right-3 bg-surface-panel border border-white/10 p-1.5 rounded-sm text-slate-500 hover:text-slate-300 transition-colors select-none z-30"
        title="Show telemetry (T)"
        data-testid="canvas-hud-toggle"
      >
        <span className="material-symbols-outlined text-base" style={{ fontSize: '16px' }}>insights</span>
      </button>
    )
  }
  if (!snapshot || snapshot.state === 'disabled') return null

  const wrapStyle: React.CSSProperties = {
    position: 'absolute', top: 14, right: 14, width: 260,
    background: 'rgba(15,20,30,0.92)',
    border: '1px solid rgba(180,200,230,0.15)',
    borderRadius: 10,
    padding: '10px 12px',
    color: '#e2e8f0',
    fontFamily: "'Chakra Petch', sans-serif",
    zIndex: 30,
  }

  if (snapshot.state !== 'ready') {
    return (
      <HudShell wrapStyle={wrapStyle} onClose={toggle}>
        <TelemetryBootstrap snap={snapshot} onRetry={handleRetry} />
      </HudShell>
    )
  }

  const costTotal = snapshot.cost.total
  const tokensTotal = snapshot.tokens.total
  const rateMin = snapshot.rate.perMin
  const cacheHit = snapshot.cacheHitPct
  const modelChips = Object.entries(snapshot.cost.byModel).slice(0, 2)

  const costValue = costTotal == null ? '--' : fmtDollar(costTotal)
  const costFill = costTotal == null ? null : Math.min(1, costTotal / 20)

  const tokensLabel = rateMin == null ? 'TOKENS' : `TOKENS · ${fmtRate(rateMin)}/min`
  const tokensValue = tokensTotal == null ? '--' : fmtNum(tokensTotal)
  const tokensFill = rateMin == null ? null : Math.min(1, rateMin / 5000)

  const cacheValue = cacheHit == null ? '--' : `${(cacheHit * 100).toFixed(2)}%`
  const cacheFill = cacheHit

  return (
    <HudShell wrapStyle={wrapStyle} onClose={toggle}>
      <HudBar icon="$" label="COST" value={costValue} fill={costFill} accent="gold" />
      {modelChips.length > 0 && (
        <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
          {modelChips.map(([model, cost]) => (
            <div key={model} style={{ flex: 1, padding: '4px 6px', fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace', borderRadius: 3,
                background: 'rgba(168,85,247,0.12)', borderLeft: '2px solid #a855f7' }}>
              <div style={{ fontSize: 8, opacity: 0.7, letterSpacing: 1 }}>{model.toUpperCase().slice(0, 10)}</div>
              <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{fmtDollar(cost)}</div>
            </div>
          ))}
        </div>
      )}
      <HudBar icon="⚡" label={tokensLabel} value={tokensValue} fill={tokensFill} accent="blue" />
      <HudBar icon="◎" label="CACHE HIT" value={cacheValue} fill={cacheFill} accent="green" />
      <AutonomyStat ratio={snapshot.autonomy.ratio} cliSeconds={snapshot.autonomy.cliSeconds} userSeconds={snapshot.autonomy.userSeconds} />
      {onFocusRun && (
        <AgentQuadrant
          runMap={runMap}
          burningRunIds={new Set(snapshot.burningRunIds ?? [])}
          onFocusRun={onFocusRun}
          selectedRunIds={selectedRunIds}
        />
      )}
    </HudShell>
  )
}

function HudShell({
  wrapStyle, onClose, children,
}: { wrapStyle: React.CSSProperties; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={wrapStyle} data-testid="canvas-hud" className="group">
      <button
        onClick={onClose}
        className="absolute top-1 right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-slate-300"
        title="Hide telemetry (T)"
        data-testid="canvas-hud-close"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
      </button>
      {children}
    </div>
  )
}

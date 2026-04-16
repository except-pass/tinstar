import { useCallback, useEffect, useState } from 'react'
import { HudBar } from './HudBar'
import { AutonomyStat } from './AutonomyStat'
import { TelemetryBootstrap } from './TelemetryBootstrap'
import { useTelemetryHud } from '../../hooks/useTelemetryHud'

const STORAGE_KEY = 'tinstar-hud-visible'

interface Props {
  toggleRef?: React.MutableRefObject<(() => void) | null>
}

export function CanvasHud({ toggleRef }: Props) {
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

  if (!visible) return null
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
      <div style={wrapStyle} data-testid="canvas-hud">
        <TelemetryBootstrap snap={snapshot} onRetry={handleRetry} />
      </div>
    )
  }

  const costTotal = snapshot.cost.total
  const tokensTotal = snapshot.tokens.total
  const rateMin = snapshot.rate.perMin
  const cacheHit = snapshot.cacheHitPct
  const modelChips = Object.entries(snapshot.cost.byModel).slice(0, 2)

  const costValue = costTotal == null ? '--' : `$${costTotal.toFixed(2)}`
  const costFill = costTotal == null ? null : Math.min(1, costTotal / 20)

  const tokensLabel = rateMin == null ? 'TOKENS' : `TOKENS · ${Math.round(rateMin).toLocaleString()}/min`
  const tokensValue = tokensTotal == null ? '--' : tokensTotal.toLocaleString()
  const tokensFill = rateMin == null ? null : Math.min(1, rateMin / 5000)

  const cacheValue = cacheHit == null ? '--' : `${Math.round(cacheHit * 100)}%`
  const cacheFill = cacheHit

  return (
    <div style={wrapStyle} data-testid="canvas-hud">
      <HudBar icon="$" label="COST" value={costValue} fill={costFill} accent="gold" />
      {modelChips.length > 0 && (
        <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
          {modelChips.map(([model, cost]) => (
            <div key={model} style={{ flex: 1, padding: '4px 6px', fontSize: 10,
                fontFamily: 'JetBrains Mono, monospace', borderRadius: 3,
                background: 'rgba(168,85,247,0.12)', borderLeft: '2px solid #a855f7' }}>
              <div style={{ fontSize: 8, opacity: 0.7, letterSpacing: 1 }}>{model.toUpperCase().slice(0, 10)}</div>
              <div style={{ fontWeight: 700, color: '#e2e8f0' }}>${cost.toFixed(2)}</div>
            </div>
          ))}
        </div>
      )}
      <HudBar icon="⚡" label={tokensLabel} value={tokensValue} fill={tokensFill} accent="blue" />
      <HudBar icon="◎" label="CACHE HIT" value={cacheValue} fill={cacheFill} accent="green" />
      <AutonomyStat ratio={snapshot.autonomy.ratio} cliSeconds={snapshot.autonomy.cliSeconds} userSeconds={snapshot.autonomy.userSeconds} />
    </div>
  )
}

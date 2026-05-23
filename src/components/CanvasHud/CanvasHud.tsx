import { useCallback, useEffect, useState } from 'react'
import { AgentQuadrant } from './AgentQuadrant'
import { CcQuotaCard } from './CcQuotaCard'
import { TelemetryBootstrap } from './TelemetryBootstrap'
import { TurnLengthFleet } from './TurnLengthFleet'
import { useTelemetryHud } from '../../hooks/useTelemetryHud'
import { useCcQuota } from '../../hooks/useCcQuota'
import { fmtDollar, fmtRate } from './fmt'
import type { Run } from '../../domain/types'
import { apiFetch } from '../../apiClient'
import { StatSpark } from '../RunWorkspaceWidget/StatSpark'
import { computeDeltaChip } from '../RunWorkspaceWidget/computeDeltaChip'
import { useFleetTelemetrySeries } from '../../hooks/useFleetTelemetrySeries'
import { useConfig } from '../../context/ConfigContext'
import { getPref, setPref } from '../../lib/uiPrefs'

interface Props {
  toggleRef?: React.MutableRefObject<(() => void) | null>
  runMap: Map<string, Run>
  onFocusRun?: (runId: string) => void
  selectedRunIds?: Set<string>
  /** When true, render in normal document flow instead of as a floating top-right overlay. */
  embedded?: boolean
}

export function CanvasHud({ toggleRef, runMap, onFocusRun, selectedRunIds, embedded = false }: Props) {
  const { snapshot } = useTelemetryHud()
  const fleetSeries = useFleetTelemetrySeries(snapshot)
  const { snapshot: ccQuota } = useCcQuota()
  const config = useConfig()
  const panels = config?.ui.telemetryPanels ?? { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true }
  const [visible, setVisible] = useState(() => getPref('hudVisible') ?? true)

  useEffect(() => {
    setPref('hudVisible', visible)
  }, [visible])

  const toggle = useCallback(() => setVisible(v => !v), [])

  const handleRetry = useCallback(() => {
    apiFetch('/api/telemetry/restart', { method: 'POST' })
      .catch(err => console.error('telemetry restart failed', err))
  }, [])

  useEffect(() => {
    if (toggleRef) toggleRef.current = toggle
    return () => { if (toggleRef) toggleRef.current = null }
  }, [toggleRef, toggle])

  if (!visible) {
    return embedded ? (
      <button
        onClick={toggle}
        className="block w-full px-2 py-1 bg-surface-base/50 border-b border-white/10 text-slate-500 hover:text-slate-300 transition-colors select-none text-2xs font-mono uppercase tracking-wider"
        title="Show telemetry (T)"
        data-testid="canvas-hud-toggle"
      >
        <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: '14px' }}>insights</span>
        telemetry
      </button>
    ) : (
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

  const wrapStyle: React.CSSProperties = embedded
    ? {
        width: '100%',
        background: 'transparent',
        padding: '8px 10px',
        color: '#e2e8f0',
        fontFamily: "'Chakra Petch', sans-serif",
        position: 'relative',
      }
    : {
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

  const modelChips = Object.entries(snapshot.cost.byModel).slice(0, 2)

  return (
    <HudShell wrapStyle={wrapStyle} onClose={toggle}>
      {(() => {
        const costTotal  = snapshot.cost.total
        const tokenTotal = snapshot.tokens.total
        const tokenRate  = snapshot.rate.perMin
        const cacheHit   = snapshot.cacheHitPct
        const duty       = snapshot.dutyCycle.value
        const costValueStr   = costTotal  == null ? '--' : fmtDollar(costTotal)
        const tokensValueStr = tokenTotal == null ? '--' : fmtRate(tokenTotal)
        const cacheValueStr  = cacheHit   == null ? '--' : `${(cacheHit * 100).toFixed(1)}%`
        // Fleet duty can exceed 1 (multiple concurrent sessions). Render as e.g. "240%".
        const dutyValueStr   = duty      == null ? '--' : `${Math.round(duty * 100)}%`

        const zip = (arr: (number | null)[]): [number, number | null][] =>
          arr.map((v, i) => [fleetSeries.tsSec[i] ?? i, v])

        const costDelta   = computeDeltaChip('cost',   zip(fleetSeries.cost))
        const tokensDelta = { text: tokenRate == null ? '—' : `${fmtRate(tokenRate)}/min`, tone: 'flat' as const }
        const cacheDelta  = computeDeltaChip('cache',  zip(fleetSeries.cache))
        const dutyDelta   = computeDeltaChip('duty',   zip(fleetSeries.duty))

        return (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
            {panels.cost     && <StatSpark accent="gold"   label="COST"        value={costValueStr}   series={fleetSeries.cost}   delta={costDelta} />}
            {panels.cost && modelChips.length > 0 && (
              <div style={{ display: 'flex', gap: 5 }}>
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
            {panels.tokens   && <StatSpark accent="blue"   label="TOKENS"      value={tokensValueStr} series={fleetSeries.tokens} delta={tokensDelta} />}
            {panels.cacheHit && <StatSpark accent="green"  label="CACHE HIT"   value={cacheValueStr}  series={fleetSeries.cache}  delta={cacheDelta} />}
            {panels.duty     && <StatSpark accent="violet" label="DUTY · FLEET" value={dutyValueStr}  series={fleetSeries.duty}   delta={dutyDelta} />}
            <TurnLengthFleet />
          </div>
        )
      })()}
      <CcQuotaCard snapshot={ccQuota}/>
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

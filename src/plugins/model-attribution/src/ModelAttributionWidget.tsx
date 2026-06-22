// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import { useEffect, useState } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'

const POLL_MS = 5000

/** One session as surfaced by /api/state (the subset we render). */
interface SessionRow {
  name: string
  model: string | null
}

/** A rate-limit bucket from /api/cc-quota's `data`. */
interface UsageBucket {
  utilization: number // 0..100
  resets_at: string
}

/** The cc-quota snapshot shape returned raw by GET /api/cc-quota. */
interface CcQuota {
  five_hour: UsageBucket | null
  seven_day: UsageBucket | null
}

/** Fleet cost-by-model carried on the telemetry:hud SSE channel. */
interface HudCostMsg {
  cost?: { byModel?: Record<string, number> }
}

/** Strip the long `claude-`/provider prefix so chips stay readable. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/^us\.anthropic\./, '')
}

function fmtPct(n: number): string {
  return `${Math.round(n)}%`
}

function fmtCost(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`
}

export function makeModelAttributionWidget(api: TinstarPluginAPI) {
  return function ModelAttributionWidget(props: WidgetProps) {
    const zoom = props.zoom ?? 1
    const [sessions, setSessions] = useState<SessionRow[]>([])
    const [quota, setQuota] = useState<CcQuota | null>(null)
    const [costByModel, setCostByModel] = useState<Record<string, number>>({})

    // Poll /api/state + /api/cc-quota on a modest interval.
    useEffect(() => {
      let cancelled = false
      const poll = async () => {
        try {
          const stateRes = await api.http.fetch('/api/state')
          if (stateRes.ok) {
            const body = (await stateRes.json()) as { sessions?: SessionRow[] }
            if (!cancelled) {
              setSessions(
                (body.sessions ?? []).map(s => ({ name: s.name, model: s.model ?? null })),
              )
            }
          }
        } catch (err) {
          api.logger.warn('model-attribution: /api/state poll failed', err)
        }
        try {
          const quotaRes = await api.http.fetch('/api/cc-quota')
          if (quotaRes.ok) {
            const body = (await quotaRes.json()) as { data?: CcQuota | null }
            if (!cancelled) setQuota(body.data ?? null)
          }
        } catch (err) {
          api.logger.warn('model-attribution: /api/cc-quota poll failed', err)
        }
      }
      void poll()
      const t = setInterval(() => void poll(), POLL_MS)
      return () => {
        cancelled = true
        clearInterval(t)
      }
    }, [])

    // Subscribe to the fleet HUD for cost-by-model.
    useEffect(() => {
      const sub = api.events.subscribe<HudCostMsg>('telemetry:hud', msg => {
        const byModel = msg?.cost?.byModel
        if (byModel) setCostByModel(byModel)
      })
      return () => sub.dispose()
    }, [])

    const costEntries = Object.entries(costByModel).filter(([, v]) => v != null)

    return (
      <div
        className="flex flex-col h-full bg-surface-base text-slate-300 overflow-hidden"
        style={{ fontSize: `${Math.max(0.7, Math.min(1.3, zoom))}rem` }}
        data-testid="model-attribution-widget"
      >
        <div className="widget-drag-handle flex items-center gap-2 px-3 py-1.5 bg-surface-panel border-b border-white/10 flex-shrink-0 cursor-grab">
          <span className="text-primary text-xs flex-shrink-0">MODELS</span>
          <span className="text-2xs text-slate-500 flex-1 truncate">model attribution</span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 text-2xs space-y-3">
          {/* Per-session model list */}
          <section>
            <div className="text-slate-500 uppercase tracking-wide mb-1">Sessions</div>
            {sessions.length === 0 ? (
              <div className="text-slate-600">No sessions</div>
            ) : (
              <ul className="space-y-0.5">
                {sessions.map(s => (
                  <li key={s.name} className="flex items-center justify-between gap-2">
                    <span className="text-slate-300 truncate" title={s.name}>
                      {s.name}
                    </span>
                    <span
                      className={s.model ? 'font-mono text-cyan-400 truncate' : 'text-slate-600'}
                      title={s.model ?? 'no model yet'}
                    >
                      {s.model ? shortModel(s.model) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* cc-quota headroom */}
          <section>
            <div className="text-slate-500 uppercase tracking-wide mb-1">Quota</div>
            {quota === null ? (
              <div className="text-slate-600">No quota data</div>
            ) : (
              <div className="flex gap-4 font-mono">
                <span title="5-hour rate-limit utilization">
                  <span className="text-slate-500">5h </span>
                  {quota.five_hour ? fmtPct(quota.five_hour.utilization) : '—'}
                </span>
                <span title="7-day rate-limit utilization">
                  <span className="text-slate-500">7d </span>
                  {quota.seven_day ? fmtPct(quota.seven_day.utilization) : '—'}
                </span>
              </div>
            )}
          </section>

          {/* Fleet cost-by-model chips */}
          <section>
            <div className="text-slate-500 uppercase tracking-wide mb-1">Fleet cost / model</div>
            {costEntries.length === 0 ? (
              <div className="text-slate-600">No cost data</div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {costEntries.map(([model, cost]) => (
                  <span
                    key={model}
                    className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 font-mono"
                    title={model}
                  >
                    <span className="text-cyan-400">{shortModel(model)}</span>
                    <span className="text-slate-400">{fmtCost(cost)}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* GPU/loaded-model telemetry — no data source yet; degrade gracefully. */}
          <section>
            <div className="text-slate-500 uppercase tracking-wide mb-1">GPU</div>
            <div className="text-slate-600 italic" data-testid="gpu-degraded">
              GPU telemetry unavailable
            </div>
          </section>
        </div>
      </div>
    )
  }
}

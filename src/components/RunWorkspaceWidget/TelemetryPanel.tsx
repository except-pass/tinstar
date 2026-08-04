import { useState, useCallback, useEffect, useRef } from 'react'
import squarify from 'squarify'
import { hexToRgba } from '../runAccent'
import { fmtDollar, fmtRate } from '../CanvasHud/fmt'
import { useTelemetrySession } from '../../hooks/useTelemetrySession'
import { apiFetch } from '../../apiClient'
import { StatSpark } from './StatSpark'
import { computeDeltaChip } from './computeDeltaChip'
import { useTelemetrySeries } from '../../hooks/useTelemetrySeries'
import { useConfig } from '../../context/ConfigContext'
import { TurnLengthPanel } from './TurnLengthPanel'
import {
  useProviderSessionObservationState,
  type ProviderSessionObservations,
} from '../../hooks/providerObservationsStore'
import { TimelinePanel } from './TimelinePanel'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ContextCategory {
  name: string
  tokens: number
  percentage?: number
}

interface ContextData {
  categories: ContextCategory[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
  isAutoCompactEnabled: boolean
  autoCompactThreshold: number | null
}

interface Props {
  sessionId: string
  runAccent: string
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const OPACITY_BY_RANK = [0.55, 0.45, 0.35, 0.28, 0.22, 0.18, 0.12]
const FREE_SPACE_OPACITY = 0.04
const AUTOCOMPACT_OPACITY = 0.10
const LABEL_THRESHOLD = 0.08 // 8% of total to show label

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  'Messages': 'Conversation history — prompts, responses, and tool call/result pairs',
  'System prompt': 'Base instructions Claude Code uses for every turn',
  'System tools': 'Built-in tool definitions (Bash, Read, Edit, Grep, etc.)',
  'MCP tools': 'Model Context Protocol tools from connected external servers',
  'Custom agents': 'Subagent type definitions from plugins',
  'Memory files': 'Project instructions (CLAUDE.md), auto-memory, and user-level config files',
  'Skills': 'Skill frontmatter loaded from plugins and user commands',
  'Autocompact buffer': 'Reserved headroom — when context hits this threshold, older messages are summarized',
  'Free space': 'Available context remaining before autocompact triggers',
  'MCP tools (deferred)': 'MCP tools available on-demand but not yet loaded into context',
  'System tools (deferred)': 'Built-in tools available on-demand via ToolSearch',
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function humanizeAge(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 10) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}

function abbreviate(name: string): string {
  const abbrevs: Record<string, string> = {
    'System prompt': 'Sys prompt',
    'System tools': 'Sys tools',
    'Memory files': 'Memory',
    'Autocompact buffer': 'Buffer',
    'Free space': 'Free',
    'MCP tools (deferred)': 'MCP def.',
    'System tools (deferred)': 'Sys def.',
    'Custom agents': 'Agents',
  }
  return abbrevs[name] ?? name
}

function opacityForCategory(name: string, rank: number): number {
  if (name === 'Free space') return FREE_SPACE_OPACITY
  if (name === 'Autocompact buffer') return AUTOCOMPACT_OPACITY
  return OPACITY_BY_RANK[Math.min(rank, OPACITY_BY_RANK.length - 1)] ?? 0.12
}

function labelColor(opacity: number): string {
  return opacity >= 0.30
    ? 'rgba(255,255,255,0.7)'
    : 'rgba(255,255,255,0.4)'
}

/* ------------------------------------------------------------------ */
/*  SessionSection                                                     */
/* ------------------------------------------------------------------ */

function SessionSection({ sessionId }: { sessionId: string }) {
  const config = useConfig()
  const panels = config?.ui.telemetryPanels ?? { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true, timeline: true }
  const snap = useTelemetrySession(sessionId)
  const series = useTelemetrySeries(sessionId)
  const readySnap = snap?.state === 'ready' ? snap : null

  const costTotal  = readySnap?.cost.total ?? null
  const tokenTotal = readySnap?.tokens.total ?? null
  const tokenRate  = readySnap?.rate.perMin ?? null
  const cacheHit   = readySnap?.cacheHitPct ?? null
  const duty       = readySnap?.dutyCycle.value ?? null

  const costValue   = costTotal  == null ? '--' : fmtDollar(costTotal)
  const tokensValue = tokenTotal == null ? '--' : fmtRate(tokenTotal)
  const cacheValue  = cacheHit   == null ? '--' : `${(cacheHit * 100).toFixed(1)}%`
  const dutyValue   = duty       == null ? '--' : `${Math.round(duty * 100)}%`

  const costSeries   = series?.cost   ?? []
  const tokenSeries  = series?.tokens ?? []
  const cacheSeries  = series?.cache  ?? []
  const dutySeries   = series?.duty   ?? []

  const tsSec = series?.tsSec ?? []
  const zip = (arr: (number | null)[]): [number, number | null][] =>
    arr.map((v, i) => [tsSec[i] ?? i, v] as [number, number | null])

  const costDelta   = computeDeltaChip('cost',   zip(costSeries))
  const tokensDelta = { text: tokenRate == null ? '—' : `${fmtRate(tokenRate)}/min`, tone: 'flat' as const }
  const cacheDelta  = computeDeltaChip('cache',  zip(cacheSeries))
  const dutyDelta   = computeDeltaChip('duty',   zip(dutySeries))

  return (
    <div
      style={{ padding: '10px 12px', borderBottom: '1px solid rgba(120,140,180,0.15)' }}
      data-testid="telemetry-session-section"
    >
      <div style={{
        fontSize: 9, letterSpacing: 2, opacity: 0.55,
        fontFamily: 'JetBrains Mono, monospace', marginBottom: 8,
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>SESSION</span>
        <span style={{
          background: 'rgba(34,211,238,0.12)', color: '#22d3ee',
          padding: '1px 6px', borderRadius: 2, letterSpacing: 1, fontSize: 8,
        }}>THIS RUN</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}>
        {panels.cost && (
          <StatSpark accent="gold" label="COST" value={costValue} series={costSeries} delta={costDelta} />
        )}
        {panels.tokens && (
          <StatSpark accent="blue" label="TOKENS" value={tokensValue} series={tokenSeries} delta={tokensDelta} />
        )}
        {panels.cacheHit && (
          <StatSpark accent="green" label="CACHE HIT" value={cacheValue} series={cacheSeries} delta={cacheDelta} />
        )}
        {panels.duty && (
          <StatSpark accent="violet" label="DUTY" value={dutyValue} series={dutySeries} delta={dutyDelta} />
        )}
        {panels.turnLength && <TurnLengthPanel sessionId={sessionId} />}
        {panels.timeline && <TimelinePanel sessionId={sessionId} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Treemap                                                            */
/* ------------------------------------------------------------------ */

interface TreemapProps {
  categories: ContextCategory[]
  accent: string
  maxTokens: number
}

interface TooltipState {
  name: string
  tokens: number
  percentage?: number
  description: string
  x: number
  y: number
}

interface SquarifyInput {
  value: number
  name: string
  tokens: number
  percentage: number
  rank: number
}

function Treemap({ categories, accent, maxTokens }: TreemapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  // Filter out zero-token categories, sort descending
  const sorted = (categories ?? [])
    .filter(c => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

  // Compute layout using squarify — needs pixel dimensions
  const [dims, setDims] = useState({ w: 160, h: 120 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect) setDims({ w: rect.width, h: rect.height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const input: SquarifyInput[] = sorted.map((c, i) => ({
    value: c.tokens,
    name: c.name,
    tokens: c.tokens,
    percentage: maxTokens > 0 ? (c.tokens / maxTokens) * 100 : 0,
    rank: i,
  }))

  const layout = dims.w > 0 && dims.h > 0
    ? squarify<{ name: string; tokens: number; percentage: number; rank: number }>(input, { x0: 0, y0: 0, x1: dims.w, y1: dims.h })
    : []

  return (
    <div ref={containerRef} className="relative flex-1 min-h-0">
      {layout.map((cell) => {
        const w = cell.x1 - cell.x0
        const h = cell.y1 - cell.y0
        const opacity = opacityForCategory(cell.name, cell.rank)
        const bg = hexToRgba(accent, opacity)
        const pctOfTotal = cell.tokens / maxTokens
        const showLabel = pctOfTotal >= LABEL_THRESHOLD && w > 28 && h > 16

        return (
          <div
            key={cell.name}
            className="absolute rounded-sm"
            style={{
              left: `${(cell.x0 / dims.w) * 100}%`,
              top: `${(cell.y0 / dims.h) * 100}%`,
              width: `${(w / dims.w) * 100}%`,
              height: `${(h / dims.h) * 100}%`,
              background: bg,
              padding: '1px',
            }}
            onMouseEnter={(e) => {
              const rect = containerRef.current?.getBoundingClientRect()
              if (!rect) return
              setTooltip({
                name: cell.name,
                tokens: cell.tokens,
                percentage: cell.percentage,
                description: CATEGORY_DESCRIPTIONS[cell.name] ?? '',
                x: e.clientX - rect.left,
                y: cell.y0,
              })
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            {showLabel && (
              <span
                className="text-2xs font-mono leading-none select-none pointer-events-none block truncate"
                style={{ color: labelColor(opacity), fontSize: '8px' }}
              >
                {abbreviate(cell.name)} {cell.percentage != null ? `${cell.percentage.toFixed(0)}%` : '--'}
              </span>
            )}
          </div>
        )
      })}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute z-50 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 shadow-lg pointer-events-none"
          style={{
            left: `${Math.min(tooltip.x, dims.w - 150)}px`,
            top: `${Math.max(0, tooltip.y - 52)}px`,
            maxWidth: '150px',
          }}
        >
          <div className="text-2xs font-bold text-slate-200 truncate">{tooltip.name}</div>
          <div className="text-2xs text-slate-400 font-mono">
            {tooltip.tokens.toLocaleString()} tokens {tooltip.percentage != null ? `(${tooltip.percentage.toFixed(1)}%)` : ''}
          </div>
          {tooltip.description && (
            <div className="text-2xs text-slate-500 mt-0.5 leading-tight">{tooltip.description}</div>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  TelemetryPanel                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reconcile the /context breakdown with the session's real context window.
 *
 * The /context sidecar probes usage with `--model claude-haiku-4-5` (cheap +
 * fast), so the `maxTokens` it returns is Haiku's 200k window — NOT the resumed
 * session's real window (e.g. 1M for Opus 1M). That made the treemap's
 * percentages and its "Free space" cell disagree with the live context meter
 * rendered right above it. The per-category token counts are correct; only the
 * denominator is wrong. So when we have the true window from the statusline
 * push (useSessionContextWindow), trust it: rebuild "Free space" against it and
 * use it as the treemap denominator.
 */
export function treemapInputs(
  data: ContextData,
  liveWindow: number | null | undefined,
): { categories: ContextCategory[]; maxTokens: number } {
  if (!liveWindow || liveWindow <= 0 || liveWindow === data.maxTokens) {
    return { categories: data.categories, maxTokens: data.maxTokens }
  }
  const nonFree = data.categories.filter(c => c.name !== 'Free space')
  const usedNonFree = nonFree.reduce((sum, c) => sum + c.tokens, 0)
  const free = Math.max(0, liveWindow - usedNonFree)
  return {
    categories: [...nonFree, { name: 'Free space', tokens: free }],
    maxTokens: liveWindow,
  }
}

export function TelemetryPanel({ sessionId, runAccent }: Props) {
  const [data, setData] = useState<ContextData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [detailIdentity, setDetailIdentity] = useState<string | null>(null)
  const [ageLabel, setAgeLabel] = useState('')
  const providerState = useProviderSessionObservationState(sessionId)
  const providerSessions = providerState.observations
  const liveCtx = providerLiveContext(providerSessions)
  const providerIdentity = providerSessions.map(provider => JSON.stringify([
    provider.providerId,
    provider.usage?.scope.sessionId ?? null,
    provider.context?.scope.sessionId ?? null,
  ])).join('|')
  const contextIdentity = JSON.stringify([sessionId, providerIdentity])
  const contextIdentityRef = useRef(contextIdentity)
  contextIdentityRef.current = contextIdentity
  const contextRequestGeneration = useRef(0)
  const identityMatches = detailIdentity === contextIdentity
  const visibleData = identityMatches ? data : null
  const visibleLoading = identityMatches ? loading : false
  const visibleError = identityMatches ? error : null
  const visibleLoadedAt = identityMatches ? loadedAt : null

  useEffect(() => {
    contextRequestGeneration.current += 1
    setData(null)
    setError(null)
    setLoadedAt(null)
    setDetailIdentity(null)
    setAgeLabel('')
    setLoading(false)
  }, [contextIdentity])

  // Update humanized age every 30s
  useEffect(() => {
    if (!visibleLoadedAt) return
    const update = () => setAgeLabel(humanizeAge(Date.now() - visibleLoadedAt))
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [visibleLoadedAt])

  const fetchContext = useCallback(async () => {
    const requestIdentity = contextIdentity
    const requestGeneration = contextRequestGeneration.current + 1
    contextRequestGeneration.current = requestGeneration
    if (!identityMatches) {
      setData(null)
      setLoadedAt(null)
      setAgeLabel('')
    }
    setDetailIdentity(requestIdentity)
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/context`)
      if (res.status === 409) throw new DetailedContextUnavailableError()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error?.message ?? 'Unknown error')
      if (contextRequestGeneration.current !== requestGeneration
        || contextIdentityRef.current !== requestIdentity) return
      setData(json.data as ContextData)
      setLoadedAt(Date.now())
    } catch (err) {
      if (contextRequestGeneration.current !== requestGeneration
        || contextIdentityRef.current !== requestIdentity) return
      if (err instanceof DetailedContextUnavailableError) {
        setData(null)
        setLoadedAt(null)
        setAgeLabel('')
      }
      setError(err instanceof DetailedContextUnavailableError
        ? 'Detailed context breakdown unavailable for this provider'
        : (err as Error).message)
    } finally {
      if (contextRequestGeneration.current === requestGeneration
        && contextIdentityRef.current === requestIdentity) {
        setLoading(false)
      }
    }
  }, [contextIdentity, identityMatches, sessionId])

  const pct = liveCtx?.usedPercentage ?? null
  const pctLabel = pct == null ? '--' : `${pct.toFixed(0)}%`
  const fillPct = pct == null ? 0 : Math.max(0, Math.min(100, pct))

  // Capacity-warning colors come from the approved palette (tailwind.theme.js):
  // amber #ffaa00 once the window is filling up, red #ff3366 when near-full.
  const WARN_PCT = 75
  const DANGER_PCT = 85
  const isWarn = pct != null && pct >= WARN_PCT && pct < DANGER_PCT
  const isDanger = pct != null && pct >= DANGER_PCT
  const meterColor = isDanger ? '#ff3366' : isWarn ? '#ffaa00' : runAccent
  const fillBg = hexToRgba(meterColor, isDanger || isWarn ? 0.45 : 0.35)

  const meterTitle = visibleLoading
    ? 'Loading detailed context breakdown…'
    : visibleData
      ? `Context window: ${pct != null ? pct.toFixed(1) + '%' : '--'} — click to refresh breakdown${visibleLoadedAt ? ` (loaded ${ageLabel})` : ''}`
      : liveCtx
        ? `Context window: ${liveCtx.usedPercentage.toFixed(1)}%${liveCtx.windowSize ? ` of ${liveCtx.windowSize.toLocaleString()} tokens` : ''} — click for detailed breakdown`
        : 'Load detailed context breakdown'

  const meterButton = (
    <div className="p-2">
      <button
        onClick={fetchContext}
        disabled={visibleLoading}
        title={meterTitle}
        className={`group relative w-full max-w-[240px] mx-auto block overflow-hidden border rounded transition-colors disabled:opacity-70 ${
          isDanger
            ? 'border-accent-red/60 animate-pulse-soft'
            : isWarn
              ? 'border-accent-amber/50'
              : 'border-slate-700 hover:border-slate-500'
        }`}
      >
        <div
          className="absolute inset-y-0 left-0 transition-all duration-500"
          style={{ width: `${fillPct}%`, background: fillBg }}
        />
        <div className="relative flex items-center justify-between px-3 py-1.5 text-2xs font-mono">
          <span className="flex items-center gap-1.5 text-slate-300 group-hover:text-slate-100">
            <span className={`material-symbols-outlined text-sm ${visibleLoading ? 'animate-spin' : ''}`}>
              {visibleLoading ? 'progress_activity' : 'query_stats'}
            </span>
            Context
          </span>
          <span
            className="text-slate-200 tabular-nums"
            style={{ color: isDanger || isWarn ? meterColor : undefined }}
          >
            {pctLabel}
          </span>
        </div>
      </button>
    </div>
  )

  let detail: React.ReactNode = null
  if (visibleLoading && !visibleData) {
    detail = (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-2xs font-mono text-slate-500 animate-pulse">Loading...</span>
      </div>
    )
  } else if (visibleError && !visibleData) {
    detail = (
      <div className="flex-1 flex items-center justify-center p-2">
        <span className="text-2xs text-red-400 text-center">{visibleError}</span>
      </div>
    )
  } else if (visibleData) {
    const tm = treemapInputs(visibleData, liveCtx?.windowSize)
    detail = (
      <div className="flex-1 min-h-0 flex flex-col px-1 pb-1">
        <Treemap
          categories={tm.categories}
          accent={runAccent}
          maxTokens={tm.maxTokens}
        />
      </div>
    )
  }

  return (
    <section className="flex flex-col flex-1 min-h-0">
      <div className="panel-header">
        <h3 className="panel-label">Telemetry</h3>
      </div>
      <SessionSection
        key={sessionId}
        sessionId={sessionId}
      />
      {meterButton}
      {detail}
    </section>
  )
}

class DetailedContextUnavailableError extends Error {}

function providerLiveContext(providers: ProviderSessionObservations[]): {
  usedPercentage: number
  windowSize?: number
} | null {
  for (const provider of providers) {
    const context = provider.context
    if (context?.availability.state !== 'available') continue
    const value = context.availability.value
    const usedPercentage = providerContextPercent(value)
    if (usedPercentage === null) continue
    return {
      usedPercentage,
      ...(value.windowTokens === undefined ? {} : { windowSize: value.windowTokens }),
    }
  }
  return null
}

function providerContextPercent(value: {
  usedPercent?: number
  usedTokens?: number
  windowTokens?: number
} | null | undefined): number | null {
  if (!value) return null
  if (value.usedPercent !== undefined) return value.usedPercent
  if (value.usedTokens === undefined || !value.windowTokens) return null
  return value.usedTokens / value.windowTokens * 100
}

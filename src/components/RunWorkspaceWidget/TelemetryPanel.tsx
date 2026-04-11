import { useState, useCallback, useEffect, useRef } from 'react'
import squarify from 'squarify'
import { hexToRgba } from '../runAccent'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ContextCategory {
  name: string
  tokens: number
  percentage: number
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
  percentage: number
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
  const sorted = categories
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
    percentage: c.percentage,
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
                {abbreviate(cell.name)} {cell.percentage.toFixed(0)}%
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
            {tooltip.tokens.toLocaleString()} tokens ({tooltip.percentage.toFixed(1)}%)
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

export function TelemetryPanel({ sessionId, runAccent }: Props) {
  const [data, setData] = useState<ContextData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [ageLabel, setAgeLabel] = useState('')

  // Update humanized age every 30s
  useEffect(() => {
    if (!loadedAt) return
    const update = () => setAgeLabel(humanizeAge(Date.now() - loadedAt))
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [loadedAt])

  const fetchContext = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error?.message ?? 'Unknown error')
      setData(json.data as ContextData)
      setLoadedAt(Date.now())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  /* ---- Empty state ---- */
  if (!data && !loading && !error) {
    return (
      <section className="flex flex-col flex-1 min-h-0">
        <div className="panel-header">
          <h3 className="panel-label">Telemetry</h3>
        </div>
        <div className="flex-1 flex items-center justify-center p-2">
          <button
            onClick={fetchContext}
            className="flex items-center gap-1.5 px-3 py-1.5 text-2xs font-mono text-slate-400 border border-dashed border-slate-600 rounded hover:border-slate-400 hover:text-slate-300 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">query_stats</span>
            Load Context
          </button>
        </div>
      </section>
    )
  }

  /* ---- Loading state ---- */
  if (loading && !data) {
    return (
      <section className="flex flex-col flex-1 min-h-0">
        <div className="panel-header">
          <h3 className="panel-label">Telemetry</h3>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <span className="text-2xs font-mono text-slate-500 animate-pulse">Loading...</span>
        </div>
      </section>
    )
  }

  /* ---- Error state ---- */
  if (error && !data) {
    return (
      <section className="flex flex-col flex-1 min-h-0">
        <div className="panel-header">
          <h3 className="panel-label">Telemetry</h3>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-2">
          <span className="text-2xs text-red-400 text-center">{error}</span>
          <button
            onClick={fetchContext}
            className="text-2xs font-mono text-slate-400 hover:text-slate-300"
          >
            Retry
          </button>
        </div>
      </section>
    )
  }

  /* ---- Loaded state ---- */
  return (
    <section className="flex flex-col flex-1 min-h-0">
      <div className="panel-header">
        <h3 className="panel-label">Telemetry</h3>
      </div>
      <div className="flex-1 min-h-0 flex flex-col px-1 pt-1">
        <Treemap
          categories={data!.categories}
          accent={runAccent}
          maxTokens={data!.maxTokens}
        />
      </div>
      <div className="flex items-center justify-between px-2 py-1 text-2xs font-mono text-slate-600">
        <span>{loadedAt ? `loaded ${ageLabel}` : ''}</span>
        <button
          onClick={fetchContext}
          disabled={loading}
          className="text-slate-500 hover:text-slate-300 disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-xs">refresh</span>
        </button>
      </div>
    </section>
  )
}

import { useState } from 'react'
import { useConfig } from '../../context/ConfigContext'
import { useSessionTimeline } from '../../hooks/useSessionTimeline'
import { TimelineStrip, BAND_COLOR, type StripMode } from '../Telemetry/TimelineStrip'
import type { Band, BandKind, SessionTimeline } from '../../server/sessions/timeline/types'

const MAX_STRIP_PX = 260
const MIN_STRIP_PX = 60

export const TIMELINE_HELP =
  'Where this run\'s wall-clock time went, rebuilt from its transcript. ' +
  'Time runs top (past) to bottom (present). Red is you: an approval prompt ' +
  'nobody answered. Amber is you too: a question awaiting a reply. ' +
  'Grey-blue "thinking" is a residual — in-turn time with no tool outstanding — ' +
  'so read it as an upper bound, not a measurement. ' +
  'In the gutter: a filled red tick is a tool that exited non-zero, a hollow ' +
  'one is an interrupted sub-agent. Ticks too close together merge.'

/**
 * Strip length tracks real duration on a compressed curve (R10).
 *
 * Strict proportionality would render a 30-minute turn beside a 116-hour
 * session as a sub-pixel sliver; stretching each strip to fill the rail would
 * throw the comparison away entirely. A shorter stretch of time must draw a
 * shorter bar — that is what makes the three columns readable against one
 * another.
 */
export function stripHeightPx(durationSec: number, longestOnCardSec: number): number {
  const ratio = Math.max(durationSec, 1) / Math.max(longestOnCardSec, 1)
  return Math.min(MAX_STRIP_PX, Math.max(MIN_STRIP_PX, Math.pow(ratio, 0.32) * MAX_STRIP_PX))
}

const fmt = (s: number): string => {
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${(s / 60).toFixed(0)}m`
  return `${(s / 3600).toFixed(1)}h`
}

function clip(bands: Band[], a: number, b: number): Band[] {
  const out: Band[] = []
  for (const s of bands) {
    if (s.end <= a || s.start >= b) continue
    out.push({ ...s, start: Math.max(s.start, a), end: Math.min(s.end, b) })
  }
  return out
}

/** Percentages come from durations, never from pixels (R17). */
function shares(bands: Band[]): { kind: BandKind; pct: number; secs: number }[] {
  const totals = new Map<BandKind, number>()
  let sum = 0
  for (const b of bands) {
    const d = b.end - b.start
    totals.set(b.kind, (totals.get(b.kind) ?? 0) + d)
    sum += d
  }
  if (sum <= 0) return []
  return [...totals.entries()]
    .map(([kind, secs]) => ({ kind, pct: (secs / sum) * 100, secs }))
    .sort((x, y) => y.secs - x.secs)
}

export function TimelinePanel({ sessionId }: { sessionId: string }) {
  const config = useConfig()
  if (!config?.ui.telemetryPanels.timeline) return null
  return <TimelinePanelInner sessionId={sessionId} />
}

function TimelinePanelInner({ sessionId }: { sessionId: string }) {
  const { timeline, windowSec, error } = useSessionTimeline(sessionId)
  const [hovered, setHovered] = useState<Band | null>(null)
  // Per-workspace, deliberately: flipping one run's strips must not touch
  // another's. Local state, not config — this is a way of looking at one run,
  // not a preference about all of them.
  const [mode, setMode] = useState<StripMode>('timeline')
  const [activeCol, setActiveCol] = useState(0)

  if (!timeline) {
    // A failing route and a session that genuinely has no transcript are
    // different facts and must not render the same line.
    return (
      <div data-testid="timeline-panel" style={{ padding: '6px 0' }}>
        <Header mode={mode} onMode={setMode} />
        <div
          title={error ?? undefined}
          style={{ fontSize: 9, opacity: 0.65, fontFamily: 'JetBrains Mono, monospace' }}
        >
          {error ? '— timeline unavailable —' : '— no transcript —'}
        </div>
      </div>
    )
  }

  const cols = buildColumns(timeline, windowSec)
  const longest = Math.max(...cols.map(c => c.b - c.a), 1)

  return (
    <div data-testid="timeline-panel" style={{ padding: '6px 0' }}>
      <Header mode={mode} onMode={setMode} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        {cols.map((c, i) => (
          <div
            key={c.label}
            style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
            onMouseEnter={() => setActiveCol(i)}
          >
            <TimelineStrip
              bands={clip(timeline.bands, c.a, c.b)}
              marks={timeline.marks}
              t0={c.a}
              t1={c.b}
              heightPx={stripHeightPx(c.b - c.a, longest)}
              label={`${c.label} — ${fmt(c.b - c.a)}`}
              mode={mode}
              onHover={setHovered}
            />
            <span style={{
              fontSize: 8, opacity: i === activeCol ? 0.95 : 0.45,
              fontFamily: 'JetBrains Mono, monospace', letterSpacing: 0.5,
            }}>{c.short}</span>
            <span style={{
              fontSize: 8, opacity: 0.75, fontFamily: 'JetBrains Mono, monospace',
              fontVariantNumeric: 'tabular-nums',
            }}>{fmt(c.b - c.a)}</span>
          </div>
        ))}
      </div>
      <Shares
        label={(cols[activeCol] ?? cols[0]!).short}
        bands={clip(timeline.bands, (cols[activeCol] ?? cols[0]!).a, (cols[activeCol] ?? cols[0]!).b)}
      />
      <div style={{
        fontSize: 9, opacity: 0.65, marginTop: 4, minHeight: 12,
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        {hovered
          ? `${hovered.name} · ${fmt(hovered.end - hovered.start)}`
          : `${timeline.turns.length} turns`}
      </div>
    </div>
  )
}

function Header({ mode, onMode }: { mode: StripMode; onMode: (m: StripMode) => void }) {
  const next = mode === 'timeline' ? 'percent' : 'timeline'
  return (
    <div style={{
      fontSize: 9, letterSpacing: 2, opacity: 0.55,
      fontFamily: 'JetBrains Mono, monospace', marginBottom: 4,
      display: 'flex', alignItems: 'center', gap: 4,
    }}>
      TIME
      <span title={TIMELINE_HELP} style={{ opacity: 0.7, cursor: 'help' }}>ⓘ</span>
      <button
        type="button"
        data-testid="timeline-mode-toggle"
        aria-pressed={mode === 'percent'}
        title={mode === 'timeline' ? 'Group by kind' : 'Back to time order'}
        onClick={() => onMode(next)}
        style={{
          marginLeft: 'auto', cursor: 'pointer', background: 'none',
          border: '1px solid currentColor', borderRadius: 2, padding: '0 3px',
          font: 'inherit', letterSpacing: 1, color: 'inherit',
          opacity: mode === 'percent' ? 1 : 0.6, lineHeight: 1.4,
        }}
      >{mode === 'percent' ? '%' : '⏱'}</button>
    </div>
  )
}

function Shares({ bands, label }: { bands: Band[]; label: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', marginTop: 5, alignItems: 'center' }}>
      <span style={{
        fontSize: 8, opacity: 0.5, fontFamily: 'JetBrains Mono, monospace', letterSpacing: 0.5,
      }}>{label}</span>
      {shares(bands).filter(s => s.pct >= 1).map(s => (
        <span
          key={s.kind}
          title={s.kind}
          style={{
            fontSize: 9, opacity: 0.8, fontFamily: 'JetBrains Mono, monospace',
            fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', gap: 3,
          }}
        >
          <span style={{ width: 6, height: 6, background: BAND_COLOR[s.kind], borderRadius: 1 }} />
          {s.pct.toFixed(0)}%
        </span>
      ))}
    </div>
  )
}

/** Whole session, trailing window, and the current-or-last turn. */
function buildColumns(tl: SessionTimeline, windowSec: number): { label: string; short: string; a: number; b: number }[] {
  const last = tl.turns[tl.turns.length - 1]
  const cols = [
    { label: 'Whole session', short: 'ALL', a: tl.t0, b: tl.t1 },
    { label: 'Trailing window', short: 'WIN', a: Math.max(tl.t0, tl.t1 - windowSec), b: tl.t1 },
  ]
  if (last) {
    cols.push({ label: last[2] ? 'Current turn' : 'Last turn', short: last[2] ? 'NOW' : 'LAST', a: last[0], b: last[1] })
  }
  return cols
}

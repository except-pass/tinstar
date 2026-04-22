import { useMemo } from 'react'
import type { Run } from '../../domain/types'
import { AgentAvatar } from './AgentAvatar'
import './hud.css'

type CellKey = 'working' | 'subagent' | 'tool' | 'idle'

interface Props {
  runMap: Map<string, Run>
  burningRunIds: Set<string>
  onFocusRun: (runId: string) => void
}

/**
 * 2x2 quadrant showing every alive agent, placed by:
 *   x-axis: READY (idle/needs_attention/creating)  vs  BUSY (status=running)
 *   y-axis: LLM (in burning set)                   vs  quiet (not)
 *
 * Up-and-right = most active, following dashboard convention.
 *
 *                READY                  BUSY
 *   LLM    SUBAGENT (cyan)         WORKING (amber)     ← animated shimmer
 *  quiet   IDLE     (slate)        TOOL    (ochre)
 *
 * Clicking an avatar calls onFocusRun to pan the canvas to that agent.
 */
export function AgentQuadrant({ runMap, burningRunIds, onFocusRun }: Props) {
  const alive = useMemo(() => {
    const out: Run[] = []
    for (const run of runMap.values()) {
      if (run.status !== 'stopped') out.push(run)
    }
    return out
  }, [runMap])

  const cells = useMemo(() => {
    const byCell: Record<CellKey, Run[]> = { working: [], subagent: [], tool: [], idle: [] }
    for (const run of alive) {
      const busy = run.status === 'running'
      const burning = burningRunIds.has(run.id)
      const key: CellKey =
        busy && burning ? 'working' :
        !busy && burning ? 'subagent' :
        busy && !burning ? 'tool' : 'idle'
      byCell[key].push(run)
    }
    return byCell
  }, [alive, burningRunIds])

  if (alive.length === 0) return null

  // Grid: narrow left rail for y-axis labels, then two equal-width cell columns.
  const gridCols = '14px 1fr 1fr'

  return (
    <div
      data-testid="agent-quadrant"
      className="mt-3"
      role="region"
      aria-label="Agent activity quadrant: READY vs BUSY by LLM activity (up and right = more active)"
    >
      {/* Column header row */}
      <div className="grid gap-[2px] mb-1" style={{ gridTemplateColumns: gridCols }}>
        <div />
        <div className="quadrant-axis-x">READY</div>
        <div className="quadrant-axis-x">BUSY</div>
      </div>
      {/* Top row: LLM (both cells are "talking to Claude") */}
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: gridCols }}>
        <div className="flex items-center justify-center">
          <span className="quadrant-axis-y">LLM</span>
        </div>
        <Cell label="SUBAGENT" dataKey="subagent" runs={cells.subagent} onFocusRun={onFocusRun} isLLM />
        <Cell label="WORKING"  dataKey="working"  runs={cells.working}  onFocusRun={onFocusRun} isLLM />
      </div>
      {/* Bottom row: quiet (no LLM activity) */}
      <div className="grid gap-[2px] mt-[2px]" style={{ gridTemplateColumns: gridCols }}>
        <div className="flex items-center justify-center">
          <span className="quadrant-axis-y">QUIET</span>
        </div>
        <Cell label="IDLE" dataKey="idle" runs={cells.idle} onFocusRun={onFocusRun} />
        <Cell label="TOOL" dataKey="tool" runs={cells.tool} onFocusRun={onFocusRun} />
      </div>
    </div>
  )
}

interface CellProps {
  label: string
  dataKey: CellKey
  runs: Run[]
  onFocusRun: (runId: string) => void
  isLLM?: boolean
}

function Cell({ label, dataKey, runs, onFocusRun, isLLM }: CellProps) {
  const classes = [
    'quadrant-cell',
    `quadrant-cell-${dataKey}`,
    isLLM ? 'quadrant-cell-llm' : '',
  ].filter(Boolean).join(' ')

  return (
    <div data-testid={`quadrant-cell-${dataKey}`} className={classes}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="quadrant-cell-label">{label}</span>
        <span className="quadrant-cell-label" style={{ opacity: 0.7 }}>
          {runs.length > 0 ? runs.length : ''}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {runs.map(run => (
          <AgentAvatar
            key={run.id}
            run={run}
            onClick={() => onFocusRun(run.id)}
          />
        ))}
      </div>
    </div>
  )
}

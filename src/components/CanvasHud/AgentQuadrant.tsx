import { useMemo } from 'react'
import type { Run } from '../../domain/types'
import { AgentAvatar } from './AgentAvatar'

type CellKey = 'working' | 'subagent' | 'tool' | 'idle'

interface Props {
  runMap: Map<string, Run>
  burningRunIds: Set<string>
  onFocusRun: (runId: string) => void
}

/**
 * 2x2 quadrant showing every alive agent, placed by:
 *   x-axis: BUSY (status=running)   vs  READY (idle/needs_attention/creating)
 *   y-axis: LLM (in burning set)    vs  quiet (not)
 *
 * Cells:
 *   BUSY + LLM    -> WORKING      (honest work)
 *   READY + LLM   -> SUBAGENT     (parent idle, subagent burning)
 *   BUSY + quiet  -> TOOL         (bash/file/build running, no LLM)
 *   READY + quiet -> IDLE         (truly resting)
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

  return (
    <div
      data-testid="agent-quadrant"
      className="mt-3"
      role="region"
      aria-label="Agent activity quadrant: READY vs BUSY by LLM activity (up and right = more active)"
    >
      {/* Header row with axis labels — up and right = more active */}
      <div className="grid grid-cols-[1fr_1fr] gap-[2px] text-[9px] font-semibold tracking-widest text-slate-400 mb-[2px]">
        <div className="text-center">READY</div>
        <div className="text-center">BUSY</div>
      </div>
      {/* Top row: LLM (both cells are "talking to Claude") */}
      <div className="grid grid-cols-[1fr_1fr] gap-[2px]">
        <Cell label="SUBAGENT" dataKey="subagent" runs={cells.subagent} onFocusRun={onFocusRun} axisLabel="LLM" />
        <Cell label="WORKING" dataKey="working" runs={cells.working} onFocusRun={onFocusRun} />
      </div>
      {/* Bottom row: quiet (no LLM activity) */}
      <div className="grid grid-cols-[1fr_1fr] gap-[2px] mt-[2px]">
        <Cell label="IDLE" dataKey="idle" runs={cells.idle} onFocusRun={onFocusRun} axisLabel="quiet" />
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
  axisLabel?: string
}

function Cell({ label, dataKey, runs, onFocusRun, axisLabel }: CellProps) {
  return (
    <div
      data-testid={`quadrant-cell-${dataKey}`}
      style={{
        background: 'rgba(168,85,247,0.06)',
        border: '1px solid rgba(180,200,230,0.12)',
        borderRadius: 4,
        padding: 6,
        minHeight: 64,
        position: 'relative',
      }}
    >
      <div style={{
        fontSize: 8, letterSpacing: 1.5, opacity: 0.55,
        fontWeight: 700, color: '#cbd5e1', marginBottom: 4,
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>{label}</span>
        <span style={{ opacity: 0.6 }}>{runs.length > 0 ? runs.length : ''}</span>
      </div>
      {axisLabel && (
        <div style={{
          position: 'absolute', left: -26, top: '50%', transform: 'translateY(-50%) rotate(-90deg)',
          fontSize: 8, letterSpacing: 1.5, fontWeight: 700, color: '#94a3b8', opacity: 0.7,
          pointerEvents: 'none',
        }}>{axisLabel}</div>
      )}
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

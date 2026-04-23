import { useMemo } from 'react'
import type { Run } from '../../domain/types'
import { AgentAvatar } from './AgentAvatar'
import './hud.css'

type CellKey = 'working' | 'cooling' | 'tool' | 'idle'

interface Props {
  runMap: Map<string, Run>
  burningRunIds: Set<string>
  onFocusRun: (runId: string) => void
  selectedRunIds?: Set<string>
}

/**
 * 2x2 quadrant showing every alive agent, placed by:
 *   x-axis: READY (idle/needs_attention/creating)  vs  BUSY (status=running)
 *   y-axis: LLM (in burning set)                   vs  quiet (not)
 *
 * Up-and-right = most active, following dashboard convention.
 *
 *                 READY                  BUSY
 *  TALKING   COOLING (cyan)         WORKING (amber)     ← animated particles
 *   quiet    IDLE    (slate)        TOOL    (ochre)
 *
 * Clicking an avatar calls onFocusRun to pan the canvas to that agent.
 */
export function AgentQuadrant({ runMap, burningRunIds, onFocusRun, selectedRunIds }: Props) {
  const alive = useMemo(() => {
    const out: Run[] = []
    for (const run of runMap.values()) {
      if (run.status !== 'stopped') out.push(run)
    }
    return out
  }, [runMap])

  const cells = useMemo(() => {
    const byCell: Record<CellKey, Run[]> = { working: [], cooling: [], tool: [], idle: [] }
    for (const run of alive) {
      const busy = run.status === 'running'
      const burning = burningRunIds.has(run.id)
      const key: CellKey =
        busy && burning ? 'working' :
        !busy && burning ? 'cooling' :
        busy && !burning ? 'tool' : 'idle'
      byCell[key].push(run)
    }
    return byCell
  }, [alive, burningRunIds])

  if (alive.length === 0) return null

  // Grid: narrow left rail for y-axis labels, then two equal-width cell columns.
  const gridCols = '14px 1fr 1fr'

  const regionTooltip =
    'Agent activity quadrant.\n' +
    'X-axis: READY ↔ BUSY.\n' +
    'Y-axis: QUIET ↔ TALKING.\n' +
    'Up-and-right = most active. Hover a quadrant for what it means.'

  return (
    <div
      data-testid="agent-quadrant"
      className="mt-3"
      role="region"
      aria-label="Agent activity quadrant: READY vs BUSY by TALKING vs QUIET (up and right = more active)"
      title={regionTooltip}
    >
      {/* Column header row */}
      <div className="grid gap-[2px] mb-1" style={{ gridTemplateColumns: gridCols }}>
        <div />
        <div className="quadrant-axis-x">READY</div>
        <div className="quadrant-axis-x">BUSY</div>
      </div>
      {/* Top row: TALKING — a token turn is open. */}
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: gridCols }}>
        <div className="flex items-center justify-center">
          <span className="quadrant-axis-y">TALKING</span>
        </div>
        <Cell
          label="COOLING"
          dataKey="cooling"
          runs={cells.cooling}
          onFocusRun={onFocusRun}
          selectedRunIds={selectedRunIds}
          isLLM
          tooltip={'COOLING — the dashboard catching up.\nUsually a reporting delay, not a real state. Token activity is averaged over the last 30 seconds, so an agent that just stopped talking can sit here briefly while the window empties.'}
        />
        <Cell
          label="WORKING"
          dataKey="working"
          runs={cells.working}
          onFocusRun={onFocusRun}
          selectedRunIds={selectedRunIds}
          isLLM
          tooltip={'WORKING — the agent is thinking.\nActively working out its next step. The most engaged state.'}
        />
      </div>
      {/* Bottom row: quiet (no LLM activity) */}
      <div className="grid gap-[2px] mt-[2px]" style={{ gridTemplateColumns: gridCols }}>
        <div className="flex items-center justify-center">
          <span className="quadrant-axis-y">QUIET</span>
        </div>
        <Cell
          label="IDLE"
          dataKey="idle"
          runs={cells.idle}
          onFocusRun={onFocusRun}
          selectedRunIds={selectedRunIds}
          tooltip={'IDLE — waiting for you.\nNothing is happening. The agent is parked until you say something.'}
        />
        <Cell
          label="TOOL"
          dataKey="tool"
          runs={cells.tool}
          onFocusRun={onFocusRun}
          selectedRunIds={selectedRunIds}
          tooltip={'TOOL — waiting on a tool.\nThe agent kicked off a bash / edit / read and is waiting for it to finish. No thinking happening right now.'}
        />
      </div>
    </div>
  )
}

interface CellProps {
  label: string
  dataKey: CellKey
  runs: Run[]
  onFocusRun: (runId: string) => void
  selectedRunIds?: Set<string>
  isLLM?: boolean
  tooltip?: string
}

function Cell({ label, dataKey, runs, onFocusRun, selectedRunIds, isLLM, tooltip }: CellProps) {
  const classes = [
    'quadrant-cell',
    `quadrant-cell-${dataKey}`,
    isLLM ? 'quadrant-cell-llm' : '',
  ].filter(Boolean).join(' ')

  return (
    <div data-testid={`quadrant-cell-${dataKey}`} className={classes} title={tooltip}>
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
            selected={selectedRunIds?.has(run.id)}
          />
        ))}
      </div>
    </div>
  )
}

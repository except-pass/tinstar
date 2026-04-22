import { AgentIcon } from '../agentIcon'
import type { Run } from '../../domain/types'
import { resolveRunAccent } from '../runAccent'

interface Props {
  run: Run
  onClick: () => void
}

/**
 * A single agent's clickable avatar. Round ring tinted with run.color,
 * containing the AgentIcon (template icon or procedural DiceBear).
 * Click pans the canvas to this agent via onClick → onFocusRun(run.id).
 */
export function AgentAvatar({ run, onClick }: Props) {
  const color = resolveRunAccent(run.color)
  return (
    <button
      type="button"
      onClick={onClick}
      title={run.sessionId}
      data-testid="agent-avatar"
      data-run-id={run.id}
      className="relative inline-flex items-center justify-center"
      style={{
        width: 26,
        height: 26,
        borderRadius: '50%',
        border: `1.5px solid ${color}`,
        background: 'rgba(15,23,42,0.6)',
        padding: 0,
        cursor: 'pointer',
      }}
    >
      <AgentIcon
        icon={run.agentIcon}
        seed={run.id}
        color={color}
        className="w-5 h-5"
      />
    </button>
  )
}

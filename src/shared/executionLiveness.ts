import { codexFallback, codexTurn } from './codexActivity'
import type { Execution } from '../server/reconciliation/scene'
import type { ExecutionLiveness } from '../domain/execution-liveness'
import { childOutcomeVerb } from './childOutcome'

function retainedExecutionStatus(task: Execution['source'], now = Date.now()): ExecutionLiveness | 'blocked' {
  if (!task.identity.task_id || !task.identity.spawn_gen) return 'liveness-not-observed'
  const turn = codexTurn(task, now)
  if (turn !== null) return turn ? 'running' : 'waiting'
  if (codexFallback(task) && task.codex !== undefined) return 'liveness-not-observed'
  // Status events describe intent even when the harness cannot report codex state.
  // Read only the event verb: prose mentioning “working” is not a working event.
  const child = childOutcomeVerb({ kind: task.kind, paths: { status_log: { last_event: { raw: task.lastEventText ?? task.last_event.raw } } } })
  const reportedEvent = task.lastEventText?.trim().match(/^([a-z-]+)(?=\s|:|$)/i)?.[1]?.toLowerCase() ?? (typeof task.last_event.state === 'string' ? task.last_event.state.toLowerCase() : null)
  const event = child ? null : reportedEvent
  const reportedState = String(task.current_state.state).toLowerCase()
  const state = child === reportedState && (!task.current_state.source || task.current_state.source === 'status-log') ? 'unknown' : reportedState
  if (event === 'done' || event === 'landed') return 'finished'
  if (task.endpoint.exists === false || task.endpoint.agent_alive === 'dead' || task.endpoint.status === 'dead') return 'absent'
  if (task.endpoint.exists !== true) {
    if (task.current_state.freshness !== 'fresh' || task.current_state.source !== 'pane') return 'liveness-not-observed'
    if (state === 'working') return 'running'
    if (['waiting', 'parked', 'blocked', 'needs-decision'].includes(state)) return state === 'blocked' ? 'blocked' : 'waiting'
    return 'liveness-not-observed'
  }
  if (['paused', 'needs-decision', 'blocked', 'parked', 'held', 'waiting'].includes(event ?? '')) return event === 'blocked' ? 'blocked' : 'waiting'
  if (event === 'working' || event === 'resolved-to-working') return 'running'
  // A resolution closes a blocker, rather than claiming completion of the task.
  if (event === 'resolved') return 'running'
  if (['paused', 'needs-decision', 'blocked', 'parked', 'held', 'waiting'].includes(state)) return state === 'blocked' ? 'blocked' : 'waiting'
  if (['working', 'running', 'executing'].includes(state)) return 'running'
  if (['done', 'landed'].includes(state)) return 'finished'
  return 'liveness-not-observed'
}

export function retainedExecutionLiveness(task: Execution['source'], now = Date.now()): ExecutionLiveness {
  const status = retainedExecutionStatus(task, now)
  return status === 'blocked' ? 'waiting' : status
}

export function executionStatus(worker: Execution) {
  const turn = codexTurn(worker.source, Date.now())
  if (turn !== null) return turn ? 'Running' : 'Waiting'
  if (codexFallback(worker.source) && worker.source.codex !== undefined) return 'Unknown'
  const retained = retainedExecutionStatus(worker.source)
  const status = worker.liveness === 'liveness-not-observed' || worker.liveness === 'waiting' && retained === 'blocked' ? retained : worker.liveness
  return ({ running: 'Running', waiting: 'Waiting', blocked: 'Blocked', finished: 'Finished', absent: 'Unknown', 'liveness-not-observed': 'Unknown' })[status]
}

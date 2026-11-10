import type { Execution } from '../server/reconciliation/scene'
import { codexTurn } from './codexActivity'
import { ageLabel, reportTimestamp } from './workerTimestamps'

type Observation = Execution['observation']
const fresh = (observation: Observation, now: number) => observation.status === 'fresh' && observation.coverage === 'complete' &&
  (!observation.expiresAt || Date.parse(observation.expiresAt) > now)
const terminal = new Set(['done', 'landed', 'failed'])

/** A recorded terminal outcome stays history even if a terminal window remains.
 * Pane-derived state cannot establish completion or revive a finished task. */
function recordedOutcome(worker: Execution): string | null {
  const event = String(worker.source.lastEventText ?? worker.source.last_event.raw ?? '')
  const verb = event.trim().match(/^([a-z-]+)(?=\s|:|$)/i)?.[1]?.toLowerCase() ?? String(worker.source.last_event.state)
  const state = worker.source.current_state
  if (terminal.has(verb)) return verb
  if (state.source !== 'pane' && terminal.has(String(state.state))) return String(state.state)
  return worker.liveness === 'finished' && !(state.source === 'pane' && terminal.has(String(state.state))) ? 'done' : null
}
export const historyRecord = (worker: Execution) => recordedOutcome(worker) !== null || worker.liveness === 'absent' || worker.source.endpoint.exists === false
export const activeWorker = (worker: Execution) => worker.kind !== 'secondmate' && !historyRecord(worker)

export function recordedState(worker: Execution, now: number): string | null {
  const state = worker.source.current_state
  return fresh(worker.observation, now) && state.freshness === 'fresh' && state.source === 'run-step' ? String(state.state) : null
}

/** Crew-state and session logs are current evidence. Status events date the last
 * update; a historical working event never claims that work is still running. */
export function currentActivity(worker: Execution, now: number): 'working' | 'waiting' | 'terminal' | 'unknown' {
  if (recordedOutcome(worker)) return 'terminal'
  if (historyRecord(worker)) return 'unknown'
  if (!fresh(worker.observation, now)) return 'unknown'
  const state = worker.source.current_state
  const turn = codexTurn(state.source === 'pane' ? { ...worker.source, current_state: { state: 'unknown' } } : worker.source, now)
  if (turn !== null) return turn ? 'working' : 'waiting'
  const recorded = recordedState(worker, now)
  if (recorded === 'working') return 'working'
  if (['parked', 'paused', 'blocked'].includes(String(recorded))) return 'waiting'
  return 'unknown'
}

/** Shared owner-facing fact for card headers and worker chips. Source names stay
 * in the existing inspector evidence, never in this text. */
export function workerFact(worker: Execution, now: number, home: Observation | undefined, readFailed = false): string {
  if (readFailed || !home || !fresh(home, now)) return 'home unreachable'
  const activity = currentActivity(worker, now)
  if (activity === 'working') return 'running'
  if (activity === 'terminal') return recordedOutcome(worker) === 'failed' ? 'failed' : 'finished'
  if (activity === 'waiting') {
    const state = recordedState(worker, now)
    const age = state === worker.source.last_event.state ? ageLabel(reportTimestamp(worker), now) : 'Unknown'
    return `waiting${age === 'Unknown' ? '' : ` · reported ${age}`}`
  }
  const reported = reportTimestamp(worker)
  return Number.isFinite(reported) ? `no update since ${new Date(reported).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no update recorded'
}

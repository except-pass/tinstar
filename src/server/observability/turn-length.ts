import { Registry, Histogram } from 'prom-client'
import type { RecapEntry } from '../../types'
import type { Session, SessionState } from '../sessions/session'
import { log } from '../logger'

export const register = new Registry()

export const turnLengthHist = new Histogram({
  name: 'tinstar_turn_length_seconds',
  help: 'User-submit to assistant-done duration for a Claude Code turn',
  labelNames: ['tinstar_session', 'cc_conversation_id'],
  buckets: [1, 3, 10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [register],
})

interface PendingTurn {
  userTs: string
  lastAssistantTs: string | null
  ccConvId: string
}

const pending = new Map<string, PendingTurn>()

// Exposed for tests only
export function _resetForTests(): void {
  pending.clear()
  turnLengthHist.reset()
}

export function observeFromRecapEntries(_name: string, _entries: RecapEntry[], _session: Session): void {
  throw new Error('not implemented')
}

export function flushOnStateChange(_name: string, _newState: SessionState): void {
  throw new Error('not implemented')
}

export function reconcileLiveSessions(_currentNames: Set<string>): void {
  throw new Error('not implemented')
}

export async function getMetricsText(): Promise<string> {
  return register.metrics()
}

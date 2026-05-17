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

export function observeFromRecapEntries(name: string, entries: RecapEntry[], session: Session): void {
  for (const e of entries) {
    if (e.type === 'user') {
      flush(name)
      if (!e.timestamp) continue
      pending.set(name, {
        userTs: e.timestamp,
        lastAssistantTs: null,
        ccConvId: session.conversation.id ?? 'unknown',
      })
    } else if (e.type === 'agent') {
      const p = pending.get(name)
      if (p && e.timestamp) p.lastAssistantTs = e.timestamp
    }
  }
}

export function flushOnStateChange(_name: string, _newState: SessionState): void {
  throw new Error('not implemented')
}

export function reconcileLiveSessions(_currentNames: Set<string>): void {
  throw new Error('not implemented')
}

function flush(name: string): void {
  const p = pending.get(name)
  if (!p) return
  pending.delete(name)
  if (!p.lastAssistantTs) return
  const seconds = (Date.parse(p.lastAssistantTs) - Date.parse(p.userTs)) / 1000
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
    log.warn('turn-length', `dropping ${name}: out-of-range seconds=${seconds}`)
    return
  }
  try {
    turnLengthHist.labels(name, p.ccConvId).observe(seconds)
  } catch (err) {
    log.warn('turn-length', `observe failed for ${name}: ${(err as Error).message}`)
  }
}

export async function getMetricsText(): Promise<string> {
  return register.metrics()
}

import { Registry, Histogram } from 'prom-client'
import type { RecapEntry } from '../../types'
import type { Session, SessionState } from '../sessions/session'
import { log } from '../logger'

export interface Observation {
  tsSec: number
  sec: number
  session: string
  ccConvId: string
  /** Total tool_use blocks the agent emitted during the turn. */
  toolUses: number
}

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
  toolUses: number
}

const pending = new Map<string, PendingTurn>()

const RETENTION_SEC = 3600
const ringBuffer: Observation[] = []

function recordObservation(o: Observation): void {
  ringBuffer.push(o)
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SEC
  while (ringBuffer[0] && ringBuffer[0].tsSec < cutoff) ringBuffer.shift()
}

export function getRecentObservations(opts: { windowSec: number; session?: string }): Observation[] {
  const windowSec = Math.max(60, Math.min(3600, Math.floor(opts.windowSec)))
  const cutoff = Math.floor(Date.now() / 1000) - windowSec
  return ringBuffer.filter(o => {
    if (o.tsSec < cutoff) return false
    if (opts.session && o.session !== opts.session) return false
    return true
  })
}

// Exposed for tests only
export function _resetForTests(): void {
  pending.clear()
  turnLengthHist.reset()
  ringBuffer.length = 0
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
        toolUses: 0,
      })
    } else if (e.type === 'agent') {
      const p = pending.get(name)
      if (p && e.timestamp) p.lastAssistantTs = e.timestamp
      // Accumulate across every agent entry in the turn: a single turn can emit
      // multiple agent entries across successive incremental parse batches, each
      // carrying only the tool_use count from its own new records.
      if (p) p.toolUses += e.toolUses ?? 0
    }
  }
}

export function flushOnStateChange(name: string, newState: SessionState): void {
  if (newState !== 'stopped') return
  flush(name)
}

export function reconcileLiveSessions(currentNames: Set<string>): void {
  for (const name of pending.keys()) {
    if (!currentNames.has(name)) flush(name)
  }
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
  recordObservation({
    tsSec: Math.floor(Date.now() / 1000),
    sec: seconds,
    session: name,
    ccConvId: p.ccConvId,
    toolUses: p.toolUses,
  })
}

export async function getMetricsText(): Promise<string> {
  return register.metrics()
}

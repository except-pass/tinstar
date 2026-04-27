/**
 * Periodic NATS-control-socket health probe.
 *
 * For each tracked session, opens the MCP's UNIX control socket and runs the
 * existing `status` action. Three outcomes drive Session.natsControlOrphanedAt
 * (mirrored to the Run projection):
 *
 *   healthy   socket OK + natsState === 'connected' → clear flag, 30s cadence
 *   degraded  socket OK but natsState !== 'connected' → leave flag, slow probes
 *   orphaned  socket connect fails → set flag, slow probes
 *
 * Backoff: 30s base, doubling per failure, capped at 5min. Healthy resets.
 * Purely observability — failures here must never block real work.
 */

import { connect as netConnect } from 'node:net'
import { existsSync } from 'node:fs'
import { getSession, updateSession } from './sessions/session'
import type { DocumentStore } from './stores/document-store'
import { log } from './logger'

const BASE_INTERVAL_MS = 30_000
const MAX_INTERVAL_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 2_000
const TICK_INTERVAL_MS = 5_000

export interface ProbeOutcome {
  kind: 'healthy' | 'degraded' | 'orphaned'
  natsState?: string
  reason?: string
}

interface HealthState {
  nextProbeAt: number
  consecutiveFailures: number
}

export type ProbeFn = (socketPath: string) => Promise<ProbeOutcome>

export interface NatsHealthMonitorOpts {
  sessionsDir: string
  docStore: DocumentStore
  getSocketPath: (sessionName: string) => string | null
  /** Override for tests. Defaults to the real Unix-socket probe. */
  probe?: ProbeFn
}

/** 1 fail → 30s, 2 → 60s, 3 → 2m, 4 → 4m, 5+ → 5m (cap). */
export function backoffMs(failures: number): number {
  if (failures <= 0) return BASE_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, BASE_INTERVAL_MS * Math.pow(2, failures - 1))
}

export class NatsHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private states = new Map<string, HealthState>()
  private readonly sessionsDir: string
  private readonly docStore: DocumentStore
  private readonly getSocketPath: (n: string) => string | null
  private readonly probe: ProbeFn

  constructor(opts: NatsHealthMonitorOpts) {
    this.sessionsDir = opts.sessionsDir
    this.docStore = opts.docStore
    this.getSocketPath = opts.getSocketPath
    this.probe = opts.probe ?? defaultProbe
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(err => log.warn('nats-health', `tick error: ${(err as Error).message}`))
    }, TICK_INTERVAL_MS)
    const t = this.timer as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.states.clear()
  }

  trackSession(name: string): void {
    if (!this.states.has(name)) {
      this.states.set(name, { nextProbeAt: 0, consecutiveFailures: 0 })
    }
  }

  untrackSession(name: string): void {
    this.states.delete(name)
  }

  /** Test-only accessor. */
  __getState(name: string): HealthState | undefined {
    return this.states.get(name)
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const [name, state] of this.states) {
      if (now < state.nextProbeAt) continue
      const sess = getSession(this.sessionsDir, name)
      if (!sess || !sess.nats?.enabled) {
        state.nextProbeAt = now + BASE_INTERVAL_MS
        continue
      }
      const socketPath = this.getSocketPath(name)
      if (!socketPath) {
        state.nextProbeAt = now + BASE_INTERVAL_MS
        continue
      }
      let outcome: ProbeOutcome
      try {
        outcome = await this.probe(socketPath)
      } catch (err) {
        outcome = { kind: 'orphaned', reason: `probe threw: ${(err as Error).message}` }
      }
      this.applyOutcome(name, outcome, Date.now())
    }
  }

  /** State-machine step. Exposed for tests. */
  applyOutcome(name: string, outcome: ProbeOutcome, now: number): void {
    const state = this.states.get(name)
    if (!state) return
    if (outcome.kind === 'healthy') {
      state.consecutiveFailures = 0
      state.nextProbeAt = now + BASE_INTERVAL_MS
      this.maybeUpdateOrphanFlag(name, null)
    } else if (outcome.kind === 'orphaned') {
      state.consecutiveFailures += 1
      state.nextProbeAt = now + backoffMs(state.consecutiveFailures)
      this.maybeUpdateOrphanFlag(name, new Date(now).toISOString())
    } else {
      // degraded — MCP is alive and healing; back off but don't toggle flag.
      state.consecutiveFailures += 1
      state.nextProbeAt = now + backoffMs(state.consecutiveFailures)
      log.info('nats-health', `${name} degraded (natsState=${outcome.natsState ?? 'unknown'})`)
    }
  }

  private maybeUpdateOrphanFlag(name: string, value: string | null): void {
    const sess = getSession(this.sessionsDir, name)
    if (!sess) return
    if (sess.natsControlOrphanedAt === value) return
    updateSession(this.sessionsDir, name, { natsControlOrphanedAt: value })
    const run = this.docStore.getRun(name)
    if (run) this.docStore.upsertRun(name, { ...run, natsControlOrphanedAt: value })
    log.info('nats-health', `${name}: orphan flag ${value ? 'set' : 'cleared'}`)
  }
}

/** Real probe. Opens the Unix socket, sends `status`, parses the first reply. */
function defaultProbe(socketPath: string): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>(resolve => {
    if (!existsSync(socketPath)) {
      resolve({ kind: 'orphaned', reason: 'socket file missing' })
      return
    }
    const sock = netConnect(socketPath)
    let buf = ''
    let done = false
    const finish = (out: ProbeOutcome) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve(out)
    }
    const timer = setTimeout(() => finish({ kind: 'orphaned', reason: 'timeout' }), PROBE_TIMEOUT_MS)
    sock.once('connect', () => sock.write('{"action":"status"}\n'))
    sock.on('data', chunk => {
      buf += chunk.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl).trim()
      clearTimeout(timer)
      try {
        const reply = JSON.parse(line) as { natsState?: string }
        finish(reply.natsState === 'connected'
          ? { kind: 'healthy', natsState: reply.natsState }
          : { kind: 'degraded', natsState: reply.natsState })
      } catch (err) {
        finish({ kind: 'degraded', reason: `bad JSON: ${(err as Error).message}` })
      }
    })
    sock.once('error', () => {
      clearTimeout(timer)
      finish({ kind: 'orphaned', reason: 'connect refused' })
    })
  })
}

export const __forTests = { defaultProbe, BASE_INTERVAL_MS, MAX_INTERVAL_MS }

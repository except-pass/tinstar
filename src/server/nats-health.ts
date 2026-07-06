/**
 * Periodic NATS-control-socket health probe.
 *
 * For each tracked session, opens the MCP's UNIX control socket and runs the
 * existing `status` action. Outcomes drive Session.natsControlOrphanedAt
 * (mirrored to the Run projection):
 *
 *   healthy   socket OK + natsState in {'OPEN','connected'} → clear flag, 30s cadence
 *   degraded  socket OK but natsState is something else → leave flag, slow probes
 *   absent    socket *file* missing → MCP not running here (starting up, or
 *             stopped). NOT an orphan — never sets the flag. Slow probes.
 *   orphaned  socket file present but connect refused/timed out → the control
 *             listener is wedged. Only flips the flag after ORPHAN_CONFIRM_FAILS
 *             *consecutive* orphan probes, so a single startup/`/clear`/under-load
 *             blip can't make a healthy session look broken.
 *
 * The debounce matters: an enabled+running session whose channel-server MCP is
 * mid-relaunch briefly answers ENOENT (absent) or refuses (orphaned). Flagging
 * on the first failure produced constant false-positive amber dots that cleared
 * 30s later — the bulk of the "NATS is so flaky" noise. We now require
 * sustained failure before claiming orphaned, and (when a recover hook is wired)
 * escalate to recovery only after ORPHAN_RECOVER_FAILS.
 *
 * Backoff: 30s base, doubling per failure, capped at 5min. Healthy resets.
 * Purely observability + opt-in recovery — failures here must never block work.
 */

import { connect as netConnect } from 'node:net'
import { existsSync } from 'node:fs'
import { getSession, updateSession } from './sessions/session'
import type { DocumentStore } from './stores/document-store'
import { log } from './logger'

const BASE_INTERVAL_MS = 30_000
const MAX_INTERVAL_MS = 5 * 60_000
// 2s was tight enough that a busy host (many sessions + prometheus + nats) could
// time out a perfectly live socket and report a false orphan. 4s leaves headroom
// without making a genuinely-wedged probe feel slow — the debounce does the rest.
const PROBE_TIMEOUT_MS = 4_000
const TICK_INTERVAL_MS = 5_000

// Consecutive orphan-class probes required before we believe it. ~3 probes
// across the backoff curve (30s, 60s, 2m) ≈ a few minutes of sustained failure.
export const ORPHAN_CONFIRM_FAILS = 3
// Further sustained failure past confirmation before we escalate to the
// optional recovery hook. Generous on purpose: recovery restarts the session,
// which interrupts the agent, so we only do it when the orphan is clearly stuck.
export const ORPHAN_RECOVER_FAILS = 6

export interface ProbeOutcome {
  // 'absent' = control-socket *file* missing (MCP not running here). Distinct
  // from 'orphaned' (file present but listener wedged) — only the latter is a
  // real orphan; absent is the expected shape while an MCP is (re)launching.
  kind: 'healthy' | 'degraded' | 'orphaned' | 'absent'
  natsState?: string
  reason?: string
}

interface HealthState {
  nextProbeAt: number
  consecutiveFailures: number
  // Consecutive 'orphaned'-class probes. Reset by any non-orphan outcome
  // (healthy/degraded/absent). Drives the confirm + recover thresholds so a
  // transient blip can't flip the flag.
  orphanStreak: number
  // Set once we've fired the recovery hook for the current orphan episode, so a
  // long-lived orphan doesn't trigger recovery on every probe.
  recoveryFired: boolean
}

export type ProbeFn = (socketPath: string) => Promise<ProbeOutcome>

export interface NatsHealthMonitorOpts {
  sessionsDir: string
  docStore: DocumentStore
  getSocketPath: (sessionName: string) => string | null
  /** Override for tests. Defaults to the real Unix-socket probe. */
  probe?: ProbeFn
  /**
   * Optional recovery hook, fired once per orphan episode after
   * ORPHAN_RECOVER_FAILS consecutive orphan probes. Wire this to a real
   * recovery (e.g. restart the session so Claude relaunches the channel-server
   * MCP). Off by default — auto-recovery interrupts a live agent, so the host
   * only supplies it when configured to. Must never throw into the probe loop.
   */
  onConfirmedOrphan?: (sessionName: string) => void
}

/** 1 fail → 30s, 2 → 60s, 3 → 2m, 4 → 4m, 5+ → 5m (cap). */
export function backoffMs(failures: number): number {
  if (failures <= 0) return BASE_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, BASE_INTERVAL_MS * Math.pow(2, failures - 1))
}

export class NatsHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private states = new Map<string, HealthState>()
  // Names with a probe currently in flight — prevents same-session concurrency
  // when a slow probe outlives the tick interval.
  private inFlight = new Set<string>()
  private readonly sessionsDir: string
  private readonly docStore: DocumentStore
  private readonly getSocketPath: (n: string) => string | null
  private readonly probe: ProbeFn
  private readonly onConfirmedOrphan?: (sessionName: string) => void

  constructor(opts: NatsHealthMonitorOpts) {
    this.sessionsDir = opts.sessionsDir
    this.docStore = opts.docStore
    this.getSocketPath = opts.getSocketPath
    this.probe = opts.probe ?? defaultProbe
    this.onConfirmedOrphan = opts.onConfirmedOrphan
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
    this.inFlight.clear()
  }

  trackSession(name: string): void {
    if (!this.states.has(name)) {
      this.states.set(name, { nextProbeAt: 0, consecutiveFailures: 0, orphanStreak: 0, recoveryFired: false })
    }
  }

  untrackSession(name: string): void {
    this.states.delete(name)
  }

  /** Test-only accessor. */
  __getState(name: string): HealthState | undefined {
    return this.states.get(name)
  }

  /** Test-only: run one tick now (skips the interval timer). */
  __tickNow(): Promise<void> {
    return this.tick()
  }

  /** Test-only: inspect the in-flight guard set. */
  __inFlightSize(): number {
    return this.inFlight.size
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    // Probes run in parallel across sessions; the inFlight set prevents a
    // slow same-session probe from being launched twice on overlapping ticks.
    for (const [name, state] of this.states) {
      if (now < state.nextProbeAt) continue
      if (this.inFlight.has(name)) continue
      const sess = getSession(this.sessionsDir, name)
      // Stopped sessions: ENOENT on the control socket is the expected state
      // (their MCP isn't running), so don't probe and don't touch the flag.
      // Just defer the next attempt — they'll be re-evaluated next interval.
      if (!sess || !sess.nats?.enabled || sess.state === 'stopped') {
        state.nextProbeAt = now + BASE_INTERVAL_MS
        continue
      }
      const socketPath = this.getSocketPath(name)
      if (!socketPath) {
        state.nextProbeAt = now + BASE_INTERVAL_MS
        continue
      }
      const observedFlagAtStart = sess.natsControlOrphanedAt
      this.inFlight.add(name)
      // Fire-and-track: we don't await so other sessions' probes can run
      // concurrently. Errors are caught and converted to 'orphaned'.
      void (async () => {
        let outcome: ProbeOutcome
        try {
          outcome = await this.probe(socketPath)
        } catch (err) {
          outcome = { kind: 'orphaned', reason: `probe threw: ${(err as Error).message}` }
        } finally {
          this.inFlight.delete(name)
        }
        this.applyOutcome(name, outcome, Date.now(), observedFlagAtStart)
      })()
    }
  }

  /** State-machine step. Exposed for tests. */
  applyOutcome(name: string, outcome: ProbeOutcome, now: number, observedFlagAtStart: string | null = null): void {
    const state = this.states.get(name)
    // Session may have been untracked (or the monitor stopped) while a probe
    // was in flight — drop the result silently.
    if (!state) return

    if (outcome.kind === 'healthy') {
      state.consecutiveFailures = 0
      state.orphanStreak = 0
      state.recoveryFired = false
      state.nextProbeAt = now + BASE_INTERVAL_MS
      this.maybeUpdateOrphanFlag(name, null, observedFlagAtStart)
      return
    }

    // Every non-healthy outcome backs off the same way.
    state.consecutiveFailures += 1
    state.nextProbeAt = now + backoffMs(state.consecutiveFailures)

    if (outcome.kind === 'orphaned') {
      state.orphanStreak += 1
      // Debounce: only believe an orphan after sustained consecutive failures.
      // A single startup/`/clear`/under-load blip never flips the flag.
      if (state.orphanStreak < ORPHAN_CONFIRM_FAILS) {
        log.info('nats-health', `${name}: orphan probe ${state.orphanStreak}/${ORPHAN_CONFIRM_FAILS} (${outcome.reason ?? 'unreachable'}) — not flagging yet`)
        return
      }
      // Setting always wins — pass undefined to skip the freshness check.
      this.maybeUpdateOrphanFlag(name, new Date(now).toISOString(), undefined)
      // Escalate to recovery once, only when the orphan is clearly stuck.
      if (state.orphanStreak >= ORPHAN_RECOVER_FAILS && !state.recoveryFired && this.onConfirmedOrphan) {
        state.recoveryFired = true
        log.warn('nats-health', `${name}: orphan stuck ${state.orphanStreak} probes — firing recovery hook`)
        try { this.onConfirmedOrphan(name) } catch (err) {
          log.warn('nats-health', `${name}: recovery hook threw: ${(err as Error).message}`)
        }
      }
      return
    }

    // 'absent' (socket file missing — MCP not running here) or 'degraded' (MCP
    // alive but connection not OPEN). Neither is an orphan: reset the streak so
    // a later genuine orphan starts its debounce fresh, and leave the flag as-is
    // (an already-set flag clears only on a healthy probe).
    state.orphanStreak = 0
    if (outcome.kind === 'degraded') {
      log.info('nats-health', `${name} degraded (natsState=${outcome.natsState ?? 'unknown'})`)
    }
  }

  /**
   * Update the orphan flag with race protection.
   *
   * `expectedCurrentValue === undefined` → skip freshness check (used when
   * SETTING the flag; orphan path always wins). Otherwise, when CLEARING,
   * only proceed if the session's current value still matches what we
   * observed at probe-start; if someone else (e.g. routes.ts subscribe-
   * failure path) wrote a fresh ISO string while we were probing, leave
   * their value alone.
   */
  private maybeUpdateOrphanFlag(
    name: string,
    intendedValue: string | null,
    expectedCurrentValue: string | null | undefined,
  ): void {
    const sess = getSession(this.sessionsDir, name)
    if (!sess) return
    if (
      intendedValue === null &&
      expectedCurrentValue !== undefined &&
      sess.natsControlOrphanedAt !== expectedCurrentValue
    ) {
      log.info(
        'nats-health',
        `${name}: skipping stale clear (was ${expectedCurrentValue}, now ${sess.natsControlOrphanedAt})`,
      )
      return
    }
    if (sess.natsControlOrphanedAt === intendedValue) return
    updateSession(this.sessionsDir, name, { natsControlOrphanedAt: intendedValue })
    const run = this.docStore.getRun(name)
    if (run) this.docStore.upsertRun(name, { ...run, natsControlOrphanedAt: intendedValue })
    log.info('nats-health', `${name}: orphan flag ${intendedValue ? 'set' : 'cleared'}`)
  }
}

/**
 * Observed NATS state, straight from the channel-server's control socket.
 *
 * This is the single source of truth for "does this session have NATS": it
 * reflects the live connection and the subjects the server is *actually*
 * subscribed to — independent of session.nats config, CLI flags, or which
 * channel config happens to be on disk.
 *
 *   open      socket answered, natsState in {'OPEN','connected'}
 *   degraded  socket answered but connection isn't up (DRAINING/CLOSED/garbage)
 *   down      no socket / refused / timed out — i.e. no channel-server here
 */
export interface NatsLiveStatus {
  connection: 'open' | 'degraded' | 'down'
  subscriptions: string[]
  natsState?: string
  reason?: string
}

/** Pure mapping of a single status-reply line → NatsLiveStatus. Exposed for tests. */
export function mapStatusReply(line: string): NatsLiveStatus {
  try {
    const reply = JSON.parse(line) as { natsState?: string; subscriptions?: unknown }
    const subscriptions = Array.isArray(reply.subscriptions)
      ? reply.subscriptions.filter((s): s is string => typeof s === 'string')
      : []
    // channel-server emits 'OPEN' | 'DRAINING' | 'CLOSED'; older builds used
    // 'connected'. Both mean the NATS connection is up.
    const open = reply.natsState === 'OPEN' || reply.natsState === 'connected'
    return { connection: open ? 'open' : 'degraded', subscriptions, natsState: reply.natsState }
  } catch (err) {
    return { connection: 'degraded', subscriptions: [], reason: `bad JSON: ${(err as Error).message}` }
  }
}

/** One-shot probe of the channel-server control socket. Opens it, sends
 * `status`, and maps the first reply. Never rejects — failures resolve to
 * `down`, since "no answer" is itself the truth (no NATS here). */
export function probeNatsLiveStatus(socketPath: string): Promise<NatsLiveStatus> {
  return new Promise<NatsLiveStatus>(resolve => {
    if (!existsSync(socketPath)) {
      resolve({ connection: 'down', subscriptions: [], reason: 'socket file missing' })
      return
    }
    const sock = netConnect(socketPath)
    let buf = ''
    let done = false
    const finish = (out: NatsLiveStatus) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve(out)
    }
    const timer = setTimeout(() => finish({ connection: 'down', subscriptions: [], reason: 'timeout' }), PROBE_TIMEOUT_MS)
    sock.once('connect', () => sock.write('{"action":"status"}\n'))
    sock.on('data', chunk => {
      buf += chunk.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      finish(mapStatusReply(buf.slice(0, nl).trim()))
    })
    sock.once('error', () => {
      clearTimeout(timer)
      finish({ connection: 'down', subscriptions: [], reason: 'connect refused' })
    })
  })
}

/** Real probe for the health monitor — derives the orphan-tracking ProbeOutcome
 * from the same observed status used everywhere else.
 *
 * The `down` connection splits two ways: a missing socket *file* means the MCP
 * isn't running here (→ 'absent', benign — it's (re)launching or stopped),
 * whereas a present-but-unanswering socket (refused/timeout) is the real
 * wedged-listener orphan (→ 'orphaned', subject to the confirm debounce). */
function defaultProbe(socketPath: string): Promise<ProbeOutcome> {
  return probeNatsLiveStatus(socketPath).then(s => {
    if (s.connection === 'open') return { kind: 'healthy', natsState: s.natsState }
    if (s.connection === 'degraded') return { kind: 'degraded', natsState: s.natsState, reason: s.reason }
    if (s.reason === 'socket file missing') return { kind: 'absent', reason: s.reason }
    return { kind: 'orphaned', reason: s.reason }
  })
}

export const __forTests = { defaultProbe, BASE_INTERVAL_MS, MAX_INTERVAL_MS }

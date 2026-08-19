// Reap a session's NATS channel process at a trusted lifecycle boundary.
// Managed owner generations may be reset only after the session agent stops.
// Codex native root and child MCP commands share one orchestrator PPID, so a
// live-session relaunch cannot prove it is the root; that path refuses before
// signalling anything and directs the caller to restart the session.
//
// We match the process by its unique --control-socket path (one per session),
// so we never touch another session's channel-server or the tinstar host.
//
// Same lever runs on session stop/delete and as a start/create preflight: Codex
// (and friends) spawn nats-channel-mcp as a child that often reparents to
// systemd --user when the agent exits, keeping `/tmp/tinstar-nats-<session>.sock`
// forever. tmux kill-session does not reap those grandchildren, so the next
// required-MCP start dies with "control socket … already in use".

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import {
  acquireTransition,
  acquireTransitionWithoutRecovery,
  readOwnerEligibility,
  recordedPidIfMayBeAlive,
  recordedProcessGroupTargetIfMayBeAlive,
  readOwner as readOwnerSnapshot,
  releaseTransition,
  removeOwnerGeneration,
  removeOwnerEligibility,
  type TransitionRecord,
} from '../../../bin/nats-mcp-owner-state.js'
import { natsControlSocketPath, natsOwnerLockPath } from './nats-control'

const execFileAsync = promisify(execFile)
const REAP_TIMEOUT_MS = 2_000
const REAP_POLL_MS = 25

export interface ReconnectDeps {
  /** Unique control-socket path for the session — used to match the process. */
  socketPath: string
  /** Private per-session owner state. Omit only in isolated unit tests. */
  ownerLockPath?: string
  /** List PIDs whose full command line contains `needle`. Injectable for tests. */
  findPids?: (needle: string) => Promise<number[]>
  /** Send a signal to a pid. Injectable for tests. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Read live process or process-group targets from the owner generation. */
  readOwnerTargets?: (ownerLockPath: string) => number[]
  /** Check whether a targeted process still exists. Injectable for tests. */
  isAlive?: (pid: number) => boolean
  /** Bounded-wait hook. Injectable for tests. */
  wait?: (ms: number) => Promise<void>
  timeoutMs?: number
  /**
   * Reset the managed owner generation and incarnation after the session agent
   * is stopped. Live reconnect paths must leave this false: Codex root and
   * child MCP launches share one OS parent and cannot safely elect a successor.
   */
  resetOwnerState?: boolean
  /** Fault-injection hook for the eligibility-first retirement boundary. */
  afterOwnerEligibilityRemoved?: () => void
}

export class ManagedNatsRestartRequiredError extends Error {
  constructor(sessionName: string) {
    super(
      `managed NATS owner state for session '${sessionName}' cannot be reset while the session agent is running; restart the session instead`,
    )
    this.name = 'ManagedNatsRestartRequiredError'
  }
}

function defaultReadOwnerTargets(ownerLockPath: string): number[] {
  const owner = readOwnerSnapshot(ownerLockPath)
  if (!owner) return []
  if (owner.child?.channelGroup) {
    const target = recordedProcessGroupTargetIfMayBeAlive(owner.child.channelGroup)
    return target === undefined ? [] : [target]
  }
  const pid = recordedPidIfMayBeAlive(owner.child ?? owner.launcher)
  return pid === undefined ? [] : [pid]
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

interface TransitionLease {
  ownerLockPath: string
  record: TransitionRecord
}

/**
 * Keep only channel-server PIDs. Codex embeds `--control-socket <path>` in its
 * own argv, so a bare socket-path `pgrep -f` would SIGTERM the agent — the exact
 * failure that made `/nats-reconnect` lethal for codex-full-auto sessions.
 */
export function filterChannelServerPids(
  pids: number[],
  readCmdline: (pid: number) => string = readProcessCommand,
): number[] {
  const out: number[] = []
  for (const pid of pids) {
    try {
      const cmdline = readCmdline(pid)
      if (cmdline.includes('nats-channel-mcp') && !cmdline.includes('nats-mcp-launcher.js')) out.push(pid)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error
      // The process exited between pgrep and the command-line read.
    }
  }
  return out
}

export function readProcessCommand(pid: number): string {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  if (process.platform === 'darwin') {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  }
  throw Object.assign(
    new Error(`channel-server process discovery is unsupported on ${process.platform}`),
    { code: 'ENOTSUP' },
  )
}

/** Default: `pgrep -f -- <needle>`, then keep only nats-channel-mcp processes. */
async function defaultFindPids(needle: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', '--', needle])
    const candidates = stdout
      .split('\n')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n > 0)
    return filterChannelServerPids(candidates)
  } catch (error) {
    // pgrep status 1 is the documented no-match result. Execution and
    // inspection failures must abort lifecycle retirement rather than making a
    // live owner look absent.
    const code = (error as { code?: unknown } | null)?.code
    if (code === 1 || code === '1') return []
    throw error
  }
}

/**
 * SIGTERM the channel-server process(es) bound to this session's control socket.
 * Returns the PIDs signalled (empty if none were found — e.g. already gone).
 * A managed owner requires resetOwnerState after the session agent is stopped;
 * otherwise this refuses before process discovery or signalling. Individual
 * kill failures are swallowed because a process may exit between
 * discovery and SIGTERM. The operation fails closed when a targeted owner is
 * still alive after the bounded handoff window.
 */
export async function reconnectSessionNats(
  sessionName: string,
  deps: ReconnectDeps,
): Promise<{ sessionName: string; killed: number[] }> {
  const find = deps.findPids ?? defaultFindPids
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig))
  const readOwnerTargets = deps.readOwnerTargets ?? defaultReadOwnerTargets
  const isAlive = deps.isAlive ?? defaultIsAlive
  const wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const ownPid = process.pid
  const timeoutMs = deps.timeoutMs ?? REAP_TIMEOUT_MS
  const transitionRecord = deps.ownerLockPath
    ? deps.resetOwnerState
      ? await acquireTransition(deps.ownerLockPath, { wait, timeoutMs })
      : await acquireTransitionWithoutRecovery(deps.ownerLockPath, { wait, timeoutMs })
    : undefined
  if (deps.ownerLockPath && !transitionRecord) {
    throw new ManagedNatsRestartRequiredError(sessionName)
  }
  const transition = deps.ownerLockPath && transitionRecord
    ? { ownerLockPath: deps.ownerLockPath, record: transitionRecord } satisfies TransitionLease
    : undefined
  const deadline = Date.now() + timeoutMs
  const killed = new Set<number>()
  try {
    if (transition) {
      const owner = readOwnerSnapshot(transition.ownerLockPath)
      const eligibility = readOwnerEligibility(transition.ownerLockPath)
      if (!deps.resetOwnerState && (owner || eligibility)) {
        throw new ManagedNatsRestartRequiredError(sessionName)
      }
    }
    while (true) {
      const discovered = await find(deps.socketPath)
      const recorded = transition ? readOwnerTargets(transition.ownerLockPath) : []
      const targets = [...new Set([...discovered, ...recorded])]
        .filter(target => target !== ownPid && target !== -ownPid)
      for (const target of targets) {
        if (killed.has(target)) continue
        killed.add(target)
        try { kill(target, 'SIGTERM') } catch { /* process may have exited already */ }
      }
      const liveTargets = targets.filter(isAlive)

      if (transition && liveTargets.length === 0) {
        const owner = readOwnerSnapshot(transition.ownerLockPath)
        if (owner && deps.resetOwnerState) {
          // Invalidate the retired incarnation before removing its durable
          // generation tombstone. A crash between these writes then leaves the
          // owner record in place and every inherited old descriptor fails
          // closed as a reply-only follower.
          removeOwnerEligibility(transition.ownerLockPath)
          deps.afterOwnerEligibilityRemoved?.()
          removeOwnerGeneration(transition.ownerLockPath, owner.markerId)
        }
        if (deps.resetOwnerState && !readOwnerSnapshot(transition.ownerLockPath)) {
          removeOwnerEligibility(transition.ownerLockPath)
        }
      }

      const ownerRetired = !transition
        || (deps.resetOwnerState && !readOwnerSnapshot(transition.ownerLockPath))
        || (!deps.resetOwnerState && !readOwnerSnapshot(transition.ownerLockPath)
          && !readOwnerEligibility(transition.ownerLockPath))
      if (ownerRetired && liveTargets.length === 0) {
        return { sessionName, killed: [...killed].map(target => Math.abs(target)) }
      }
      if (Date.now() >= deadline) {
        const remaining = liveTargets.length > 0
          ? liveTargets.join(', ')
          : 'owner generation'
        throw new Error(`NATS channel-server processes did not exit: ${remaining}`)
      }
      await wait(REAP_POLL_MS)
    }
  } finally {
    if (transition) releaseTransition(transition.ownerLockPath, transition.record)
  }
}

/**
 * Lifecycle entry point: reclaim this session's NATS control socket before the
 * next channel-server bind (stop/delete teardown, or start/create preflight).
 * Thin wrapper over {@link reconnectSessionNats} with the stable socket path.
 */
export async function reapSessionNatsChannelServer(
  sessionName: string,
  sessionsDir: string,
  deps: Omit<ReconnectDeps, 'socketPath'> = {},
): Promise<{ sessionName: string; killed: number[] }> {
  const configuredOwnerLock = deps.ownerLockPath ?? natsOwnerLockPath(sessionsDir, sessionName)
  // Stop/delete cleanup can run after the per-session config directory has
  // already disappeared. No trusted owner generation can exist without that
  // directory, so retain the process/socket reap without recreating deleted
  // session state merely to publish a transition lease.
  const ownerLockPath = existsSync(dirname(configuredOwnerLock))
    ? configuredOwnerLock
    : undefined
  return reconnectSessionNats(sessionName, {
    ...deps,
    socketPath: natsControlSocketPath(sessionName),
    ownerLockPath,
  })
}

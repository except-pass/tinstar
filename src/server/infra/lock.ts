import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isSupportedProcessId,
  probeProcessLiveness,
  processMayBeAlive,
} from './process-liveness.js'

export type ReleaseFn = () => Promise<void>

const ACQUIRE_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

function markerDir(path: string): string {
  return `${path}.mark`
}

function ownerFile(dir: string): string {
  return join(dir, 'owner.json')
}

function tryCreateMarker(dir: string): boolean {
  try {
    mkdirSync(dir)
    try { writeFileSync(ownerFile(dir), JSON.stringify({ pid: process.pid, startedAt: Date.now() })) } catch { /* best effort */ }
    return true
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EEXIST') return false
    throw err
  }
}

function isOwnerAlive(dir: string): boolean {
  let pid: number
  try {
    const raw = readFileSync(ownerFile(dir), 'utf-8')
    const owner = JSON.parse(raw) as { pid: number }
    pid = owner.pid
    if (!isSupportedProcessId(pid)) return false
  } catch {
    return false
  }
  return processMayBeAlive(pid)
}

interface MarkerReplacementOps {
  removeMarker: (dir: string) => void
  createMarker: (dir: string) => boolean
}

const markerReplacementOps: MarkerReplacementOps = {
  removeMarker: dir => rmSync(dir, { recursive: true, force: true }),
  createMarker: tryCreateMarker,
}

interface MarkerReplacementOutcome {
  replaced: boolean
  removeError?: unknown
  createError?: unknown
}

function replaceMarker(
  dir: string,
  ops: Partial<MarkerReplacementOps> = {},
): MarkerReplacementOutcome {
  const removeMarker = ops.removeMarker ?? markerReplacementOps.removeMarker
  const createMarker = ops.createMarker ?? markerReplacementOps.createMarker
  let removeError: unknown
  try { removeMarker(dir) } catch (error) { removeError = error }
  try {
    return { replaced: createMarker(dir), removeError }
  } catch (createError) {
    return { replaced: false, removeError, createError }
  }
}

function stealLock(dir: string, ops: Partial<MarkerReplacementOps> = {}): boolean {
  const outcome = replaceMarker(dir, ops)
  // The generic lock APIs historically propagate unexpected marker-creation
  // failures. Only the backend singleton converts them into operator guidance.
  if (outcome.createError) throw outcome.createError
  return outcome.replaced
}

function makeRelease(dir: string): ReleaseFn {
  let released = false
  return async () => {
    if (released) return
    released = true
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* another process cleaned it up */ }
  }
}

interface LockAcquireDependencies {
  /** Overrides stale-marker replacement only; initial acquisition stays real. */
  markerReplacement?: Partial<MarkerReplacementOps>
}

export async function acquireLock(
  path: string,
  deps: LockAcquireDependencies = {},
): Promise<ReleaseFn> {
  mkdirSync(dirname(path), { recursive: true })
  const dir = markerDir(path)
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  let stealAttempted = false
  while (true) {
    if (tryCreateMarker(dir)) return makeRelease(dir)
    if (!stealAttempted && !isOwnerAlive(dir)) {
      stealAttempted = true
      if (stealLock(dir, deps.markerReplacement)) return makeRelease(dir)
    }
    if (Date.now() >= deadline) throw new Error(`timed out acquiring lock at ${path}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export async function tryAcquireLock(
  path: string,
  deps: LockAcquireDependencies = {},
): Promise<ReleaseFn | null> {
  mkdirSync(dirname(path), { recursive: true })
  const dir = markerDir(path)
  if (tryCreateMarker(dir)) return makeRelease(dir)
  if (!isOwnerAlive(dir) && stealLock(dir, deps.markerReplacement)) return makeRelease(dir)
  return null
}

// --- Backend singleton guard ---
//
// Only one backend may own a config dir at a time. Two backends sharing
// `~/.config/tinstar` independently assign ttyd ports from their own in-memory
// `claimedPorts` sets, so they collide on ports and start rival ttyds on the
// same port — which both starts the ttyd restart-war AND mis-binds the proxy
// (two runs → one port → one tmux), so `/s/runA` shows runB's terminal. The
// lock below makes that structurally impossible on a single config dir; a
// deliberate second instance still works via TINSTAR_CONFIG_HOME (different
// dir → different lock).

export type SingletonAction = 'acquire' | 'steal' | 'takeover' | 'refuse'

/** Pure decision for the singleton guard — see acquireBackendSingleton. */
export function decideSingletonAction(opts: {
  ownerPresent: boolean
  ownerAlive: boolean
  force: boolean
}): SingletonAction {
  if (!opts.ownerPresent) return 'acquire'
  if (!opts.ownerAlive) return 'steal'
  return opts.force ? 'takeover' : 'refuse'
}

function readOwnerPid(dir: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(ownerFile(dir), 'utf-8')) as { pid: number }
    return isSupportedProcessId(pid) ? pid : null
  } catch {
    return null
  }
}

export type SingletonFailure =
  | 'owner-retirement-permission-denied'
  | 'owner-retirement-unconfirmed'
  | 'owner-survived-sigkill'
  | 'marker-recreation-failed'

function uncertainRetirementFailure(
  pid: number,
  sigkillAttempted = false,
): SingletonFailure | null {
  const liveness = probeProcessLiveness(pid)
  if (liveness.state === 'gone') return null
  if (liveness.state === 'unknown' && liveness.code === 'EPERM') {
    return 'owner-retirement-permission-denied'
  }
  if (liveness.state === 'alive' && sigkillAttempted) return 'owner-survived-sigkill'
  return 'owner-retirement-unconfirmed'
}

function killAndWait(pid: number, timeoutMs = 3_000): SingletonFailure | null {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return uncertainRetirementFailure(pid)
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processMayBeAlive(pid)) return null
    const start = Date.now()
    while (Date.now() - start < 50) { /* brief spin — boot path, no event loop yet */ }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  const drainDeadline = Date.now() + 500
  while (Date.now() < drainDeadline) {
    if (!processMayBeAlive(pid)) return null
    const start = Date.now()
    while (Date.now() - start < 25) { /* brief spin — boot path, no event loop yet */ }
  }
  return uncertainRetirementFailure(pid, true)
}

/**
 * Read-only view of the singleton marker at `path`: the pid of the LIVE owner, or
 * `null` when no marker exists or its owner is gone.
 *
 * Exists so a component that DEPENDS on single-writer (the Surface sidecar) can
 * assert the guard is held without acquiring anything. Calling
 * `acquireBackendSingleton` for that check would be wrong twice over: it creates
 * the marker when none exists (turning "nobody guarded this" into a silent pass)
 * and it STEALS a dead owner's marker (turning a boot-ordering bug into a silent
 * pass). This is a read, not a second lock.
 */
export function backendSingletonOwner(path: string): number | null {
  const dir = markerDir(path)
  if (!isOwnerAlive(dir)) return null
  return readOwnerPid(dir)
}

export interface SingletonResult {
  acquired: boolean
  /** Action selected before acquisition; `acquired` and `failure` are its outcome. */
  action: SingletonAction
  /** Previously recorded owner PID when it remains relevant to the outcome. */
  ownerPid?: number
  failure?: SingletonFailure
  /** Safe operator-facing detail retained from a failed marker operation. */
  detail?: string
}

export interface SingletonFailureDescription {
  logMessage: string
  headline: string
  guidance: string
  detail?: string
}

export function formatSingletonFailureForConsole(
  description: SingletonFailureDescription,
): string {
  const detail = description.detail ? `\n  ${description.detail}` : ''
  return `\n✗ ${description.headline}${detail}\n  ${description.guidance}\n`
}

export function formatSingletonFailureForError(
  description: SingletonFailureDescription,
): string {
  const detail = description.detail ? ` (${description.detail})` : ''
  return `${description.headline}${detail} ${description.guidance}`
}

/** One operator-facing mapping shared by standalone and Vite-plugin startup. */
export function describeSingletonFailure(
  result: SingletonResult,
  configDir: string,
  options: { allowForce?: boolean } = {},
): SingletonFailureDescription {
  const who = result.ownerPid ? ` (pid ${result.ownerPid})` : ''
  switch (result.failure) {
    case 'owner-retirement-permission-denied':
      return {
        logMessage: `permission denied while stopping prior tinstar backend on ${configDir}${who}`,
        headline: `Permission was denied while stopping tinstar${who} after --force.`,
        guidance: 'Run as the process-owning user or stop that process with appropriate privileges.',
      }
    case 'owner-survived-sigkill':
      return {
        logMessage: `prior tinstar backend survived forced shutdown on ${configDir}${who}`,
        headline: `Tinstar${who} still exists after SIGTERM and SIGKILL.`,
        guidance: 'Inspect the process state and stop it manually before retrying.',
      }
    case 'owner-retirement-unconfirmed':
      return {
        logMessage: `could not confirm prior tinstar backend stopped on ${configDir}${who}`,
        headline: `Could not confirm that tinstar${who} stopped after --force.`,
        guidance: 'Inspect and stop that process manually before retrying.',
      }
    case 'marker-recreation-failed':
      return {
        logMessage: `could not claim the tinstar backend marker on ${configDir}${result.detail ? `: ${result.detail}` : ''}`,
        headline: `Could not claim the tinstar backend marker on ${configDir}.`,
        guidance: 'Another backend may have won the startup race, or the marker may be unremovable. Inspect the marker before retrying, or use a different TINSTAR_CONFIG_HOME.',
        ...(result.detail ? { detail: result.detail } : {}),
      }
    case undefined:
      return {
        logMessage: `another tinstar backend is already running on ${configDir}${who}`,
        headline: `Tinstar is already running on ${configDir}${who}.`,
        guidance: options.allowForce === false
          ? 'Stop it first, or use a different TINSTAR_CONFIG_HOME.'
          : 'Stop it first, use a different TINSTAR_CONFIG_HOME, or pass --force to take over.',
      }
    default: {
      const exhaustiveFailure: never = result.failure
      return {
        logMessage: `unrecognized tinstar backend singleton failure on ${configDir}: ${String(exhaustiveFailure)}${result.detail ? `: ${result.detail}` : ''}`,
        headline: `Could not acquire the tinstar backend marker on ${configDir}.`,
        guidance: 'Inspect the marker and backend logs before retrying, or use a different TINSTAR_CONFIG_HOME.',
        ...(result.detail ? { detail: result.detail } : {}),
      }
    }
  }
}

function describeMarkerError(error: unknown): string | undefined {
  if (error === undefined) return undefined
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code && !error.message.startsWith(`${code}:`)
      ? `${code}: ${error.message}`
      : error.message
  }
  return String(error)
}

/**
 * Synchronously acquire the backend singleton lock at `path`.
 *
 * Sync (not the async acquireLock) because it runs at the very top of boot,
 * before the event loop is doing useful work, and the rest of startup is sync
 * up to listen(). On `force`, the live owner is SIGTERM'd (then SIGKILL'd) and
 * the lock stolen. Without `force`, a live owner means we refuse.
 */
export function acquireBackendSingleton(
  path: string,
  opts: { force?: boolean } = {},
  deps: LockAcquireDependencies = {},
): SingletonResult {
  mkdirSync(dirname(path), { recursive: true })
  const dir = markerDir(path)

  if (tryCreateMarker(dir)) return { acquired: true, action: 'acquire' }

  const ownerPid = readOwnerPid(dir)
  const ownerAlive = isOwnerAlive(dir)
  const action = decideSingletonAction({ ownerPresent: true, ownerAlive, force: opts.force ?? false })

  if (action === 'refuse') {
    return { acquired: false, action, ownerPid: ownerPid ?? undefined }
  }
  if (action === 'takeover' && ownerPid) {
    const failure = killAndWait(ownerPid)
    if (failure) {
      return {
        acquired: false,
        action: 'takeover',
        ownerPid,
        failure,
      }
    }
  }
  // 'steal' (dead owner) or post-takeover: clear and re-create the marker.
  const replacement = replaceMarker(dir, deps.markerReplacement)
  if (replacement.replaced) return { acquired: true, action }
  // Failure can mean either a competing creator won the race or the old marker
  // could not be removed. Neither case proves which process owns the marker.
  const detail = describeMarkerError(replacement.createError ?? replacement.removeError)
  return {
    acquired: false,
    action,
    failure: 'marker-recreation-failed',
    ...(detail ? { detail } : {}),
  }
}

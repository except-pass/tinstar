import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  compareProcessIdentity,
  isSupportedProcessId,
  processIdentity,
  probeProcessLiveness,
} from './process-liveness.js'

export type ReleaseFn = () => Promise<void>

const ACQUIRE_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50
// Leave enough of acquireLock's five-second budget to reclaim a claimant that
// crashed immediately after publishing its recovery marker.
const RECOVERY_CLAIM_STALE_MS = ACQUIRE_TIMEOUT_MS - 1_000
const activeRecoveryClaims = new Set<string>()

function markerDir(path: string): string {
  return `${path}.mark`
}

function ownerFile(dir: string): string {
  return join(dir, 'owner.json')
}

interface MarkerPublication {
  created: boolean
  owner?: string
}

function publishMarker(
  dir: string,
  deps: Pick<LockAcquireDependencies, 'processIdentity' | 'beforeMarkerPublish'> = {},
): MarkerPublication {
  // Avoid an OS process-identity lookup on the normal contended path. This is
  // only an optimization: the atomic rename below remains the ownership gate.
  if (existsSync(dir)) return { created: false }
  const identity = (deps.processIdentity ?? processIdentity)(process.pid)
  const stagingDir = mkdtempSync(`${dir}.pending-`)
  let published = false
  try {
    const owner = JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      markerId: randomUUID(),
      ...(identity ? { processIdentity: identity } : {}),
    })
    writeFileSync(ownerFile(stagingDir), owner)
    deps.beforeMarkerPublish?.(dir)
    renameSync(stagingDir, dir)
    published = true
    return { created: true, owner }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') return { created: false }
    throw err
  } finally {
    if (!published) {
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* abandoned staging dirs are not locks */ }
    }
  }
}

function tryCreateMarker(
  dir: string,
  deps: Pick<LockAcquireDependencies, 'processIdentity' | 'beforeMarkerPublish'> = {},
): boolean {
  return publishMarker(dir, deps).created
}

interface LockAcquireDependencies {
  /** Fault-injection seam for stale-marker replacement. */
  markerReplacement?: Partial<MarkerReplacementOps>
  /** Fault-injection seam for releasing an acquired marker. */
  releaseMarker?: (dir: string) => void
  /** Fault-injection seam for releasing the stale-owner recovery claim. */
  releaseRecoveryClaim?: (dir: string) => void
  /** Process probes used by acquisition and stale-owner recovery. */
  probeProcessLiveness?: typeof probeProcessLiveness
  processIdentity?: typeof processIdentity
  /** Fault-injection seam immediately before a staged marker is published. */
  beforeMarkerPublish?: (dir: string) => void
}

function isOwnerAlive(dir: string, deps: LockAcquireDependencies = {}): boolean {
  let owner: { pid: number; processIdentity?: string }
  try {
    const raw = readFileSync(ownerFile(dir), 'utf-8')
    owner = JSON.parse(raw) as { pid: number; processIdentity?: string }
    if (!isSupportedProcessId(owner.pid)) return false
  } catch {
    return false
  }
  const liveness = (deps.probeProcessLiveness ?? probeProcessLiveness)(owner.pid)
  if (liveness.state === 'gone' || liveness.state === 'invalid') return false
  if (owner.processIdentity) {
    const currentIdentity = (deps.processIdentity ?? processIdentity)(owner.pid)
    if (
      currentIdentity
      && compareProcessIdentity(owner.processIdentity, currentIdentity) === 'different'
    ) return false
  }
  return liveness.state === 'alive' || liveness.state === 'unknown'
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
  claimReleaseError?: unknown
  lingeringClaim?: RecoveryClaim
}

interface RecoveryClaim {
  dir: string
  owner: string
}

function readOwnerRecord(dir: string): {
  raw: string
  pid?: number
  processIdentity?: string
  startedAt?: number
} | null {
  try {
    const raw = readFileSync(ownerFile(dir), 'utf-8')
    const parsed = JSON.parse(raw) as {
      pid?: unknown
      processIdentity?: unknown
      startedAt?: unknown
    }
    return {
      raw,
      ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
      ...(typeof parsed.processIdentity === 'string'
        ? { processIdentity: parsed.processIdentity }
        : {}),
      ...(typeof parsed.startedAt === 'number' ? { startedAt: parsed.startedAt } : {}),
    }
  } catch {
    return null
  }
}

function recoveryClaimIsFresh(dir: string): boolean {
  const startedAt = readOwnerRecord(dir)?.startedAt
  if (startedAt === undefined) return false
  const age = Date.now() - startedAt
  return age >= 0 && age < RECOVERY_CLAIM_STALE_MS
}

function recoveryClaimIsOwned(claim: RecoveryClaim): boolean {
  return readOwnerRecord(claim.dir)?.raw === claim.owner
}

function releaseOwnedRecoveryClaim(
  claim: RecoveryClaim,
  deps: LockAcquireDependencies,
): void {
  // Conditional deletion is implemented as move, verify, then remove. A plain
  // read-then-rm has a TOCTOU window where a delayed contender can displace our
  // generation and install a successor between the two operations.
  const canonicalDir = claim.dir
  const releaseDir = `${canonicalDir}.release-${randomUUID()}`
  try {
    renameSync(canonicalDir, releaseDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  if (readOwnerRecord(releaseDir)?.raw !== claim.owner) {
    try { renameSync(releaseDir, canonicalDir) } catch { /* preserve the displaced generation */ }
    return
  }

  claim.dir = releaseDir
  try {
    removeReleasedMarker(releaseDir, deps.releaseRecoveryClaim)
  } catch (error) {
    // Restore the canonical name when it is still free so the same process can
    // adopt this exact generation and retry a transient cleanup failure.
    try {
      renameSync(releaseDir, canonicalDir)
      claim.dir = canonicalDir
    } catch { /* a successor already owns the canonical path */ }
    throw error
  }
}

function tryAcquireRecoveryClaim(
  dir: string,
  deps: LockAcquireDependencies,
): RecoveryClaim | null {
  const existing = readOwnerRecord(dir)
  // A failed cleanup leaves our completed claim in place. Once the synchronous
  // replacement attempt has unwound, the same process may adopt that exact
  // claim and retry cleanup on its next acquisition attempt. Active re-entrant
  // contenders remain excluded by the process-local set.
  if (
    existing?.pid === process.pid
    && !activeRecoveryClaims.has(dir)
  ) {
    activeRecoveryClaims.add(dir)
    return { dir, owner: existing.raw }
  }
  if (tryCreateMarker(dir, deps)) {
    const owner = readOwnerRecord(dir)?.raw
    if (!owner) return null
    activeRecoveryClaims.add(dir)
    return { dir, owner }
  }
  if (isOwnerAlive(dir, deps) || recoveryClaimIsFresh(dir)) return null

  // Move an abandoned claim aside before replacing it. Re-check the moved
  // record so a delayed contender that picked up a newly-created live claim
  // restores it instead of acting on an earlier stale observation.
  const abandonedDir = `${dir}.abandoned-${randomUUID()}`
  const observedOwner = existing?.raw ?? null
  try {
    renameSync(dir, abandonedDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return null
    throw error
  }
  const displacedOwner = readOwnerRecord(abandonedDir)?.raw ?? null
  if (displacedOwner !== observedOwner) {
    // The path changed after our stale observation. Restore that newer
    // generation when possible, and never treat it as abandoned.
    try { renameSync(abandonedDir, dir) } catch { /* another contender now owns the claim */ }
    return null
  }
  if (isOwnerAlive(abandonedDir, deps) || recoveryClaimIsFresh(abandonedDir)) {
    try { renameSync(abandonedDir, dir) } catch { /* another contender now owns the claim */ }
    return null
  }

  try {
    if (!tryCreateMarker(dir, deps)) return null
    const owner = readOwnerRecord(dir)?.raw
    if (!owner) return null
    activeRecoveryClaims.add(dir)
    return { dir, owner }
  } finally {
    try { rmSync(abandonedDir, { recursive: true, force: true }) } catch { /* not an active claim */ }
  }
}

function replaceMarker(
  dir: string,
  deps: LockAcquireDependencies = {},
  ops: Partial<MarkerReplacementOps> = {},
): MarkerReplacementOutcome {
  // The recovery marker is the serialization point for stale-owner removal.
  // A contender must hold it, then re-check the owner while holding it, before
  // it may remove anything. This closes the gap where two contenders both saw
  // the old owner as stale and the slower one deleted the faster one's newly
  // published marker.
  const recoveryDir = `${dir}.recovery`
  let recoveryClaim: RecoveryClaim | null = null
  try {
    recoveryClaim = tryAcquireRecoveryClaim(recoveryDir, deps)
  } catch (createError) {
    return { replaced: false, createError }
  }
  if (!recoveryClaim) return { replaced: false }

  const removeMarker = ops.removeMarker ?? markerReplacementOps.removeMarker
  const createMarker = ops.createMarker
  let removeError: unknown
  let createError: unknown
  let replaced = false
  let createdOwner: string | undefined
  let claimReleaseError: unknown
  try {
    // The owner may have changed while this contender waited for the recovery
    // claim. Never act on the stale observation made by the caller.
    const claimStillOwned = recoveryClaimIsOwned(recoveryClaim)
    const primaryStillStale = claimStillOwned && !isOwnerAlive(dir, deps)
    if (primaryStillStale) {
      try { removeMarker(dir) } catch (error) { removeError = error }
      if (recoveryClaimIsOwned(recoveryClaim)) {
        try {
          if (createMarker) {
            replaced = createMarker(dir)
            if (replaced) createdOwner = readOwnerRecord(dir)?.raw
          } else {
            const publication = publishMarker(dir, deps)
            replaced = publication.created
            createdOwner = publication.owner
          }
        } catch (error) {
          createError = error
        }
      }
      if (replaced && !recoveryClaimIsOwned(recoveryClaim)) {
        // A delayed contender displaced our claim while we published. Do not
        // report ownership without the serialization generation that proved it.
        if (createdOwner) {
          try {
            if (readOwnerRecord(dir)?.raw === createdOwner) removeMarker(dir)
          } catch (error) {
            removeError ??= error
          }
        }
        replaced = false
      }
    }
  } finally {
    try {
      releaseOwnedRecoveryClaim(recoveryClaim, deps)
    } catch (error) {
      claimReleaseError = error
    } finally {
      activeRecoveryClaims.delete(recoveryDir)
    }
  }

  return {
    replaced,
    ...(removeError !== undefined ? { removeError } : {}),
    ...(createError !== undefined ? { createError } : {}),
    ...(claimReleaseError !== undefined ? { claimReleaseError } : {}),
    ...(replaced && claimReleaseError !== undefined ? { lingeringClaim: recoveryClaim } : {}),
  }
}

function stealLock(
  dir: string,
  deps: LockAcquireDependencies = {},
): { acquired: boolean; lingeringClaim?: RecoveryClaim } {
  const outcome = replaceMarker(dir, deps, deps.markerReplacement)
  // The generic lock APIs historically propagate unexpected marker-creation
  // failures. Only the backend singleton converts them into operator guidance.
  if (outcome.createError) throw outcome.createError
  return {
    acquired: outcome.replaced,
    ...(outcome.lingeringClaim ? { lingeringClaim: outcome.lingeringClaim } : {}),
  }
}

function removeReleasedMarker(
  dir: string,
  removeMarker: (dir: string) => void = markerReplacementOps.removeMarker,
): void {
  try {
    removeMarker(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return
    throw error
  }
}

function makeRelease(
  dir: string,
  deps: LockAcquireDependencies = {},
  lingeringClaim?: RecoveryClaim,
): ReleaseFn {
  let primaryReleased = false
  let claimReleased = lingeringClaim === undefined
  return async () => {
    if (!primaryReleased) {
      removeReleasedMarker(dir, deps.releaseMarker)
      primaryReleased = true
    }
    if (!claimReleased && lingeringClaim) {
      releaseOwnedRecoveryClaim(lingeringClaim, deps)
      claimReleased = true
    }
  }
}

export async function acquireLock(
  path: string,
  deps: LockAcquireDependencies = {},
): Promise<ReleaseFn> {
  mkdirSync(dirname(path), { recursive: true })
  const dir = markerDir(path)
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  while (true) {
    if (tryCreateMarker(dir, deps)) return makeRelease(dir, deps)
    if (!isOwnerAlive(dir, deps)) {
      const stolen = stealLock(dir, deps)
      if (stolen.acquired) return makeRelease(dir, deps, stolen.lingeringClaim)
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
  if (tryCreateMarker(dir, deps)) return makeRelease(dir, deps)
  if (!isOwnerAlive(dir, deps)) {
    const stolen = stealLock(dir, deps)
    if (stolen.acquired) return makeRelease(dir, deps, stolen.lingeringClaim)
  }
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

interface SingletonOwner {
  pid: number
  processIdentity?: string
}

function readSingletonOwner(dir: string): SingletonOwner | null {
  const record = readOwnerRecord(dir)
  if (!record || !isSupportedProcessId(record.pid)) return null
  return {
    pid: record.pid,
    ...(record.processIdentity ? { processIdentity: record.processIdentity } : {}),
  }
}

export type SingletonFailure =
  | 'owner-retirement-permission-denied'
  | 'owner-retirement-unconfirmed'
  | 'owner-survived-sigkill'
  | 'marker-recreation-failed'
  | 'recovery-claim-release-failed'

type OwnerLifetimeObservation =
  | { state: 'same' }
  | { state: 'gone' | 'replaced' }
  | { state: 'unknown'; failure: SingletonFailure }

function observeOwnerLifetime(
  pid: number,
  expectedIdentity: string | undefined,
  deps: LockAcquireDependencies,
): OwnerLifetimeObservation {
  if (!expectedIdentity) {
    return { state: 'unknown', failure: 'owner-retirement-unconfirmed' }
  }
  const liveness = (deps.probeProcessLiveness ?? probeProcessLiveness)(pid)
  if (liveness.state === 'gone' || liveness.state === 'invalid') return { state: 'gone' }
  const currentIdentity = (deps.processIdentity ?? processIdentity)(pid)
  if (!currentIdentity) {
    return { state: 'unknown', failure: 'owner-retirement-unconfirmed' }
  }
  const identityComparison = compareProcessIdentity(expectedIdentity, currentIdentity)
  if (identityComparison === 'different') return { state: 'replaced' }
  if (identityComparison === 'legacy-unscoped') {
    return { state: 'unknown', failure: 'owner-retirement-unconfirmed' }
  }
  if (liveness.state === 'unknown') {
    return {
      state: 'unknown',
      failure: liveness.code === 'EPERM'
        ? 'owner-retirement-permission-denied'
        : 'owner-retirement-unconfirmed',
    }
  }
  return { state: 'same' }
}

function completedOrFailure(
  observation: OwnerLifetimeObservation,
): SingletonFailure | null | undefined {
  if (observation.state === 'gone' || observation.state === 'replaced') return null
  if (observation.state === 'unknown') return observation.failure
  return undefined
}

function killAndWait(
  pid: number,
  expectedIdentity: string | undefined,
  deps: LockAcquireDependencies,
  timeoutMs = 3_000,
): SingletonFailure | null {
  const beforeTerm = completedOrFailure(observeOwnerLifetime(pid, expectedIdentity, deps))
  if (beforeTerm !== undefined) return beforeTerm
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return 'owner-retirement-permission-denied'
    }
    const afterSignalError = completedOrFailure(
      observeOwnerLifetime(pid, expectedIdentity, deps),
    )
    if (afterSignalError !== undefined) return afterSignalError
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const duringGrace = completedOrFailure(observeOwnerLifetime(pid, expectedIdentity, deps))
    if (duringGrace !== undefined) return duringGrace
    const start = Date.now()
    while (Date.now() - start < 50) { /* brief spin — boot path, no event loop yet */ }
  }
  const beforeKill = completedOrFailure(observeOwnerLifetime(pid, expectedIdentity, deps))
  if (beforeKill !== undefined) return beforeKill
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return 'owner-retirement-permission-denied'
    }
  }
  const drainDeadline = Date.now() + 500
  while (Date.now() < drainDeadline) {
    const duringDrain = completedOrFailure(observeOwnerLifetime(pid, expectedIdentity, deps))
    if (duringDrain !== undefined) return duringDrain
    const start = Date.now()
    while (Date.now() - start < 25) { /* brief spin — boot path, no event loop yet */ }
  }
  const finalObservation = observeOwnerLifetime(pid, expectedIdentity, deps)
  const finalResult = completedOrFailure(finalObservation)
  if (finalResult !== undefined) return finalResult
  return 'owner-survived-sigkill'
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
  return readSingletonOwner(dir)?.pid ?? null
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
    case 'recovery-claim-release-failed':
      return {
        logMessage: `could not release the tinstar backend recovery claim on ${configDir}${result.detail ? `: ${result.detail}` : ''}`,
        headline: `Could not release the tinstar backend recovery claim on ${configDir}.`,
        guidance: 'Inspect the adjacent .recovery marker before retrying, or use a different TINSTAR_CONFIG_HOME.',
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

  if (tryCreateMarker(dir, deps)) return { acquired: true, action: 'acquire' }

  const owner = readSingletonOwner(dir)
  const ownerPid = owner?.pid ?? null
  const ownerAlive = isOwnerAlive(dir, deps)
  const action = decideSingletonAction({ ownerPresent: true, ownerAlive, force: opts.force ?? false })

  if (action === 'refuse') {
    return { acquired: false, action, ownerPid: ownerPid ?? undefined }
  }
  if (action === 'takeover' && ownerPid) {
    const failure = killAndWait(ownerPid, owner?.processIdentity, deps)
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
  const replacement = replaceMarker(dir, deps, deps.markerReplacement)
  if (replacement.replaced) {
    if (replacement.lingeringClaim) {
      try {
        releaseOwnedRecoveryClaim(replacement.lingeringClaim, deps)
      } catch {
        // The singleton marker is already ours. Keep that ownership even if a
        // second recovery-claim cleanup attempt also fails; a future stale-lock
        // recovery can safely reclaim the claim by its recorded owner identity.
      }
    }
    return { acquired: true, action }
  }
  if (replacement.claimReleaseError) {
    const detail = describeMarkerError(replacement.claimReleaseError)
    return {
      acquired: false,
      action,
      failure: 'recovery-claim-release-failed',
      ...(detail ? { detail: `${dir}.recovery: ${detail}` } : {}),
    }
  }
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

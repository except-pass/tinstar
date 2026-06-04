import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  try {
    const raw = readFileSync(ownerFile(dir), 'utf-8')
    const { pid } = JSON.parse(raw) as { pid: number }
    if (typeof pid !== 'number' || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function stealLock(dir: string): boolean {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* someone else cleaned it */ }
  return tryCreateMarker(dir)
}

function makeRelease(dir: string): ReleaseFn {
  let released = false
  return async () => {
    if (released) return
    released = true
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* another process cleaned it up */ }
  }
}

export async function acquireLock(path: string): Promise<ReleaseFn> {
  mkdirSync(dirname(path), { recursive: true })
  const dir = markerDir(path)
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  let stealAttempted = false
  while (true) {
    if (tryCreateMarker(dir)) return makeRelease(dir)
    if (!stealAttempted && !isOwnerAlive(dir)) {
      stealAttempted = true
      if (stealLock(dir)) return makeRelease(dir)
    }
    if (Date.now() >= deadline) throw new Error(`timed out acquiring lock at ${path}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export async function tryAcquireLock(path: string): Promise<ReleaseFn | null> {
  mkdirSync(dirname(path), { recursive: true })
  const dir = markerDir(path)
  if (tryCreateMarker(dir)) return makeRelease(dir)
  if (!isOwnerAlive(dir) && stealLock(dir)) return makeRelease(dir)
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
    return typeof pid === 'number' && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function killAndWait(pid: number, timeoutMs = 3_000): void {
  try { process.kill(pid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return } // gone
    const start = Date.now()
    while (Date.now() - start < 50) { /* brief spin — boot path, no event loop yet */ }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

export interface SingletonResult {
  acquired: boolean
  action: SingletonAction
  /** pid of the live owner when we refused. */
  ownerPid?: number
}

/**
 * Synchronously acquire the backend singleton lock at `path`.
 *
 * Sync (not the async acquireLock) because it runs at the very top of boot,
 * before the event loop is doing useful work, and the rest of startup is sync
 * up to listen(). On `force`, the live owner is SIGTERM'd (then SIGKILL'd) and
 * the lock stolen. Without `force`, a live owner means we refuse.
 */
export function acquireBackendSingleton(path: string, opts: { force?: boolean } = {}): SingletonResult {
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
    killAndWait(ownerPid)
  }
  // 'steal' (dead owner) or post-takeover: clear and re-create the marker.
  return stealLock(dir)
    ? { acquired: true, action }
    : { acquired: false, action, ownerPid: ownerPid ?? undefined }
}

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

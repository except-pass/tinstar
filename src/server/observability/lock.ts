import { mkdirSync, rmdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export type ReleaseFn = () => Promise<void>

const ACQUIRE_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

function markerDir(path: string): string {
  return `${path}.mark`
}

function tryCreateMarker(dir: string): boolean {
  try {
    mkdirSync(dir)
    return true
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EEXIST') return false
    throw err
  }
}

function makeRelease(dir: string): ReleaseFn {
  let released = false
  return async () => {
    if (released) return
    released = true
    if (existsSync(dir)) {
      try { rmdirSync(dir) } catch { /* another process cleaned it up */ }
    }
  }
}

export async function acquireLock(path: string): Promise<ReleaseFn> {
  mkdirSync(dirname(path), { recursive: true })
  const dir = markerDir(path)
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  while (true) {
    if (tryCreateMarker(dir)) return makeRelease(dir)
    if (Date.now() >= deadline) throw new Error(`timed out acquiring lock at ${path}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export async function tryAcquireLock(path: string): Promise<ReleaseFn | null> {
  mkdirSync(dirname(path), { recursive: true })
  const dir = markerDir(path)
  return tryCreateMarker(dir) ? makeRelease(dir) : null
}

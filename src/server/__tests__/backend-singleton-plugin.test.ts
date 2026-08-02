// @vitest-environment node
//
// U1e — the Vite plugin entrypoint's half of the backend singleton guard.
//
// `standalone.ts` has enforced one backend per config root since the ttyd
// port-war fix; the plugin path never did. From U1 on that gap is not just a
// port collision — two backends on one config root would open one Surface
// sidecar, and a Surface owns a human's thread with no source file to re-derive
// it from. The fix is deliberately the SAME guard rather than a second lock:
// `acquireBackendSingleton` is the only owner, and the sidecar only asserts it.
//
// The test asserts the ORDER as much as the refusal: the plugin path must be
// turned away before anything opens the sidecar, which is why it also checks
// that the existing snapshot files are untouched afterwards.
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBackendSingletonForPlugin } from '../index'
import { backendSingletonOwner } from '../infra/lock'
import { SURFACE_SIDECAR_SCHEMA_VERSION, SurfaceSidecar, surfaceSidecarPaths } from '../stores/surface-persistence'

function withRoot(body: (dir: string, lockPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-singleton-'))
  try { body(dir, join(dir, 'server.lock')) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** Fabricate a marker owned by a LIVE process that is not us. `process.ppid` is
 *  the vitest parent — alive for the run and deterministic in a way spawning a
 *  sleeper is not. The layout is `lock.ts`'s, and the assertion right after is
 *  what stops a drifted layout from sending this test down the "no marker at
 *  all" branch and passing for the wrong reason. */
function fakeLiveOwner(lockPath: string): number {
  mkdirSync(`${lockPath}.mark`, { recursive: true })
  writeFileSync(join(`${lockPath}.mark`, 'owner.json'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))
  expect(backendSingletonOwner(lockPath)).toBe(process.ppid)
  return process.ppid
}

describe('acquireBackendSingletonForPlugin', () => {
  it('refuses a second backend on the same config root, before the sidecar is opened', () => {
    withRoot((dir, lockPath) => {
      const paths = surfaceSidecarPaths(dir)
      writeFileSync(paths.primary, JSON.stringify({
        version: SURFACE_SIDECAR_SCHEMA_VERSION, records: [], idempotency: [],
      }))
      const bytes = readFileSync(paths.primary, 'utf-8')
      const owner = fakeLiveOwner(lockPath)

      expect(() => acquireBackendSingletonForPlugin(dir)).toThrow(
        new RegExp(`another tinstar backend is already running on ${dir} \\(pid ${owner}\\)`),
      )
      // The live owner's snapshot was never read, rotated, or truncated, and no
      // temp file was left behind.
      expect(readFileSync(paths.primary, 'utf-8')).toBe(bytes)
      expect(existsSync(paths.backup)).toBe(false)
      expect(existsSync(paths.temp)).toBe(false)
    })
  })

  it('acquires when the root is free, and the sidecar then opens against the same guard', () => {
    withRoot(dir => {
      const release = acquireBackendSingletonForPlugin(dir)
      try {
        expect(backendSingletonOwner(join(dir, 'server.lock'))).toBe(process.pid)
        // The assertion inside the sidecar reads the marker the plugin path just
        // took — one guard, not two.
        expect(() => SurfaceSidecar.open({ dir })).not.toThrow()
      } finally {
        release()
      }
    })
  })

  it('refuses a second acquisition from this very process', () => {
    withRoot(dir => {
      const release = acquireBackendSingletonForPlugin(dir)
      try {
        expect(() => acquireBackendSingletonForPlugin(dir)).toThrow(/already running/)
      } finally {
        release()
      }
    })
  })

  it('reports an unresolved marker instead of claiming a backend is running', () => {
    withRoot(dir => {
      expect(() => acquireBackendSingletonForPlugin(dir, {
        acquire: () => ({
          acquired: false,
          action: 'steal',
          failure: 'marker-recreation-failed',
        }),
      })).toThrow(/could not claim the tinstar backend marker.*marker may be unremovable/)
    })
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock, tryAcquireLock } from '../../infra/lock'
import { processIdentity } from '../../infra/process-liveness'

let tmp: string

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tinstar-lock-test-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe('observability lock', () => {
  it('acquireLock grants when file is unheld', async () => {
    const release = await acquireLock(join(tmp, 'o.lock'))
    expect(typeof release).toBe('function')
    await release()
  })

  it('tryAcquireLock returns null when already held', async () => {
    const release = await acquireLock(join(tmp, 'o.lock'))
    const second = await tryAcquireLock(join(tmp, 'o.lock'))
    expect(second).toBeNull()
    await release()
  })

  it('does not expose an owner-less marker to a concurrent acquisition', async () => {
    const path = join(tmp, 'o.lock')
    const identity = processIdentity(process.pid)
    let contender: ReturnType<typeof tryAcquireLock> | null = null

    const first = await tryAcquireLock(path, {
      processIdentity: () => identity,
      beforeMarkerPublish: () => {
        contender ??= tryAcquireLock(path)
      },
    })
    const second = await contender
    const acquired = [first, second].filter(release => release !== null)

    expect(contender).not.toBeNull()
    expect(acquired).toHaveLength(1)
    await Promise.all(acquired.map(release => release()))
  })

  it('re-acquires after release', async () => {
    const r1 = await acquireLock(join(tmp, 'o.lock'))
    await r1()
    const r2 = await acquireLock(join(tmp, 'o.lock'))
    expect(typeof r2).toBe('function')
    await r2()
  })

  it('steals a stale lock left by a dead process', async () => {
    const dir = join(tmp, 'o.lock.mark')
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))
    const release = await acquireLock(join(tmp, 'o.lock'))
    expect(typeof release).toBe('function')
    await release()
  })

  it('steals a stale lock with no owner file (SIGKILL orphan)', async () => {
    mkdirSync(join(tmp, 'o.lock.mark'))
    const release = await acquireLock(join(tmp, 'o.lock'))
    expect(typeof release).toBe('function')
    await release()
  })

  it('tryAcquireLock steals from a dead pid', async () => {
    const dir = join(tmp, 'o.lock.mark')
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))
    const release = await tryAcquireLock(join(tmp, 'o.lock'))
    expect(release).not.toBeNull()
    await release!()
  })

  it('allows only one stale-lock contender to return ownership', async () => {
    const path = join(tmp, 'o.lock')
    const dir = `${path}.mark`
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))

    let nested: Promise<Awaited<ReturnType<typeof tryAcquireLock>>> | null = null
    const first = await tryAcquireLock(path, {
      probeProcessLiveness: () => ({ state: 'gone' }),
      markerReplacement: {
        createMarker: marker => {
          mkdirSync(marker)
          writeFileSync(join(marker, 'owner.json'), JSON.stringify({
            pid: process.pid,
            startedAt: Date.now(),
          }))
          // Re-enter at the dangerous boundary: the replacement marker exists,
          // but the first contender has not returned ownership yet.
          nested = tryAcquireLock(path, {
            probeProcessLiveness: () => ({ state: 'gone' }),
          })
          return true
        },
      },
    })
    const second = await nested
    const acquired = [first, second].filter(release => release !== null)

    expect(acquired).toHaveLength(1)
    await Promise.all(acquired.map(release => release()))
  })

  it('recovers when a previous stale-owner claimant crashed', async () => {
    const path = join(tmp, 'o.lock')
    const dir = `${path}.mark`
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))
    const abandonedRecovery = `${dir}.recovery`
    mkdirSync(abandonedRecovery)
    writeFileSync(join(abandonedRecovery, 'owner.json'), JSON.stringify({
      pid: 2147480000,
      startedAt: 0,
    }))

    const release = await tryAcquireLock(path)

    expect(release).not.toBeNull()
    await release!()
  })

  it('retries a freshly crashed recovery claim before acquireLock times out', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    try {
      const path = join(tmp, 'o.lock')
      const dir = `${path}.mark`
      mkdirSync(dir)
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({
        pid: 2147480000,
        startedAt: 0,
      }))
      const recovery = `${dir}.recovery`
      mkdirSync(recovery)
      writeFileSync(join(recovery, 'owner.json'), JSON.stringify({
        pid: 2147480000,
        startedAt: Date.now(),
      }))

      const outcome = acquireLock(path, {
        probeProcessLiveness: () => ({ state: 'gone' }),
      }).then(
        release => ({ state: 'acquired' as const, release }),
        error => ({ state: 'failed' as const, error }),
      )
      await vi.advanceTimersByTimeAsync(5_100)
      const result = await outcome

      expect(result.state).toBe('acquired')
      if (result.state === 'acquired') await result.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces and retries recovery-claim cleanup after a live-owner recheck', async () => {
    const path = join(tmp, 'o.lock')
    const dir = `${path}.mark`
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 42, startedAt: 0 }))
    const cleanupError = Object.assign(new Error('recovery cleanup denied'), { code: 'EACCES' })
    const releaseRecoveryClaim = vi.fn()
      .mockImplementationOnce(() => { throw cleanupError })
      .mockImplementationOnce((claim: string) => { rmSync(claim, { recursive: true }) })
    let primaryAlive = false
    const deps = {
      probeProcessLiveness: (pid: unknown) => (
        pid === 42 && primaryAlive ? { state: 'alive' as const } : { state: 'gone' as const }
      ),
      processIdentity: () => {
        primaryAlive = true
        return 'current-process'
      },
      releaseRecoveryClaim,
    }

    await expect(tryAcquireLock(path, deps)).rejects.toBe(cleanupError)
    expect(existsSync(`${dir}.recovery`)).toBe(true)

    primaryAlive = false
    const release = await tryAcquireLock(path, deps)

    expect(release).not.toBeNull()
    expect(releaseRecoveryClaim).toHaveBeenCalledTimes(2)
    expect(existsSync(`${dir}.recovery`)).toBe(false)
    await release!()
  })

  it('preserves an earlier recovery cleanup cause through later contention', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    try {
      const path = join(tmp, 'o.lock')
      const dir = `${path}.mark`
      mkdirSync(dir)
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 42, startedAt: 0 }))
      const cleanupError = Object.assign(new Error('recovery cleanup denied'), { code: 'EACCES' })
      const releaseRecoveryClaim = vi.fn()
        .mockImplementationOnce(() => { throw cleanupError })
        .mockImplementation((claim: string) => { rmSync(claim, { recursive: true }) })
      let primaryProbeCount = 0

      const outcome = acquireLock(path, {
        probeProcessLiveness: pid => (
          pid === 42 && ++primaryProbeCount % 2 === 0
            ? { state: 'alive' as const }
            : { state: 'gone' as const }
        ),
        releaseRecoveryClaim,
      }).then(
        release => ({ state: 'acquired' as const, release }),
        error => ({ state: 'failed' as const, error }),
      )
      await vi.advanceTimersByTimeAsync(5_100)
      const result = await outcome

      expect(result.state).toBe('failed')
      if (result.state === 'failed') {
        expect(result.error).toMatchObject({
          message: expect.stringContaining(path),
          cause: cleanupError,
        })
        expect(Object.prototype.propertyIsEnumerable.call(result.error, 'cause')).toBe(false)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains the primary while retrying a lingering recovery claim', async () => {
    const path = join(tmp, 'o.lock')
    const dir = `${path}.mark`
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))
    const claimError = Object.assign(new Error('claim cleanup denied'), { code: 'EACCES' })
    const releaseRecoveryClaim = vi.fn()
      .mockImplementationOnce(() => { throw claimError })
      .mockImplementationOnce(() => { throw claimError })
      .mockImplementationOnce((claim: string) => { rmSync(claim, { recursive: true }) })
    const release = await tryAcquireLock(path, { releaseRecoveryClaim })

    expect(release).not.toBeNull()
    await expect(release!()).rejects.toBe(claimError)
    expect(existsSync(dir)).toBe(true)

    const successorRelease = await tryAcquireLock(path)
    expect(successorRelease).toBeNull()
    await expect(release!()).resolves.toBeUndefined()
    expect(existsSync(dir)).toBe(false)
  })

  it('does not claim success after losing its recovery generation during publish', async () => {
    const path = join(tmp, 'o.lock')
    const dir = `${path}.mark`
    const recovery = `${dir}.recovery`
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))

    const release = await tryAcquireLock(path, {
      markerReplacement: {
        createMarker: marker => {
          mkdirSync(marker)
          writeFileSync(join(marker, 'owner.json'), JSON.stringify({
            pid: process.pid,
            startedAt: Date.now(),
            markerId: 'published-primary',
          }))
          rmSync(recovery, { recursive: true })
          mkdirSync(recovery)
          writeFileSync(join(recovery, 'owner.json'), JSON.stringify({
            pid: process.pid,
            startedAt: Date.now(),
            markerId: 'successor-claim',
          }))
          return true
        },
      },
    })

    expect(release).toBeNull()
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(recovery)).toBe(true)
  })

  it('tolerates modest forward clock skew on a recovery claim', async () => {
    const path = join(tmp, 'o.lock')
    const dir = `${path}.mark`
    const recovery = `${dir}.recovery`
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))
    mkdirSync(recovery)
    writeFileSync(join(recovery, 'owner.json'), JSON.stringify({
      pid: 2147480000,
      startedAt: Date.now() + 250,
    }))

    await expect(tryAcquireLock(path)).resolves.toBeNull()
    expect(existsSync(recovery)).toBe(true)
  })

  it('does not treat a future-dated dead recovery claim as fresh forever', async () => {
    const path = join(tmp, 'o.lock')
    const dir = `${path}.mark`
    const recovery = `${dir}.recovery`
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))
    mkdirSync(recovery)
    writeFileSync(join(recovery, 'owner.json'), JSON.stringify({
      pid: 2147480000,
      startedAt: Date.now() + 60_000,
    }))

    const release = await tryAcquireLock(path)

    expect(release).not.toBeNull()
    await release!()
  })

  it('propagates release failures and retries the same marker', async () => {
    const path = join(tmp, 'o.lock')
    const releaseError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const removeMarker = vi.fn()
      .mockImplementationOnce(() => { throw releaseError })
      .mockImplementationOnce((dir: string) => { rmSync(dir, { recursive: true }) })
    const deps = { releaseMarker: removeMarker } as Parameters<typeof acquireLock>[1] & {
      releaseMarker: (dir: string) => void
    }
    const release = await acquireLock(path, deps)

    await expect(release()).rejects.toBe(releaseError)
    expect(existsSync(`${path}.mark`)).toBe(true)

    await expect(release()).resolves.toBeUndefined()
    expect(removeMarker).toHaveBeenCalledTimes(2)
    expect(existsSync(`${path}.mark`)).toBe(false)
  })

  it('surfaces an unexpected marker creation error while stealing', async () => {
    const dir = join(tmp, 'o.lock.mark')
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 0 }))
    const error = Object.assign(
      new Error(`EACCES: permission denied, mkdir '${dir}'`),
      { code: 'EACCES' },
    )

    await expect(tryAcquireLock(join(tmp, 'o.lock'), {
      markerReplacement: {
        removeMarker: () => {},
        createMarker: () => { throw error },
      },
    })).rejects.toBe(error)
  })

  it('does not steal a lock when the owner probe is permission denied', async () => {
    const dir = join(tmp, 'o.lock.mark')
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 42, startedAt: 0 }))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    await expect(tryAcquireLock(join(tmp, 'o.lock'))).resolves.toBeNull()
    expect(kill).toHaveBeenCalledWith(42, 0)
  })

  it('recovers an EPERM lock when the recorded process identity no longer matches', async () => {
    const dir = join(tmp, 'o.lock.mark')
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({
      pid: 42,
      startedAt: 0,
      processIdentity: 'linux:old-process',
    }))

    const release = await tryAcquireLock(join(tmp, 'o.lock'), {
      probeProcessLiveness: () => ({
        state: 'unknown',
        code: 'EPERM',
        reason: 'process probe failed with EPERM',
      }),
      processIdentity: () => 'linux:replacement-process',
    })

    expect(release).not.toBeNull()
    await release!()
  })

  it('fails closed on EPERM when the recorded process identity still matches', async () => {
    const dir = join(tmp, 'o.lock.mark')
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({
      pid: 42,
      startedAt: 0,
      processIdentity: 'linux:same-process',
    }))

    await expect(tryAcquireLock(join(tmp, 'o.lock'), {
      probeProcessLiveness: () => ({
        state: 'unknown',
        code: 'EPERM',
        reason: 'process probe failed with EPERM',
      }),
      processIdentity: () => 'linux:same-process',
    })).resolves.toBeNull()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock, tryAcquireLock } from '../../infra/lock'

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
})

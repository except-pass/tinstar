import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideSingletonAction, acquireBackendSingleton } from '../lock'

describe('decideSingletonAction', () => {
  it('acquires when no owner is present', () => {
    expect(decideSingletonAction({ ownerPresent: false, ownerAlive: false, force: false })).toBe('acquire')
  })

  it('steals a stale lock (owner present but dead)', () => {
    expect(decideSingletonAction({ ownerPresent: true, ownerAlive: false, force: false })).toBe('steal')
  })

  it('refuses when a live owner holds the lock and not forced', () => {
    expect(decideSingletonAction({ ownerPresent: true, ownerAlive: true, force: false })).toBe('refuse')
  })

  it('takes over a live owner only when forced', () => {
    expect(decideSingletonAction({ ownerPresent: true, ownerAlive: true, force: true })).toBe('takeover')
  })
})

describe('acquireBackendSingleton', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tinstar-singleton-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const lockPath = () => join(dir, 'server.lock')

  it('acquires a free lock and records this process as owner', () => {
    const r = acquireBackendSingleton(lockPath(), { force: false })
    expect(r.acquired).toBe(true)
    const owner = JSON.parse(readFileSync(join(`${lockPath()}.mark`, 'owner.json'), 'utf-8'))
    expect(owner.pid).toBe(process.pid)
  })

  it('refuses when a live owner already holds the lock', () => {
    const mark = `${lockPath()}.mark`
    mkdirSync(mark)
    writeFileSync(join(mark, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: 1 }))
    const r = acquireBackendSingleton(lockPath(), { force: false })
    expect(r.acquired).toBe(false)
    expect(r.ownerPid).toBe(process.pid)
  })

  it('steals a stale lock whose owner is dead', () => {
    const mark = `${lockPath()}.mark`
    mkdirSync(mark)
    // A pid that is essentially guaranteed not to exist.
    writeFileSync(join(mark, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 1 }))
    const r = acquireBackendSingleton(lockPath(), { force: false })
    expect(r.acquired).toBe(true)
    const owner = JSON.parse(readFileSync(join(mark, 'owner.json'), 'utf-8'))
    expect(owner.pid).toBe(process.pid)
  })
})

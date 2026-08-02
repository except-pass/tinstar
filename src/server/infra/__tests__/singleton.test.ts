import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireBackendSingleton,
  decideSingletonAction,
  describeSingletonFailure,
  formatSingletonFailureForConsole,
  formatSingletonFailureForError,
  type SingletonResult,
} from '../lock'

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
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

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

  it('refuses a forced takeover when owner retirement is permission denied', () => {
    const mark = `${lockPath()}.mark`
    mkdirSync(mark)
    writeFileSync(join(mark, 'owner.json'), JSON.stringify({ pid: 42, startedAt: 1 }))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    const result = acquireBackendSingleton(lockPath(), { force: true })

    expect(result).toEqual({
      acquired: false,
      action: 'takeover',
      ownerPid: 42,
      failure: 'owner-retirement-permission-denied',
    })
    expect(kill).toHaveBeenCalledWith(42, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(42, 0)
    expect(JSON.parse(readFileSync(join(mark, 'owner.json'), 'utf-8'))).toMatchObject({ pid: 42 })
  })

  it('completes a forced takeover when SIGKILL proves the prior owner is gone', () => {
    const mark = `${lockPath()}.mark`
    mkdirSync(mark)
    writeFileSync(join(mark, 'owner.json'), JSON.stringify({ pid: 42, startedAt: 1 }))
    let dead = false
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') dead = true
      if (signal === 0 && dead) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }
      return true
    })
    vi.spyOn(Date, 'now').mockImplementation((() => {
      let now = 0
      return () => { now += 10; return now }
    })())

    expect(acquireBackendSingleton(lockPath(), { force: true })).toEqual({
      acquired: true,
      action: 'takeover',
    })
    expect(kill).toHaveBeenCalledWith(42, 'SIGKILL')
    expect(JSON.parse(readFileSync(join(mark, 'owner.json'), 'utf-8'))).toMatchObject({
      pid: process.pid,
    })
  })

  it('reports a prior owner that remains alive after SIGKILL', () => {
    const mark = `${lockPath()}.mark`
    mkdirSync(mark)
    writeFileSync(join(mark, 'owner.json'), JSON.stringify({ pid: 42, startedAt: 1 }))
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.spyOn(Date, 'now').mockImplementation((() => {
      let now = 0
      return () => { now += 10; return now }
    })())

    expect(acquireBackendSingleton(lockPath(), { force: true })).toEqual({
      acquired: false,
      action: 'takeover',
      ownerPid: 42,
      failure: 'owner-survived-sigkill',
    })
    expect(kill).toHaveBeenCalledWith(42, 'SIGKILL')
    expect(JSON.parse(readFileSync(join(mark, 'owner.json'), 'utf-8')).pid).toBe(42)
  })

  it.each([42.5, Number.MAX_SAFE_INTEGER])('steals a malformed lock pid %s as stale', (pid) => {
    const mark = `${lockPath()}.mark`
    mkdirSync(mark)
    writeFileSync(join(mark, 'owner.json'), JSON.stringify({ pid, startedAt: 1 }))
    const kill = vi.spyOn(process, 'kill')

    const result = acquireBackendSingleton(lockPath())

    expect(result).toMatchObject({ acquired: true, action: 'steal' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('does not attribute an unresolved marker failure to the stale owner', () => {
    const mark = `${lockPath()}.mark`
    mkdirSync(mark)
    writeFileSync(join(mark, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 1 }))

    const removeMarker = vi.fn(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    expect(acquireBackendSingleton(lockPath(), {}, {
      markerReplacement: { removeMarker },
    })).toEqual({
      acquired: false,
      action: 'steal',
      failure: 'marker-recreation-failed',
      detail: 'EACCES: permission denied',
    })
    expect(removeMarker).toHaveBeenCalledWith(mark)
  })

  it('maps an unexpected marker creation error to marker-recreation-failed', () => {
    const mark = `${lockPath()}.mark`
    mkdirSync(mark)
    writeFileSync(join(mark, 'owner.json'), JSON.stringify({ pid: 2147480000, startedAt: 1 }))

    expect(acquireBackendSingleton(lockPath(), {}, {
      markerReplacement: {
        removeMarker: () => {},
        createMarker: () => {
          throw Object.assign(new Error(
            `EACCES: permission denied, mkdir '${mark}'`,
          ), { code: 'EACCES' })
        },
      },
    })).toEqual({
      acquired: false,
      action: 'steal',
      failure: 'marker-recreation-failed',
      detail: `EACCES: permission denied, mkdir '${mark}'`,
    })
  })
})

describe('describeSingletonFailure', () => {
  const configDir = '/tmp/tinstar-test'

  it.each<{
    result: SingletonResult
    expected: ReturnType<typeof describeSingletonFailure>
  }>([
    {
      result: {
        acquired: false,
        action: 'takeover',
        ownerPid: 42,
        failure: 'owner-retirement-permission-denied',
      },
      expected: {
        logMessage: 'permission denied while stopping prior tinstar backend on /tmp/tinstar-test (pid 42)',
        headline: 'Permission was denied while stopping tinstar (pid 42) after --force.',
        guidance: 'Run as the process-owning user or stop that process with appropriate privileges.',
      },
    },
    {
      result: {
        acquired: false,
        action: 'takeover',
        ownerPid: 42,
        failure: 'owner-survived-sigkill',
      },
      expected: {
        logMessage: 'prior tinstar backend survived forced shutdown on /tmp/tinstar-test (pid 42)',
        headline: 'Tinstar (pid 42) still exists after SIGTERM and SIGKILL.',
        guidance: 'Inspect the process state and stop it manually before retrying.',
      },
    },
    {
      result: {
        acquired: false,
        action: 'takeover',
        ownerPid: 42,
        failure: 'owner-retirement-unconfirmed',
      },
      expected: {
        logMessage: 'could not confirm prior tinstar backend stopped on /tmp/tinstar-test (pid 42)',
        headline: 'Could not confirm that tinstar (pid 42) stopped after --force.',
        guidance: 'Inspect and stop that process manually before retrying.',
      },
    },
    {
      result: {
        acquired: false,
        action: 'steal',
        failure: 'marker-recreation-failed',
        detail: 'EACCES: permission denied',
      },
      expected: {
        logMessage: 'could not claim the tinstar backend marker on /tmp/tinstar-test: EACCES: permission denied',
        headline: 'Could not claim the tinstar backend marker on /tmp/tinstar-test.',
        guidance: 'Another backend may have won the startup race, or the marker may be unremovable. Inspect the marker before retrying, or use a different TINSTAR_CONFIG_HOME.',
        detail: 'EACCES: permission denied',
      },
    },
    {
      result: { acquired: false, action: 'refuse', ownerPid: 42 },
      expected: {
        logMessage: 'another tinstar backend is already running on /tmp/tinstar-test (pid 42)',
        headline: 'Tinstar is already running on /tmp/tinstar-test (pid 42).',
        guidance: 'Stop it first, use a different TINSTAR_CONFIG_HOME, or pass --force to take over.',
      },
    },
  ])('maps $result.failure to complete operator guidance', ({ result, expected }) => {
    expect(describeSingletonFailure(result, configDir)).toEqual(expected)
  })

  it('omits --force when the caller cannot honor it', () => {
    expect(describeSingletonFailure({ acquired: false, action: 'refuse' }, configDir, {
      allowForce: false,
    }).guidance).toBe('Stop it first, or use a different TINSTAR_CONFIG_HOME.')
  })

  it('fails honestly for a runtime failure code newer than this binary', () => {
    const result = {
      acquired: false,
      action: 'refuse',
      failure: 'future-singleton-failure',
      detail: 'future diagnostic detail',
    } as unknown as SingletonResult

    expect(describeSingletonFailure(result, configDir)).toEqual({
      logMessage: 'unrecognized tinstar backend singleton failure on /tmp/tinstar-test: '
        + 'future-singleton-failure: future diagnostic detail',
      headline: 'Could not acquire the tinstar backend marker on /tmp/tinstar-test.',
      guidance: 'Inspect the marker and backend logs before retrying, or use a different TINSTAR_CONFIG_HOME.',
      detail: 'future diagnostic detail',
    })
  })

  it('formats detail legibly for standalone and plugin startup', () => {
    const description = describeSingletonFailure({
      acquired: false,
      action: 'steal',
      failure: 'marker-recreation-failed',
      detail: 'EACCES: permission denied, mkdir server.lock.mark',
    }, configDir)

    expect(formatSingletonFailureForConsole(description)).toBe(
      '\n✗ Could not claim the tinstar backend marker on /tmp/tinstar-test.\n'
      + '  EACCES: permission denied, mkdir server.lock.mark\n'
      + '  Another backend may have won the startup race, or the marker may be unremovable. '
      + 'Inspect the marker before retrying, or use a different TINSTAR_CONFIG_HOME.\n',
    )
    expect(formatSingletonFailureForError(description)).toBe(
      'Could not claim the tinstar backend marker on /tmp/tinstar-test. '
      + '(EACCES: permission denied, mkdir server.lock.mark) '
      + 'Another backend may have won the startup race, or the marker may be unremovable. '
      + 'Inspect the marker before retrying, or use a different TINSTAR_CONFIG_HOME.',
    )
  })
})

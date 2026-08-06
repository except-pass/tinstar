import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { log } from '../../logger'
import {
  allTtydIncumbentsStrict,
  clearTtydStartCancellationReasonForTests,
  findPort,
  releasePort,
  setTerminalBindAddress,
  terminalBindAddress,
  ttydSpawnArgv,
  inspectAllTtydIncumbents,
  inspectTtydIncumbentsForReadiness,
  inspectTtydIncumbentsOnPort,
  isCleanInspectionMiss,
  isExpectedTtydStartInterruption,
  findTtydStartSupersededError,
  onTtydRestart,
  orphanTtydPidsToReap,
  startTtydWithDeps,
  ttydBindAddressFromArgs,
  tmuxTargetFromArgs,
  startTtydForTokenAttempt,
  stopManagedTtyd,
  TtydStartCancellationReceiptError,
  TtydStartCancelledError,
  TtydStartSupersededError,
  TtydIdentityInspectionError,
  ttydIdentityInspectionUnavailable,
  ttydIncumbentMatchesSession,
  ttydIncumbentsOnPortStrict,
  ttydPidsForSession,
  ttydPidsToReclaim,
  verifyTtydSessionSurface,
  type StartTtydAttemptDeps,
} from '../backends/tmux'

function inspectionFailure(
  fields: Record<string, unknown>,
): Error & Record<string, unknown> {
  return Object.assign(new Error('inspection failed'), fields)
}

function fakeChild(pid = 777): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess
}

function fakeStartDeps(
  overrides: Partial<StartTtydAttemptDeps> = {},
): StartTtydAttemptDeps {
  const child = fakeChild()
  return {
    incumbentsOnPort: async () => [],
    allIncumbents: async () => [],
    stopManaged: vi.fn() as unknown as StartTtydAttemptDeps['stopManaged'],
    killProcess: vi.fn(),
    spawnProcess: vi.fn(() => child),
    schedule: ((callback: (...args: unknown[]) => void) => {
      callback()
      return {} as NodeJS.Timeout
    }) as unknown as typeof setTimeout,
    tmuxAlive: async () => true,
    enqueueRestart: vi.fn(async () => child.pid),
    ...overrides,
  }
}

describe('tmuxTargetFromArgs — which tmux session a ttyd attaches', () => {
  it('parses the exact form startTtyd spawns', () => {
    // `ttyd -W -p <port> -t titleFixed=Tinstar -t theme={…} bash -c "tmux attach -t =<name>"`
    const args = 'ttyd -W -p 8681 -t titleFixed=Tinstar -t theme={"background":"#000000"} bash -c tmux attach -t =tinstar-foo'
    expect(tmuxTargetFromArgs(args)).toBe('tinstar-foo')
  })
  it('does not mistake ttyd\'s own -t option flags for the session token', () => {
    // The session is tinstar-foo, NOT 'titleFixed=Tinstar' (ttyd's -t flag).
    expect(tmuxTargetFromArgs('ttyd -t titleFixed=X bash -c tmux attach -t real-sess')).toBe('real-sess')
  })
  it('tolerates the attach-session alias and global flags (e.g. -L socket)', () => {
    expect(tmuxTargetFromArgs('bash -c tmux attach-session -t sess-a')).toBe('sess-a')
    expect(tmuxTargetFromArgs('bash -c tmux -L mysock attach -t sess-b')).toBe('sess-b')
  })
  it('preserves a raw canonical name that itself begins with equals', () => {
    expect(tmuxTargetFromArgs('bash -c tmux attach -t ==sess-a')).toBe('=sess-a')
  })
  it('returns null when there is no tmux attach in the args', () => {
    expect(tmuxTargetFromArgs('ttyd -p 8681 bash -c htop')).toBeNull()
    expect(tmuxTargetFromArgs('')).toBeNull()
  })
})

describe('ttydPidsToReclaim — which ttyds we may kill to take a port', () => {
  it('reclaims our own previous ttyd on the port', () => {
    const r = ttydPidsToReclaim(
      [{ pid: 100, tmuxTarget: 'tinstar-mysession', bindAddress: '127.0.0.1' }],
      'tinstar-mysession',
    )
    expect(r.kill).toEqual([100])
    expect(r.foreign).toEqual([])
  })

  it('reclaims a ttyd whose tmux target we could not identify', () => {
    const r = ttydPidsToReclaim([{ pid: 101, tmuxTarget: null, bindAddress: '127.0.0.1' }], 'tinstar-mysession')
    expect(r.kill).toEqual([101])
    expect(r.foreign).toEqual([])
  })

  it('does NOT kill a ttyd serving a different session — that is the kill-war', () => {
    const r = ttydPidsToReclaim(
      [{ pid: 200, tmuxTarget: 'tinstar-other', bindAddress: '127.0.0.1' }],
      'tinstar-mysession',
    )
    expect(r.kill).toEqual([])
    expect(r.foreign).toEqual([{ pid: 200, tmuxTarget: 'tinstar-other', bindAddress: '127.0.0.1' }])
  })

  it('splits a mixed set correctly', () => {
    const r = ttydPidsToReclaim(
      [
        { pid: 1, tmuxTarget: 'tinstar-mine', bindAddress: '127.0.0.1' },
        { pid: 2, tmuxTarget: 'tinstar-other', bindAddress: '127.0.0.1' },
        { pid: 3, tmuxTarget: null, bindAddress: '127.0.0.1' },
      ],
      'tinstar-mine',
    )
    expect(r.kill.sort()).toEqual([1, 3])
    expect(r.foreign).toEqual([{ pid: 2, tmuxTarget: 'tinstar-other', bindAddress: '127.0.0.1' }])
  })
})

describe('verified ttyd session surfaces', () => {
  it('recognizes only an empty, unsignaled exit 1 as a clean inspection miss', () => {
    expect(isCleanInspectionMiss(inspectionFailure({
      code: 1,
      stdout: '',
      stderr: '',
    }))).toBe(true)
    expect(isCleanInspectionMiss(inspectionFailure({
      code: 1,
      stdout: '',
      stderr: 'permission denied',
    }))).toBe(false)
    expect(isCleanInspectionMiss(inspectionFailure({
      code: 1,
      stdout: '',
      stderr: '',
      killed: true,
      signal: 'SIGTERM',
    }))).toBe(false)
  })

  it('keeps lsof diagnostics inconclusive instead of proving no listener', async () => {
    const run = vi.fn(async () => {
      throw inspectionFailure({
        code: 1,
        stdout: '',
        stderr: 'lsof: permission denied',
      })
    })

    await expect(inspectTtydIncumbentsOnPort(6123, run))
      .rejects.toThrow('inspection failed')
    expect(run).toHaveBeenCalledWith(
      'lsof',
      ['-w', '-ti', ':6123'],
      { timeout: 2_000 },
    )
  })

  it('keeps ps infrastructure failures inconclusive', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: '101\n', stderr: '' })
      .mockRejectedValueOnce(inspectionFailure({
        code: 'ENOENT',
        stdout: '',
        stderr: '',
      }))

    await expect(inspectTtydIncumbentsOnPort(6123, run))
      .rejects.toThrow('inspection failed')
  })

  it('treats a clean ps miss as a listener that vanished during inspection', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: '101\n', stderr: '' })
      .mockRejectedValueOnce(inspectionFailure({
        code: 1,
        stdout: '',
        stderr: '',
      }))

    await expect(inspectTtydIncumbentsOnPort(6123, run))
      .resolves.toEqual([])
  })

  it('recognizes a macOS ps executable path as ttyd', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: '101\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: '/opt/homebrew/bin/ttyd\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: 'ttyd bash -c tmux attach -t =tinstar-ours',
        stderr: '',
      })

    await expect(inspectTtydIncumbentsOnPort(6123, run)).resolves.toEqual([
      { pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: null },
    ])
  })

  it('retries strict identity inspection after a transient-failure cooldown', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const failingRun = vi.fn(async () => {
        throw inspectionFailure({
          code: 'ETIMEDOUT',
          stdout: '',
          stderr: '',
          killed: true,
          signal: 'SIGTERM',
        })
      })

      await expect(ttydIncumbentsOnPortStrict(6123, failingRun))
        .rejects.toThrow('Terminal safety check failed')
      expect(ttydIdentityInspectionUnavailable()).toBe(true)

      now += 30_001
      expect(ttydIdentityInspectionUnavailable()).toBe(false)
      await expect(ttydIncumbentsOnPortStrict(
        6123,
        vi.fn(async () => ({ stdout: '', stderr: '' })),
      )).resolves.toEqual([])
      expect(ttydIdentityInspectionUnavailable()).toBe(false)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('uses the same cooldown for pgrep-side inspection failures', async () => {
    let now = 50_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await expect(allTtydIncumbentsStrict(vi.fn(async () => {
        throw inspectionFailure({
          code: 'ETIMEDOUT',
          stdout: '',
          stderr: '',
          killed: true,
          signal: 'SIGTERM',
        })
      }))).rejects.toBeInstanceOf(TtydIdentityInspectionError)
      expect(ttydIdentityInspectionUnavailable()).toBe(true)

      now += 30_001
      expect(ttydIdentityInspectionUnavailable()).toBe(false)
      await expect(allTtydIncumbentsStrict(
        vi.fn(async () => ({ stdout: '', stderr: '' })),
      )).resolves.toEqual([])
      expect(ttydIdentityInspectionUnavailable()).toBe(false)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reports the failed command, retry time, and safety reason during cooldown', async () => {
    let now = 75_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await expect(ttydIncumbentsOnPortStrict(6123, vi.fn(async () => {
        throw inspectionFailure({
          code: 'ETIMEDOUT',
          stdout: '',
          stderr: '',
          killed: true,
          signal: 'SIGTERM',
          cmd: 'lsof -w -ti :6123',
        })
      }))).rejects.toThrow(
        'Terminal safety check failed: lsof timed out or was interrupted. No terminal was started to protect existing sessions.',
      )

      now += 5_000
      await expect(ttydIncumbentsOnPortStrict(6123)).rejects.toThrow(
        'Terminal safety check temporarily unavailable; retry in 25s. The last check failed because lsof timed out or was interrupted. Session start is paused to protect existing terminals.',
      )
    } finally {
      now += 30_001
      await ttydIncumbentsOnPortStrict(
        6123,
        vi.fn(async () => ({ stdout: '', stderr: '' })),
      )
      nowSpy.mockRestore()
    }
  })

  it('does not let an older successful probe clear a newer failure cooldown', async () => {
    let now = 100_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let resolveSlowProbe!: (result: { stdout: string; stderr: string }) => void
    const slowRun = vi.fn(() => new Promise<{ stdout: string; stderr: string }>(
      resolve => { resolveSlowProbe = resolve },
    ))

    try {
      const slowProbe = ttydIncumbentsOnPortStrict(6123, slowRun)
      await vi.waitFor(() => expect(slowRun).toHaveBeenCalledTimes(1))

      await expect(allTtydIncumbentsStrict(vi.fn(async () => {
        throw inspectionFailure({
          code: 'ETIMEDOUT',
          stdout: '',
          stderr: '',
          killed: true,
          signal: 'SIGTERM',
        })
      }))).rejects.toBeInstanceOf(TtydIdentityInspectionError)
      expect(ttydIdentityInspectionUnavailable()).toBe(true)

      resolveSlowProbe({ stdout: '', stderr: '' })
      await expect(slowProbe).resolves.toEqual([])
      expect(ttydIdentityInspectionUnavailable()).toBe(true)
    } finally {
      now += 30_001
      await ttydIncumbentsOnPortStrict(
        6123,
        vi.fn(async () => ({ stdout: '', stderr: '' })),
      )
      nowSpy.mockRestore()
    }
  })

  it('keeps best-effort orphan inventory failures out of the shared cooldown', async () => {
    await expect(inspectAllTtydIncumbents(vi.fn(async () => {
      throw inspectionFailure({
        code: 'ETIMEDOUT',
        stdout: '',
        stderr: '',
        killed: true,
        signal: 'SIGTERM',
      })
    }))).rejects.toThrow('inspection failed')

    expect(ttydIdentityInspectionUnavailable()).toBe(false)
  })

  it('keeps background readiness failures out of the session-start cooldown', async () => {
    await expect(inspectTtydIncumbentsForReadiness(6123, vi.fn(async () => {
      throw inspectionFailure({
        code: 'ETIMEDOUT',
        stdout: '',
        stderr: '',
        killed: true,
        signal: 'SIGTERM',
        cmd: 'lsof -w -ti :6123',
      })
    }))).rejects.toThrow('inspection failed')

    expect(ttydIdentityInspectionUnavailable()).toBe(false)
  })

  it('requires the expected PID to attach to the exact tmux target', () => {
    expect(ttydIncumbentMatchesSession(
      [{ pid: 101, tmuxTarget: 'tinstar-other', bindAddress: '127.0.0.1' }],
      101,
      'tinstar-ours',
    )).toBe(false)
    expect(ttydIncumbentMatchesSession(
      [{ pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: '127.0.0.1' }],
      101,
      'tinstar-ours',
    )).toBe(true)
  })

  it('rejects a healthy foreign HTTP listener with no matching ttyd', async () => {
    const httpHealthy = vi.fn(async () => true)

    await expect(verifyTtydSessionSurface(
      { port: 6123, pid: 101, tmuxName: 'tinstar-ours' },
      {
        incumbentsOnPort: async () => [],
        healthCheck: httpHealthy,
      },
    )).resolves.toBe('unhealthy')

    expect(httpHealthy).toHaveBeenCalledTimes(1)
  })

  it('rejects a foreign target after readiness succeeds', async () => {
    await expect(verifyTtydSessionSurface(
      { port: 6123, pid: 101, tmuxName: 'tinstar-ours' },
      {
        incumbentsOnPort: async () =>
          [{ pid: 101, tmuxTarget: 'tinstar-other', bindAddress: '127.0.0.1' }],
        healthCheck: async () => true,
      },
    )).resolves.toBe('unhealthy')
  })

  it('returns inconclusive when strict identity inspection is unavailable', async () => {
    await expect(verifyTtydSessionSurface(
      { port: 6123, pid: 101, tmuxName: 'tinstar-ours' },
      {
        incumbentsOnPort: async () => {
          throw new Error('lsof missing')
        },
        healthCheck: async () => true,
      },
    )).resolves.toBe('inconclusive')
  })

  it('verifies the exact ttyd after HTTP readiness', async () => {
    await expect(verifyTtydSessionSurface(
      { port: 6123, pid: 101, tmuxName: 'tinstar-ours' },
      {
        incumbentsOnPort: async () =>
          [{ pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: '127.0.0.1' }],
        healthCheck: async () => true,
      },
    )).resolves.toBe('verified')
  })
})

describe('fenced ttyd start attempts', () => {
  const opts = {
    sessionName: 'fenced-start',
    tmuxName: 'tinstar-fenced-start',
    port: 6123,
  }

  afterEach(() => {
    vi.restoreAllMocks()
    stopManagedTtyd(opts.sessionName, {
      cancellationReason: 'session stop requested',
    })
  })

  it('treats cancellation as expected without reclassifying its cause', () => {
    const diagnostic = new Error('restart was intentionally stopped')
    const interrupted = new TtydStartSupersededError(
      opts.sessionName,
      'post-spawn',
      { cause: diagnostic },
    )
    const cancellation = new TtydStartCancelledError(
      opts.sessionName,
      'post-spawn',
      'session stop requested',
      interrupted,
    )

    expect(isExpectedTtydStartInterruption(cancellation)).toBe(true)
    expect(isExpectedTtydStartInterruption(
      new TtydStartSupersededError(opts.sessionName, 'preflight'),
    )).toBe(true)
    expect(isExpectedTtydStartInterruption(diagnostic)).toBe(false)
    expect(findTtydStartSupersededError(cancellation)).toBeNull()
    expect(cancellation.cause).toBeUndefined()
    expect(cancellation.reason).toBe('session stop requested')
    expect(cancellation.interrupted).toBe(interrupted)
    expect(cancellation.message).toContain(
      '; cancellation reason: session stop requested',
    )
    expect(cancellation.message).toContain(interrupted.message)
    expect(cancellation.message).toContain(diagnostic.message)

    const missingReceipt = new TtydStartCancellationReceiptError(
      opts.sessionName,
      interrupted,
    )
    expect(findTtydStartSupersededError(missingReceipt)).toBeNull()
    expect(isExpectedTtydStartInterruption(missingReceipt)).toBe(false)
    expect(missingReceipt.cause).toBeUndefined()
    expect(missingReceipt.interrupted).toBe(interrupted)
    expect(missingReceipt.message).toContain(interrupted.message)
    expect(missingReceipt.message).toContain(diagnostic.message)
  })

  it('keeps cancellation classification when interruption rendering fails', () => {
    const hostile = new Error('hostile interruption')
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('cause getter failed')
      },
    })

    const cancellation = new TtydStartCancelledError(
      opts.sessionName,
      'post-spawn',
      'session stop requested',
      hostile,
    )
    expect(cancellation.message).toContain(
      '; interrupted failure: [diagnostic unavailable]',
    )
    expect(isExpectedTtydStartInterruption(cancellation)).toBe(true)

    const missingReceipt = new TtydStartCancellationReceiptError(
      opts.sessionName,
      hostile,
    )
    expect(missingReceipt.message).toContain(
      '; interrupted failure: [diagnostic unavailable]',
    )
    expect(isExpectedTtydStartInterruption(missingReceipt)).toBe(false)
  })

  it('reports a preflight supersession before inspecting or mutating', async () => {
    const deps = fakeStartDeps({
      incumbentsOnPort: vi.fn(async () => []),
      allIncumbents: vi.fn(async () => []),
    })

    await expect(startTtydForTokenAttempt(
      opts,
      Symbol('start'),
      () => false,
      deps,
    )).rejects.toMatchObject({
      name: 'TtydStartSupersededError',
      stage: 'preflight',
    })

    expect(deps.incumbentsOnPort).not.toHaveBeenCalled()
    expect(deps.allIncumbents).not.toHaveBeenCalled()
    expect(deps.stopManaged).not.toHaveBeenCalled()
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  it('takes no destructive action when preflight inspection fails', async () => {
    const deps = fakeStartDeps({
      incumbentsOnPort: async () => {
        throw new TtydIdentityInspectionError('lsof unavailable')
      },
    })

    await expect(startTtydForTokenAttempt(
      opts,
      Symbol('start'),
      () => true,
      deps,
    )).rejects.toBeInstanceOf(TtydIdentityInspectionError)

    expect(deps.stopManaged).not.toHaveBeenCalled()
    expect(deps.killProcess).not.toHaveBeenCalled()
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  it('takes no destructive action when superseded during inspection', async () => {
    let currentCheck = 0
    const deps = fakeStartDeps()

    await expect(startTtydForTokenAttempt(
      opts,
      Symbol('start'),
      () => ++currentCheck === 1,
      deps,
    )).rejects.toMatchObject({
      name: 'TtydStartSupersededError',
      stage: 'pre-spawn',
    })

    expect(deps.stopManaged).not.toHaveBeenCalled()
    expect(deps.killProcess).not.toHaveBeenCalled()
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  it('runs both non-destructive inventories concurrently before mutation', async () => {
    let resolvePortInventory!: (incumbents: []) => void
    const allIncumbents = vi.fn(async () => [])
    const deps = fakeStartDeps({
      incumbentsOnPort: () => new Promise(resolve => {
        resolvePortInventory = resolve
      }),
      allIncumbents,
    })

    const attempt = startTtydForTokenAttempt(
      opts,
      Symbol('start'),
      () => true,
      deps,
    )
    await vi.waitFor(() => expect(allIncumbents).toHaveBeenCalledTimes(1))
    expect(deps.stopManaged).not.toHaveBeenCalled()
    expect(deps.spawnProcess).not.toHaveBeenCalled()

    resolvePortInventory([])
    await expect(attempt).resolves.toBe(777)
  })

  it('kills an incumbent found by both inventories only once', async () => {
    const deps = fakeStartDeps({
      incumbentsOnPort: async () => [
        { pid: 100, tmuxTarget: opts.tmuxName, bindAddress: '127.0.0.1' },
      ],
      allIncumbents: async () => [
        { pid: 100, tmuxTarget: opts.tmuxName, bindAddress: '127.0.0.1' },
        { pid: 101, tmuxTarget: opts.tmuxName, bindAddress: '127.0.0.1' },
      ],
    })

    await expect(startTtydForTokenAttempt(
      opts,
      Symbol('start'),
      () => true,
      deps,
    )).resolves.toBe(777)

    expect(deps.killProcess).toHaveBeenCalledTimes(2)
    expect(deps.killProcess).toHaveBeenNthCalledWith(1, 100)
    expect(deps.killProcess).toHaveBeenNthCalledWith(2, 101)
    expect(deps.spawnProcess).toHaveBeenCalledTimes(1)
  })

  it('rejects a start superseded while waiting for ttyd to bind', async () => {
    let current = true
    const scheduled: Array<{
      callback: (...args: unknown[]) => void
      delay: number | undefined
    }> = []
    const deps = fakeStartDeps({
      schedule: vi.fn((callback, delay) => {
        scheduled.push({ callback, delay })
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
    })

    const attempt = startTtydForTokenAttempt(
      opts,
      Symbol('start'),
      () => current,
      deps,
    )
    const rejection = expect(attempt)
      .rejects.toMatchObject({
        name: 'TtydStartSupersededError',
        stage: 'post-spawn',
      })
    await vi.waitFor(() => expect(scheduled).toHaveLength(1))

    current = false
    scheduled[0]!.callback()
    await rejection
    expect(deps.enqueueRestart).not.toHaveBeenCalled()
  })

  it('keeps the first cancellation reason through later teardown steps', async () => {
    const scheduled: Array<(...args: unknown[]) => void> = []
    const deps = fakeStartDeps({
      schedule: vi.fn((callback) => {
        scheduled.push(callback)
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
    })

    const attempt = startTtydWithDeps(opts, deps)
    const rejection = expect(attempt).rejects.toMatchObject({
      name: 'TtydStartCancelledError',
      stage: 'post-spawn',
      reason: 'surface refresh retirement',
      interrupted: expect.any(TtydStartSupersededError),
    })
    await vi.waitFor(() => expect(scheduled).toHaveLength(1))

    stopManagedTtyd(opts.sessionName, {
      cancellationReason: 'surface refresh retirement',
    })
    stopManagedTtyd(opts.sessionName, {
      cancellationReason: 'session deletion requested',
    })
    scheduled[0]!()
    await rejection
  })

  it('fails hard when cancellation ownership has no receipt', async () => {
    const scheduled: Array<(...args: unknown[]) => void> = []
    const cleanupError = new Error('receipt cleanup failed')
    const stopManaged = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw cleanupError })
    const deps = fakeStartDeps({
      stopManaged,
      schedule: vi.fn((callback) => {
        scheduled.push(callback)
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
    })

    const attempt = startTtydWithDeps(opts, deps)
    await vi.waitFor(() => expect(scheduled).toHaveLength(1))

    stopManagedTtyd(opts.sessionName, {
      cancellationReason: 'session stop requested',
    })
    clearTtydStartCancellationReasonForTests(opts.sessionName)
    scheduled[0]!()

    const rejection = await attempt.catch(err => err)
    expect(rejection).toBeInstanceOf(TtydStartCancellationReceiptError)
    expect(isExpectedTtydStartInterruption(rejection)).toBe(false)
    expect(findTtydStartSupersededError(rejection)).toBeNull()
    expect(rejection.cause).toBeInstanceOf(AggregateError)
    expect((rejection.cause as AggregateError).errors).toEqual([
      rejection.interrupted,
      cleanupError,
    ])
  })

  it('records why an in-flight start is abandoned after its child exits', async () => {
    const child = fakeChild(779)
    const scheduled: Array<{
      callback: (...args: unknown[]) => void
      delay: number | undefined
    }> = []
    const tmuxAlive = vi.fn(async () => false)
    const deps = fakeStartDeps({
      spawnProcess: vi.fn(() => child),
      tmuxAlive,
      schedule: vi.fn((callback, delay) => {
        scheduled.push({ callback, delay })
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
    })

    const attempt = startTtydWithDeps(opts, deps)
    const rejection = expect(attempt).rejects.toMatchObject({
      name: 'TtydStartCancelledError',
      stage: 'post-spawn',
      reason: 'automatic restart abandoned: tmux-gone',
    })
    await vi.waitFor(() => expect(scheduled[0]?.delay).toBe(500))

    child.emit('exit', 1)
    await vi.waitFor(() => expect(tmuxAlive).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    scheduled.shift()!.callback()

    await rejection
    expect(deps.enqueueRestart).not.toHaveBeenCalled()
  })

  it('lets a queued newer start survive a stale generic child error', async () => {
    const firstChild = fakeChild(701)
    const secondChild = fakeChild(702)
    const scheduled: Array<{
      callback: (...args: unknown[]) => void
      delay: number | undefined
    }> = []
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
    const stopManaged = vi.fn(stopManagedTtyd) as unknown as
      StartTtydAttemptDeps['stopManaged']
    const deps = fakeStartDeps({
      spawnProcess,
      stopManaged,
      schedule: vi.fn((callback, delay) => {
        scheduled.push({ callback, delay })
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
    })

    const first = startTtydWithDeps(opts, deps)
    const childError = new Error('stale child failed')
    const firstRejection = expect(first).rejects.toMatchObject({
      name: 'TtydStartSupersededError',
      stage: 'settlement',
      cause: childError,
    })
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

    const second = startTtydWithDeps(
      { ...opts, port: opts.port + 1 },
      deps,
    )
    firstChild.emit('error', childError)
    await firstRejection

    expect(deps.stopManaged).toHaveBeenNthCalledWith(
      2,
      opts.sessionName,
      { resetHistory: false, invalidateStarts: false },
    )
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))
    expect(scheduled).toHaveLength(2)
    scheduled[1]!.callback()

    await expect(second).resolves.toBe(702)
    expect(secondChild.kill).not.toHaveBeenCalled()
  })

  it('preserves the incumbent when a stale preflight inspection fails', async () => {
    let rejectFirst!: (err: Error) => void
    let resolveSecond!: (incumbents: []) => void
    const incumbentsOnPort = vi.fn()
      .mockImplementationOnce(() => new Promise<never>((_resolve, reject) => {
        rejectFirst = reject
      }))
      .mockImplementationOnce(() => new Promise<[]>((resolve) => {
        resolveSecond = resolve
      }))
    const scheduled: Array<(...args: unknown[]) => void> = []
    const deps = fakeStartDeps({
      incumbentsOnPort,
      schedule: vi.fn((callback) => {
        scheduled.push(callback)
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
    })

    const first = startTtydWithDeps(opts, deps)
    const firstRejection = expect(first).rejects.toMatchObject({
      name: 'TtydStartSupersededError',
      stage: 'settlement',
    })
    await vi.waitFor(() => expect(incumbentsOnPort).toHaveBeenCalledTimes(1))

    const second = startTtydWithDeps(
      { ...opts, port: opts.port + 1 },
      deps,
    )
    rejectFirst(new Error('lsof failed before mutation'))
    await firstRejection

    await vi.waitFor(() => expect(incumbentsOnPort).toHaveBeenCalledTimes(2))
    expect(deps.stopManaged).not.toHaveBeenCalled()

    resolveSecond([])
    await vi.waitFor(() => expect(scheduled).toHaveLength(1))
    scheduled[0]!()
    await expect(second).resolves.toBe(777)
  })

  it('keeps queued starts alive when stale cleanup itself fails', async () => {
    const firstChild = fakeChild(801)
    const secondChild = fakeChild(802)
    const scheduled: Array<(...args: unknown[]) => void> = []
    const cleanupError = new Error('cleanup failed')
    const stopManaged = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw cleanupError })
      .mockImplementationOnce(() => {})
    const deps = fakeStartDeps({
      stopManaged,
      spawnProcess: vi.fn()
        .mockReturnValueOnce(firstChild)
        .mockReturnValueOnce(secondChild),
      schedule: vi.fn((callback) => {
        scheduled.push(callback)
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
    })

    const first = startTtydWithDeps(opts, deps)
    await vi.waitFor(() => expect(deps.spawnProcess).toHaveBeenCalledTimes(1))
    const second = startTtydWithDeps(
      { ...opts, port: opts.port + 1 },
      deps,
    )
    const childError = new Error('stale child failed')
    firstChild.emit('error', childError)

    const rejection = await first.catch(err => err)
    expect(rejection).toMatchObject({
      name: 'TtydStartSupersededError',
      stage: 'settlement',
    })
    expect(rejection.cause).toBeInstanceOf(AggregateError)
    expect((rejection.cause as AggregateError).errors).toEqual([
      childError,
      cleanupError,
    ])

    await vi.waitFor(() => expect(deps.spawnProcess).toHaveBeenCalledTimes(2))
    expect(scheduled).toHaveLength(2)
    scheduled[1]!()
    await expect(second).resolves.toBe(802)
  })

  it('routes a live unexpected exit through the injected restart coordinator', async () => {
    const child = fakeChild(777)
    const scheduled: Array<{
      callback: (...args: unknown[]) => void
      delay: number | undefined
    }> = []
    const enqueueRestart = vi.fn(async () => 888)
    const startToken = Symbol('start')
    const deps = fakeStartDeps({
      spawnProcess: vi.fn(() => child),
      schedule: vi.fn((callback, delay) => {
        scheduled.push({ callback, delay })
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
      enqueueRestart,
    })

    const attempt = startTtydForTokenAttempt(
      opts,
      startToken,
      () => true,
      deps,
    )
    await vi.waitFor(() => expect(scheduled[0]?.delay).toBe(500))
    scheduled.shift()!.callback()
    await expect(attempt).resolves.toBe(777)

    const onRestart = vi.fn()
    onTtydRestart(opts.sessionName, onRestart)
    child.emit('exit', 1)
    await vi.waitFor(() => expect(scheduled[0]?.delay).toBe(2_000))
    scheduled.shift()!.callback()

    await vi.waitFor(() => expect(enqueueRestart).toHaveBeenCalledWith(
      opts,
      startToken,
    ))
    await vi.waitFor(() => expect(onRestart).toHaveBeenCalledWith(888))
  })

  it('logs a restart receipt with its interruption and cleanup diagnostics once', async () => {
    const child = fakeChild(777)
    const scheduled: Array<{
      callback: (...args: unknown[]) => void
      delay: number | undefined
    }> = []
    const interrupted = new TtydStartSupersededError(
      opts.sessionName,
      'post-spawn',
      { cause: new Error('nested interruption detail') },
    )
    const cleanupError = new Error('restart cleanup failed')
    const receipt = new TtydStartCancellationReceiptError(
      opts.sessionName,
      interrupted,
      {
        cause: new AggregateError(
          [interrupted, cleanupError],
          'restart receipt cleanup aggregate',
        ),
      },
    )
    const enqueueRestart = vi.fn(async () => {
      throw receipt
    })
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => undefined)
    const startToken = Symbol('start')
    const deps = fakeStartDeps({
      spawnProcess: vi.fn(() => child),
      schedule: vi.fn((callback, delay) => {
        scheduled.push({ callback, delay })
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
      enqueueRestart,
    })

    const attempt = startTtydForTokenAttempt(
      opts,
      startToken,
      () => true,
      deps,
    )
    await vi.waitFor(() => expect(scheduled[0]?.delay).toBe(500))
    scheduled.shift()!.callback()
    await expect(attempt).resolves.toBe(777)

    child.emit('exit', 1)
    await vi.waitFor(() => expect(scheduled[0]?.delay).toBe(2_000))
    scheduled.shift()!.callback()

    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith(
      'ttyd',
      `${opts.sessionName}: restart failed`,
      { error: expect.any(String) },
    ))
    const diagnostic = (
      errorLog.mock.calls.find(
        ([tag, message]) =>
          tag === 'ttyd' && message === `${opts.sessionName}: restart failed`,
      )?.[2]?.error
    ) as string
    expect(diagnostic).toContain(
      `ttyd start for ${opts.sessionName} lost ownership `
        + 'without a cancellation receipt',
    )
    expect(diagnostic).toContain('restart receipt cleanup aggregate')
    expect(diagnostic).toContain('restart cleanup failed')
    expect(diagnostic).toContain('nested interruption detail')
    expect(diagnostic.split(interrupted.message)).toHaveLength(2)
  })

  it('fences a queued restart when the start is superseded before its timer', async () => {
    const child = fakeChild(777)
    let current = true
    const scheduled: Array<{
      callback: (...args: unknown[]) => void
      delay: number | undefined
    }> = []
    const enqueueRestart = vi.fn(async () => 888)
    const deps = fakeStartDeps({
      spawnProcess: vi.fn(() => child),
      schedule: vi.fn((callback, delay) => {
        scheduled.push({ callback, delay })
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
      enqueueRestart,
    })

    const attempt = startTtydForTokenAttempt(
      opts,
      Symbol('start'),
      () => current,
      deps,
    )
    await vi.waitFor(() => expect(scheduled[0]?.delay).toBe(500))
    scheduled.shift()!.callback()
    await attempt

    child.emit('exit', 1)
    await vi.waitFor(() => expect(scheduled[0]?.delay).toBe(2_000))
    current = false
    scheduled.shift()!.callback()
    await Promise.resolve()

    expect(enqueueRestart).not.toHaveBeenCalled()
  })

  it('fences exit handling after an explicit stop', async () => {
    const child = fakeChild(777)
    const tmuxAlive = vi.fn(async () => true)
    const deps = fakeStartDeps({
      spawnProcess: vi.fn(() => child),
      tmuxAlive,
    })

    await startTtydForTokenAttempt(
      opts,
      Symbol('start'),
      () => true,
      deps,
    )
    stopManagedTtyd(opts.sessionName, {
      cancellationReason: 'session stop requested',
    })
    child.emit('exit', 1)
    await Promise.resolve()

    expect(tmuxAlive).not.toHaveBeenCalled()
    expect(deps.enqueueRestart).not.toHaveBeenCalled()
  })
})

describe('ttydPidsForSession — cross-port reaping of stale ttyds for one session', () => {
  it('reaps every ttyd attached to exactly our session, on any port', () => {
    const pids = ttydPidsForSession(
      [
        { pid: 1, tmuxTarget: 'tinstar-foo', bindAddress: '127.0.0.1' }, // current
        { pid: 2, tmuxTarget: 'tinstar-foo', bindAddress: '127.0.0.1' }, // orphan from a prior restart (other port)
      ],
      'tinstar-foo',
    )
    expect(pids.sort()).toEqual([1, 2])
  })

  it('never reaps a child hand session that merely shares the name prefix', () => {
    // Reclaiming the parent must not kill the ttyd serving tinstar-foo-reviewer-*.
    const pids = ttydPidsForSession(
      [
        { pid: 1, tmuxTarget: 'tinstar-foo', bindAddress: '127.0.0.1' },
        { pid: 2, tmuxTarget: 'tinstar-foo-reviewer-ab12', bindAddress: '127.0.0.1' },
        { pid: 3, tmuxTarget: 'tinstar-foo-general-purpose-cd34', bindAddress: '127.0.0.1' },
      ],
      'tinstar-foo',
    )
    expect(pids).toEqual([1])
  })

  it('ignores ttyds for other sessions and unidentifiable ones', () => {
    const pids = ttydPidsForSession(
      [
        { pid: 1, tmuxTarget: 'tinstar-other', bindAddress: '127.0.0.1' },
        { pid: 2, tmuxTarget: null, bindAddress: '127.0.0.1' },
      ],
      'tinstar-foo',
    )
    expect(pids).toEqual([])
  })
})

describe('orphanTtydPidsToReap — global GC sweep of port-squatting ttyds', () => {
  it('reaps a tinstar ttyd whose tmux session is dead (the squatter)', () => {
    // The whole leak: tmux is gone but ttyd still holds the port.
    const pids = orphanTtydPidsToReap(
      [{ pid: 100, tmuxTarget: 'tinstar-dead', bindAddress: '127.0.0.1' }],
      new Set<string>(), // no live tmux sessions
      'tinstar-',
    )
    expect(pids).toEqual([100])
  })

  it('never reaps a ttyd whose tmux session is alive', () => {
    // Live tmux = in use, no matter who spawned it. This is the load-bearing
    // invariant that avoids the cross-backend kill-war.
    const pids = orphanTtydPidsToReap(
      [{ pid: 100, tmuxTarget: 'tinstar-alive', bindAddress: '127.0.0.1' }],
      new Set(['tinstar-alive']),
      'tinstar-',
    )
    expect(pids).toEqual([])
  })

  it('leaves a foreign live session belonging to another backend untouched', () => {
    // A second backend (different TINSTAR_CONFIG_HOME) serves a live tmux this
    // backend never tracked. We must not kill it — predicate keys off liveness,
    // not "is it in my tracked set".
    const pids = orphanTtydPidsToReap(
      [{ pid: 200, tmuxTarget: 'tinstar-otherbackend', bindAddress: '127.0.0.1' }],
      new Set(['tinstar-otherbackend']),
      'tinstar-',
    )
    expect(pids).toEqual([])
  })

  it('does not touch non-tinstar ttyds even when their target is dead', () => {
    // The user's own `ttyd -p X bash -c "tmux attach -t my-notes"` must survive.
    const pids = orphanTtydPidsToReap(
      [{ pid: 300, tmuxTarget: 'my-notes', bindAddress: '127.0.0.1' }],
      new Set<string>(),
      'tinstar-',
    )
    expect(pids).toEqual([])
  })

  it('ignores ttyds with no tmux target (e.g. `ttyd htop`)', () => {
    const pids = orphanTtydPidsToReap(
      [{ pid: 400, tmuxTarget: null, bindAddress: '127.0.0.1' }],
      new Set<string>(),
      'tinstar-',
    )
    expect(pids).toEqual([])
  })

  it('reaps orphaned hand sessions too (they carry the prefix)', () => {
    // A dead child-hand session is just as much a squatter as a top-level one.
    const pids = orphanTtydPidsToReap(
      [{ pid: 500, tmuxTarget: 'tinstar-foo-reviewer-ab12', bindAddress: '127.0.0.1' }],
      new Set(['tinstar-foo']), // parent alive, hand dead
      'tinstar-',
    )
    expect(pids).toEqual([500])
  })

  it('partitions a realistic mixed fleet', () => {
    const pids = orphanTtydPidsToReap(
      [
        { pid: 1, tmuxTarget: 'tinstar-live', bindAddress: '127.0.0.1' },     // alive   → keep
        { pid: 2, tmuxTarget: 'tinstar-ghost', bindAddress: '127.0.0.1' },    // dead    → reap
        { pid: 3, tmuxTarget: 'tinstar-ghost2', bindAddress: '127.0.0.1' },   // dead    → reap
        { pid: 4, tmuxTarget: 'someones-tmux', bindAddress: '127.0.0.1' },    // foreign → keep
        { pid: 5, tmuxTarget: null, bindAddress: '127.0.0.1' },               // unknown → keep
      ],
      new Set(['tinstar-live']),
      'tinstar-',
    )
    expect(pids.sort((a, b) => a - b)).toEqual([2, 3])
  })
})

/** The address argument ttyd is told to bind, read out of a built argv. */
function bindArgFrom(argv: string[]): string | null {
  const flag = argv.indexOf('-i')
  return flag === -1 ? null : (argv[flag + 1] ?? null)
}

function ttydInstalled(): boolean {
  try {
    execFileSync('ttyd', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function firstNonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return null
}

function connectFails(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 1_500 })
    sock.on('connect', () => { sock.destroy(); resolve('connected') })
    sock.on('timeout', () => { sock.destroy(); resolve('timeout') })
    sock.on('error', (err: NodeJS.ErrnoException) => {
      sock.destroy()
      resolve(err.code ?? 'error')
    })
  })
}

async function waitForListener(port: number, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let out = ''
  while (Date.now() < deadline) {
    out = execFileSync('ss', ['-tln']).toString()
    const line = out.split('\n').find(l => l.includes(`:${port} `))
    if (line) return line
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`no listener on port ${port} within ${timeoutMs}ms; ss said:\n${out}`)
}

describe('terminal bind address — every spawned ttyd is loopback-only', () => {
  const opts = {
    sessionName: 'bind-addr',
    tmuxName: 'tinstar-bind-addr',
    port: 6321,
  }

  afterEach(() => {
    setTerminalBindAddress('127.0.0.1')
    stopManagedTtyd(opts.sessionName, {
      cancellationReason: 'session stop requested',
    })
  })

  it('defaults to the IPv4 loopback literal', () => {
    expect(terminalBindAddress()).toBe('127.0.0.1')
    expect(bindArgFrom(ttydSpawnArgv(opts))).toBe('127.0.0.1')
  })

  it('reflects a non-default address once the boot setter runs', () => {
    setTerminalBindAddress('127.0.0.2')
    expect(bindArgFrom(ttydSpawnArgv(opts))).toBe('127.0.0.2')
  })

  it('keeps the argv shape the tmux-target parser reads', () => {
    // The interface flag must not shadow ttyd's own -t options or the trailing
    // `tmux attach -t =<name>`, which identity inspection parses back out.
    const argv = ttydSpawnArgv(opts)
    expect(tmuxTargetFromArgs(['ttyd', ...argv].join(' '))).toBe(opts.tmuxName)
    expect(argv).toContain('-W')
    expect(argv[argv.indexOf('-p') + 1]).toBe(String(opts.port))
  })

  it('spawns the same interface argument on the restart-after-exit path', async () => {
    const argvs: string[][] = []
    const children = [fakeChild(811), fakeChild(812)]
    let spawnCount = 0
    const scheduled: Array<(...args: unknown[]) => void> = []
    const deps = fakeStartDeps({
      spawnProcess: vi.fn((o) => {
        argvs.push(ttydSpawnArgv(o))
        return children[spawnCount++]!
      }),
      tmuxAlive: vi.fn(async () => true),
      schedule: vi.fn((callback) => {
        scheduled.push(callback)
        return {} as NodeJS.Timeout
      }) as unknown as typeof setTimeout,
    })
    // Production's restart path re-enters the same attempt with the same opts.
    deps.enqueueRestart = (o, token) =>
      startTtydForTokenAttempt(o, token, () => true, deps)

    const attempt = startTtydWithDeps(opts, deps)
    await vi.waitFor(() => expect(scheduled).toHaveLength(1))
    scheduled.shift()!()
    await expect(attempt).resolves.toBe(811)

    children[0]!.emit('exit', 1)
    await vi.waitFor(() => expect(deps.tmuxAlive).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(scheduled).toHaveLength(1))
    scheduled.shift()!()
    await vi.waitFor(() => expect(argvs).toHaveLength(2))
    await vi.waitFor(() => expect(scheduled).toHaveLength(1))
    scheduled.shift()!()

    expect(argvs.map(bindArgFrom)).toEqual(['127.0.0.1', '127.0.0.1'])
  })

  it('spawns the same interface argument on the reattach path', async () => {
    const argvs: string[][] = []
    const deps = fakeStartDeps({
      spawnProcess: vi.fn((o) => {
        argvs.push(ttydSpawnArgv(o))
        return fakeChild(820 + argvs.length)
      }),
    })

    // Reattach after a backend restart lands the session on a fresh port.
    await expect(startTtydForTokenAttempt(
      opts, Symbol('initial'), () => true, deps,
    )).resolves.toBe(821)
    await expect(startTtydForTokenAttempt(
      { ...opts, port: opts.port + 1 }, Symbol('reattach'), () => true, deps,
    )).resolves.toBe(822)

    expect(argvs.map(bindArgFrom)).toEqual(['127.0.0.1', '127.0.0.1'])
  })

  const liveIt = ttydInstalled() ? it : it.skip

  liveIt('binds only loopback when a real ttyd is spawned', async () => {
    // An argv assertion cannot tell an accepted bind address from a silently
    // ignored one, so this one proves it against a live process. The port comes
    // from findPort, whose probe binds 127.0.0.1 — if the probe and the spawn
    // disagreed about the interface, the spawned terminal would fail to bind.
    const port = await findPort({ label: 'ttyd-bind-proof', start: 41_311, count: 40 })
    const argv = ttydSpawnArgv({
      sessionName: 'bind-proof',
      tmuxName: 'tinstar-bind-proof-nonexistent',
      port,
    })
    const child = spawn('ttyd', argv, { stdio: 'ignore' })
    try {
      const line = await waitForListener(port)
      expect(line).toContain(`127.0.0.1:${port}`)
      expect(line).not.toContain(`0.0.0.0:${port}`)
      expect(line).not.toContain(`*:${port}`)

      const lan = firstNonLoopbackIPv4()
      if (lan) {
        expect(await connectFails(lan, port)).not.toBe('connected')
      }
      expect(await connectFails('127.0.0.1', port)).toBe('connected')
    } finally {
      child.kill('SIGKILL')
      releasePort(port)
    }
  }, 20_000)
})

describe('inherited terminal bind — parsing an incumbent back out of ps args', () => {
  it('reads the interface argument the spawner wrote', () => {
    const argv = ttydSpawnArgv({
      sessionName: 'inherited',
      tmuxName: 'tinstar-inherited',
      port: 6321,
    })
    expect(ttydBindAddressFromArgs(['/usr/bin/ttyd', ...argv].join(' ')))
      .toBe('127.0.0.1')
  })

  it('returns null for a ttyd spawned before the bind flag existed', () => {
    expect(ttydBindAddressFromArgs(
      'ttyd -W -p 6321 -t titleFixed=Tinstar bash -c tmux attach -t =tinstar-old',
    )).toBe(null)
  })

  it('reads a non-loopback bind rather than assuming loopback', () => {
    expect(ttydBindAddressFromArgs(
      'ttyd -W -i 0.0.0.0 -p 6321 bash -c tmux attach -t =tinstar-wide',
    )).toBe('0.0.0.0')
  })

  it('returns null rather than throwing on an unexpected argument shape', () => {
    expect(ttydBindAddressFromArgs('')).toBe(null)
    expect(ttydBindAddressFromArgs('ttyd')).toBe(null)
    // A trailing flag with no value must not yield the empty string.
    expect(ttydBindAddressFromArgs('ttyd -W -i')).toBe(null)
  })
})

describe('inherited terminal bind — adoption requires the configured bind', () => {
  afterEach(() => {
    setTerminalBindAddress('127.0.0.1')
  })

  it('adopts an incumbent whose bind matches the configured one', () => {
    expect(ttydIncumbentMatchesSession(
      [{ pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: '127.0.0.1' }],
      101,
      'tinstar-ours',
    )).toBe(true)
  })

  it('refuses an incumbent left by a build that had no bind flag', () => {
    expect(ttydIncumbentMatchesSession(
      [{ pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: null }],
      101,
      'tinstar-ours',
    )).toBe(false)
  })

  it('refuses an incumbent bound to a different address', () => {
    expect(ttydIncumbentMatchesSession(
      [{ pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: '0.0.0.0' }],
      101,
      'tinstar-ours',
    )).toBe(false)
  })

  it('tracks the configured bind rather than the loopback literal', () => {
    setTerminalBindAddress('127.0.0.2')
    expect(ttydIncumbentMatchesSession(
      [{ pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: '127.0.0.1' }],
      101,
      'tinstar-ours',
    )).toBe(false)
    expect(ttydIncumbentMatchesSession(
      [{ pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: '127.0.0.2' }],
      101,
      'tinstar-ours',
    )).toBe(true)
  })

  it('carries the parsed bind onto the incumbent record', async () => {
    const run = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('-ti')) return { stdout: '101\n', stderr: '' }
      if (args[1] === 'comm=') return { stdout: 'ttyd\n', stderr: '' }
      return {
        stdout: 'ttyd -W -i 127.0.0.1 -p 6123 bash -c tmux attach -t =tinstar-ours\n',
        stderr: '',
      }
    })

    await expect(inspectTtydIncumbentsOnPort(6123, run as never)).resolves.toEqual([
      { pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: '127.0.0.1' },
    ])
  })

  it('refuses a mismatched incumbent at the readiness gate', async () => {
    await expect(verifyTtydSessionSurface(
      { port: 6123, pid: 101, tmuxName: 'tinstar-ours' },
      {
        incumbentsOnPort: async () =>
          [{ pid: 101, tmuxTarget: 'tinstar-ours', bindAddress: '0.0.0.0' }],
        healthCheck: async () => true,
      },
    )).resolves.toBe('unhealthy')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterBootDeletionCleanups,
  createSessionTtydReattachSingleFlight,
  describeTtydFailure,
  describeTtydReattachFailure,
  getLiveSessionForBoot,
  reconcileDeletingSessionOnBoot,
  reattachVerifiedSessionTtydAttempt,
  rehydrateDeletingSessionOnBoot,
  rehydrateRunProjectionFromSession,
  sessionNatsProjection,
  startupReattachStillCurrent,
} from '../index'
import {
  clearStoppedSessionPort,
  finishBootSessionDeletion,
  invalidatePersistedSessionBackendGenerationForConfig,
  persistedSessionBackendGenerationForConfig,
  reserveBootSessionDeletion,
  resetSessionBackendOwnersForTests,
} from '../api/routes'
import {
  createSession,
  deleteSession,
  getSession,
  setState,
  updateSession,
  type TinstarConfig,
  type Session,
} from '../sessions'
import {
  findTtydStartSupersededError,
  TtydIdentityInspectionError,
  TtydStartCancelledError,
  TtydStartSupersededError,
} from '../sessions/backends/tmux'
import { log } from '../logger'
import { DocumentStore } from '../stores/document-store'
import type { Run } from '../../domain/types'

const scratchRoots: string[] = []
const isNeverIdentityInspectionError = (): boolean => false
const findNoSupersededError = (): null => null

describe('sessionNatsProjection', () => {
  it('does not rehydrate historical subjects for a disabled session', () => {
    expect(sessionNatsProjection({
      nats: {
        enabled: false,
        subscriptions: ['tinstar.old.broadcast', 'tinstar.old.direct'],
      },
    })).toEqual({
      natsEnabled: false,
      natsSubject: undefined,
      natsSubscriptions: undefined,
    })
  })

  it('projects enabled subscriptions and prefers the direct subject', () => {
    expect(sessionNatsProjection({
      nats: {
        enabled: true,
        subscriptions: ['tinstar.broadcast', 'tinstar.direct'],
      },
    })).toEqual({
      natsEnabled: true,
      natsSubject: 'tinstar.direct',
      natsSubscriptions: ['tinstar.broadcast', 'tinstar.direct'],
    })
  })

  it('uses Session as the boot-time authority for a stale Run port', () => {
    const run = {
      id: 'stale-run-port',
      port: 6123,
      agentIcon: 'old-icon',
    } as Run
    const session = {
      port: null,
      background: false,
      nats: { enabled: false, subscriptions: [] },
      natsControlOrphanedAt: null,
    } satisfies Pick<
      Session,
      'port' | 'background' | 'nats' | 'natsControlOrphanedAt'
    >

    expect(rehydrateRunProjectionFromSession(run, session)).toMatchObject({
      port: null,
      agentIcon: 'old-icon',
    })
  })
})

describe('describeTtydFailure', () => {
  const cyclic = new Error('cycle')
  Object.defineProperty(cyclic, 'cause', { value: cyclic })
  const shared = new Error('shared')

  it.each([
    ['non-error', 'plain failure', 'plain failure'],
    [
      'cause chain',
      new Error('outer', { cause: new Error('inner', { cause: 'root' }) }),
      'outer; caused by: inner; caused by: root',
    ],
    [
      'aggregate',
      new AggregateError(
        [new Error('left'), new Error('right', { cause: 'detail' })],
        'combined',
      ),
      'combined; errors: [left | right; caused by: detail]',
    ],
    [
      'shared-node diamond',
      new AggregateError(
        [shared, new Error('branch', { cause: shared })],
        'diamond',
      ),
      'diamond; errors: [shared | branch; caused by: shared]',
    ],
    ['cause cycle', cyclic, 'cycle; caused by: [cycle: cycle]'],
  ])('renders a %s diagnostic', (_case, failure, expected) => {
    expect(describeTtydFailure(failure)).toBe(expected)
  })

  it('adds the non-causal interruption only when cleanup did not carry it', () => {
    const interrupted = new TtydStartSupersededError(
      'diagnostic-session',
      'post-spawn',
    )
    const cancellation = new TtydStartCancelledError(
      'diagnostic-session',
      'post-spawn',
      'session stop requested',
      interrupted,
    )

    expect(describeTtydReattachFailure(cancellation)).toContain(
      '; interrupted failure: ttyd start for diagnostic-session '
        + 'was superseded at post-spawn',
    )

    const withCleanup = new TtydStartCancelledError(
      'diagnostic-session',
      'post-spawn',
      'session stop requested',
      interrupted,
      {
        cause: new AggregateError(
          [interrupted, new Error('cleanup failed')],
          'cleanup aggregate',
        ),
      },
    )
    const described = describeTtydReattachFailure(withCleanup)
    expect(described).toContain(
      'cleanup aggregate; errors: [ttyd start for diagnostic-session '
        + 'was superseded at post-spawn | cleanup failed]',
    )
    expect(described).not.toContain('interrupted failure:')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetSessionBackendOwnersForTests()
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('getLiveSessionForBoot', () => {
  it('keeps a marked NATS record for cleanup but removes it from live Run/NATS rehydration', () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-deleting-boot-'))
    scratchRoots.push(root)
    const sessionsDir = join(root, 'sessions')
    createSession(sessionsDir, {
      name: 'marked-nats-session',
      backend: 'tmux',
      nats: {
        enabled: true,
        subscriptions: ['tinstar.broadcast', 'tinstar.direct'],
      },
    })
    setState(sessionsDir, 'marked-nats-session', 'running')
    updateSession(sessionsDir, 'marked-nats-session', { port: 6123 })

    const docStore = new DocumentStore()
    const run: Run = {
      id: 'marked-nats-session',
      status: 'running',
      background: false,
      blocked: false,
      sessionId: 'marked-nats-session',
      taskId: '',
      worktreeId: '',
      createdAt: '2026-07-30T00:00:00.000Z',
      initiative: '',
      epic: '',
      task: '',
      repo: '',
      worktree: '',
      touchedFiles: [],
      recapEntries: [],
      rawLogs: '',
      port: 6123,
      backend: 'tmux',
      natsEnabled: true,
      natsSubject: 'tinstar.direct',
      natsSubscriptions: ['tinstar.broadcast', 'tinstar.direct'],
      natsControlOrphanedAt: null,
    }
    docStore.upsertRun(run.id, run)
    writeFileSync(join(sessionsDir, 'marked-nats-session', '.deleting'), '')

    // This is the shared gate used by Run rehydration, Saloon subscription
    // registration, and NATS health tracking.
    expect(getLiveSessionForBoot(docStore, sessionsDir, 'marked-nats-session')).toBeNull()
    expect(docStore.getRun('marked-nats-session')).toBeUndefined()

    // Only cleanup evidence survives: the durable record and its claimed port.
    expect(getSession(sessionsDir, 'marked-nats-session')).toMatchObject({
      state: 'running',
      port: 6123,
      nats: { enabled: true },
    })
  })

  it('finishes a retained deletion at boot when strict probing confirms absence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-deleting-boot-'))
    scratchRoots.push(root)
    const sessionsDir = join(root, 'sessions')
    const session = createSession(sessionsDir, {
      name: 'gone-on-restart',
      backend: 'tmux',
    })
    updateSession(sessionsDir, session.name, { port: 6123 })
    writeFileSync(join(sessionsDir, session.name, '.deleting'), '')
    const releasePort = vi.fn()
    let backendAlive = true
    const retryTeardown = vi.fn(async () => {
      backendAlive = false
    })

    const result = await reconcileDeletingSessionOnBoot(
      { dirs: { sessions: sessionsDir } } as TinstarConfig,
      getSession(sessionsDir, session.name)!,
      {
        deleteTmuxSession: retryTeardown,
        getTmuxSessionState: vi.fn(async () =>
          backendAlive ? 'exists' as const : 'missing' as const),
        deleteSession,
        releasePort,
      },
    )

    expect(result).toBe('deleted')
    expect(retryTeardown).toHaveBeenCalled()
    expect(getSession(sessionsDir, session.name)).toBeNull()
    expect(releasePort).toHaveBeenCalledWith(6123)
  })

  it('retains boot cleanup evidence when the backend probe cannot establish absence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-deleting-boot-'))
    scratchRoots.push(root)
    const sessionsDir = join(root, 'sessions')
    const session = createSession(sessionsDir, {
      name: 'unknown-on-restart',
      backend: 'tmux',
    })
    updateSession(sessionsDir, session.name, { port: 6123 })
    writeFileSync(join(sessionsDir, session.name, '.deleting'), '')
    const deleteRecord = vi.fn(() => true)
    const releasePort = vi.fn()

    const result = await reconcileDeletingSessionOnBoot(
      { dirs: { sessions: sessionsDir } } as TinstarConfig,
      getSession(sessionsDir, session.name)!,
      {
        deleteTmuxSession: vi.fn(async () => {
          throw new Error('kill failed')
        }),
        getTmuxSessionState: vi.fn(async () => {
          throw new Error('tmux unavailable')
        }),
        deleteSession: deleteRecord,
        releasePort,
      },
    )

    expect(result).toBe('retained')
    expect(deleteRecord).not.toHaveBeenCalled()
    expect(releasePort).not.toHaveBeenCalled()
    expect(getSession(sessionsDir, session.name)).not.toBeNull()
  })

  it('retries teardown and retains the record when the backend is still live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-deleting-boot-'))
    scratchRoots.push(root)
    const sessionsDir = join(root, 'sessions')
    const session = createSession(sessionsDir, {
      name: 'live-on-restart',
      backend: 'tmux',
    })
    updateSession(sessionsDir, session.name, { port: 6123 })
    writeFileSync(join(sessionsDir, session.name, '.deleting'), '')
    const retryTeardown = vi.fn(async () => undefined)
    const deleteRecord = vi.fn(() => true)
    const releasePort = vi.fn()

    const result = await reconcileDeletingSessionOnBoot(
      { dirs: { sessions: sessionsDir } } as TinstarConfig,
      getSession(sessionsDir, session.name)!,
      {
        deleteTmuxSession: retryTeardown,
        getTmuxSessionState: vi.fn(async () => 'exists' as const),
        deleteSession: deleteRecord,
        releasePort,
      },
    )

    expect(result).toBe('retained')
    expect(retryTeardown).toHaveBeenCalled()
    expect(deleteRecord).not.toHaveBeenCalled()
    expect(releasePort).not.toHaveBeenCalled()
    expect(getSession(sessionsDir, session.name)).not.toBeNull()
  })

  it('wires a deleting boot record through port claim, cleanup, and owner release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-deleting-boot-wiring-'))
    scratchRoots.push(root)
    const sessionsDir = join(root, 'sessions')
    const config = {
      dirs: { sessions: sessionsDir },
      sessions: { prefix: 'tinstar-' },
    } as TinstarConfig
    const session = createSession(sessionsDir, {
      name: 'wired-boot-delete',
      backend: 'tmux',
    })
    updateSession(sessionsDir, session.name, { port: 6123 })
    writeFileSync(join(sessionsDir, session.name, '.deleting'), '')
    const claimPort = vi.fn()
    const releasePort = vi.fn()

    await expect(rehydrateDeletingSessionOnBoot(config, session.name, {
      claimPort,
      releasePort,
      reserveBootSessionDeletion,
      finishBootSessionDeletion,
      deleteTmuxSession: vi.fn(async () => undefined),
      getTmuxSessionState: vi.fn(async () => 'missing' as const),
      deleteSession,
    })).resolves.toBe('deleted')

    expect(claimPort).toHaveBeenCalledWith(6123)
    expect(releasePort).toHaveBeenCalledWith(6123)
    expect(getSession(sessionsDir, session.name)).toBeNull()
    // A new reservation proves the boot owner was released rather than left
    // invisibly fencing this process-wide name.
    const nextToken = reserveBootSessionDeletion(
      sessionsDir,
      config.sessions.prefix,
      session.name,
    )
    expect(nextToken).not.toBeNull()
    finishBootSessionDeletion(sessionsDir, session.name, nextToken!, 'deleted')
  })

  it('clears a stale claimed port when reconciliation confirms the backend stopped', () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-stopped-port-'))
    scratchRoots.push(root)
    const sessionsDir = join(root, 'sessions')
    const session = createSession(sessionsDir, {
      name: 'stale-port',
      backend: 'tmux',
    })
    updateSession(sessionsDir, session.name, { port: 6123, ttydPid: 4242 })
    const docStore = new DocumentStore()
    docStore.upsertRun(session.name, {
      id: session.name,
      sessionId: session.name,
      status: 'running',
      port: 6123,
    } as Run)
    const releasePort = vi.fn()

    clearStoppedSessionPort(
      { dirs: { sessions: sessionsDir } } as TinstarConfig,
      docStore,
      session.name,
      releasePort,
    )

    expect(releasePort).toHaveBeenCalledWith(6123)
    expect(getSession(sessionsDir, session.name)).toMatchObject({
      port: null,
      ttydPid: null,
    })
    expect(docStore.getRun(session.name)?.port).toBeNull()
  })

  it('rejects a startup reattach result after its backend generation changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-reattach-generation-'))
    scratchRoots.push(root)
    const sessionsDir = join(root, 'sessions')
    const config = {
      dirs: { sessions: sessionsDir },
      sessions: { prefix: 'tinstar-' },
    } as TinstarConfig
    const session = createSession(sessionsDir, {
      name: 'stale-startup-reattach',
      backend: 'tmux',
    })
    setState(sessionsDir, session.name, 'running')
    const generation = persistedSessionBackendGenerationForConfig(
      config,
      session.name,
    )!

    expect(
      startupReattachStillCurrent(config, session, generation),
    ).toBe(true)
    expect(
      invalidatePersistedSessionBackendGenerationForConfig(
        config,
        session.name,
        generation,
      ),
    ).toBe(true)
    setState(sessionsDir, session.name, 'stopped')
    expect(
      startupReattachStillCurrent(config, session, generation),
    ).toBe(false)
  })

  it('waits for stale marshal cleanup before attempting auto-ensure', async () => {
    let finishCleanup!: () => void
    const cleanup = new Promise<void>(resolve => {
      finishCleanup = resolve
    })
    const ensureMarshal = vi.fn(async () => 'ready')

    const ensuring = afterBootDeletionCleanups([cleanup], ensureMarshal)
    await Promise.resolve()
    expect(ensureMarshal).not.toHaveBeenCalled()

    finishCleanup()
    await expect(ensuring).resolves.toBe('ready')
    expect(ensureMarshal).toHaveBeenCalledTimes(1)
  })

  it('attempts marshal auto-ensure after a boot cleanup rejects', async () => {
    const ensureMarshal = vi.fn(async () => 'ready')

    await expect(afterBootDeletionCleanups(
      [Promise.reject(new Error('cleanup crashed'))],
      ensureMarshal,
    )).resolves.toBe('ready')
    expect(ensureMarshal).toHaveBeenCalledTimes(1)
  })

  it('releases a failed fresh reattach port exactly once', async () => {
    const session = {
      name: 'fresh-port-failure',
      state: 'running',
      port: null,
      ttydPid: null,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const releasePort = vi.fn()
    const releaseLease = vi.fn()
    const update = vi.fn(() => session)
    const stopTtyd = vi.fn()

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: findNoSupersededError,
        acquireLease: () => ({ token: 'generation', release: releaseLease }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async (_config, opts) => ({ port: opts.port, ttydPid: 101 }),
        isCurrent: () => true,
        verifySurface: async () => 'unhealthy',
        stopTtyd,
        releasePort,
        updateSession: update,
        tmuxName: () => 'tinstar-fresh-port-failure',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(releasePort).toHaveBeenCalledTimes(1)
    expect(releasePort).toHaveBeenCalledWith(7000)
    expect(stopTtyd).toHaveBeenCalledTimes(1)
    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach verification compensation',
    })
    expect(update).not.toHaveBeenCalled()
    expect(releaseLease).toHaveBeenCalledTimes(1)
  })

  it('labels ownership loss immediately after the first reattach', async () => {
    const session = {
      name: 'first-reattach-stale',
      state: 'running',
      port: null,
      ttydPid: null,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const stopTtyd = vi.fn()
    const releasePort = vi.fn()
    const verifySurface = vi.fn(async () => 'verified' as const)

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: findNoSupersededError,
        acquireLease: () => ({ token: 'generation', release: vi.fn() }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async (_config, opts) => ({
          port: opts.port,
          ttydPid: 101,
        }),
        isCurrent: () => false,
        verifySurface,
        stopTtyd,
        releasePort,
        updateSession: vi.fn(() => session),
        tmuxName: () => 'tinstar-first-reattach-stale',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach lifecycle ownership lost',
    })
    expect(releasePort).toHaveBeenCalledWith(7000)
    expect(verifySurface).not.toHaveBeenCalled()
  })

  it('labels compensation for an inconclusive fresh replacement', async () => {
    const session = {
      name: 'fresh-inspection-inconclusive',
      state: 'running',
      port: null,
      ttydPid: null,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const stopTtyd = vi.fn()
    const releasePort = vi.fn()

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: findNoSupersededError,
        acquireLease: () => ({ token: 'generation', release: vi.fn() }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async (_config, opts) => ({
          port: opts.port,
          ttydPid: 101,
        }),
        isCurrent: () => true,
        verifySurface: async () => 'inconclusive',
        stopTtyd,
        releasePort,
        updateSession: vi.fn(() => session),
        tmuxName: () => 'tinstar-fresh-inspection-inconclusive',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach inconclusive-surface compensation',
    })
    expect(releasePort).toHaveBeenCalledWith(7000)
  })

  it('leaves an incumbent untouched when identity inspection is inconclusive', async () => {
    const inspectionError = new Error('lsof timed out')
    const session = {
      name: 'inspection-inconclusive',
      state: 'running',
      port: 6123,
      ttydPid: 99,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const stopTtyd = vi.fn()
    const releasePort = vi.fn()
    const update = vi.fn(() => session)
    const releaseLease = vi.fn()

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: err => err === inspectionError,
        findSupersededError: findNoSupersededError,
        acquireLease: () => ({ token: 'generation', release: releaseLease }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async () => { throw inspectionError },
        isCurrent: () => true,
        verifySurface: async () => 'verified',
        stopTtyd,
        releasePort,
        updateSession: update,
        tmuxName: () => 'tinstar-inspection-inconclusive',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(stopTtyd).not.toHaveBeenCalled()
    expect(releasePort).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(releaseLease).toHaveBeenCalledTimes(1)
  })

  it('leaves a newer terminal start untouched and returns its own fresh claim', async () => {
    const inspectionError = new TtydIdentityInspectionError(
      'lsof failed during replacement',
    )
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const supersededError = new Error('reattach wrapped the terminal error', {
      cause: new TtydStartSupersededError(
        'superseded-reattach',
        'settlement',
        { cause: inspectionError },
      ),
    })
    const session = {
      name: 'superseded-reattach',
      state: 'running',
      port: null,
      ttydPid: null,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const stopTtyd = vi.fn()
    const releasePort = vi.fn()
    const update = vi.fn(() => session)
    const releaseLease = vi.fn()

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: err =>
          err instanceof TtydIdentityInspectionError,
        findSupersededError: findTtydStartSupersededError,
        acquireLease: () => ({ token: 'generation', release: releaseLease }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async () => { throw supersededError },
        isCurrent: () => true,
        verifySurface: async () => 'verified',
        stopTtyd,
        releasePort,
        updateSession: update,
        tmuxName: () => 'tinstar-superseded-reattach',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(stopTtyd).not.toHaveBeenCalled()
    expect(releasePort).toHaveBeenCalledTimes(1)
    expect(releasePort).toHaveBeenCalledWith(7000)
    expect(update).not.toHaveBeenCalled()
    expect(releaseLease).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'reattach',
      expect.stringContaining(
        'identity inspection failed while reattach was superseded',
      ),
    )
  })

  it('compensates a cancelled terminal start with the production matcher', async () => {
    const session = {
      name: 'cancelled-reattach',
      state: 'running',
      port: null,
      ttydPid: null,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const stopTtyd = vi.fn()
    const releasePort = vi.fn()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const cleanupFailure = new Error('stale terminal cleanup failed')
    const interrupted = new TtydStartSupersededError(
      session.name,
      'post-spawn',
    )
    const cancellation = new TtydStartCancelledError(
      session.name,
      'post-spawn',
      'session deletion requested',
      interrupted,
      {
        cause: new AggregateError(
          [interrupted, cleanupFailure],
          `stale ttyd start cleanup failed for ${session.name}`,
        ),
      },
    )

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: findTtydStartSupersededError,
        acquireLease: () => ({ token: 'generation', release: vi.fn() }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async () => {
          throw new Error('provider adapter failed', { cause: cancellation })
        },
        isCurrent: () => true,
        verifySurface: async () => 'verified',
        stopTtyd,
        releasePort,
        updateSession: vi.fn(() => session),
        tmuxName: () => 'tinstar-cancelled-reattach',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(stopTtyd).toHaveBeenCalledTimes(1)
    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach failure compensation',
    })
    expect(releasePort).toHaveBeenCalledTimes(1)
    expect(releasePort).toHaveBeenCalledWith(7000)
    expect(warn).toHaveBeenCalledWith(
      'reattach',
      expect.stringContaining(
        'provider adapter failed; caused by: ttyd start for '
          + 'cancelled-reattach was cancelled at post-spawn; caused by: '
          + 'stale ttyd start cleanup failed for cancelled-reattach; errors: '
          + '[ttyd start for cancelled-reattach was superseded at post-spawn '
          + `| ${cleanupFailure.message}]`,
      ),
    )
    expect(warn).toHaveBeenCalledWith(
      'reattach',
      expect.stringContaining(
        'cancellation reason: session deletion requested',
      ),
    )
    const failureLog = warn.mock.calls.find(
      ([scope, message]) =>
        scope === 'reattach'
        && String(message).includes('provider adapter failed'),
    )?.[1]
    expect(failureLog).not.toContain('interrupted failure:')
  })

  it('respects an injected negative supersession classifier', async () => {
    const session = {
      name: 'not-superseded-reattach',
      state: 'running',
      port: 6123,
      ttydPid: 99,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const stopTtyd = vi.fn()

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: () => null,
        acquireLease: () => ({ token: 'generation', release: vi.fn() }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async () => {
          throw new TtydStartSupersededError(session.name, 'preflight')
        },
        isCurrent: () => true,
        verifySurface: async () => 'verified',
        stopTtyd,
        releasePort: vi.fn(),
        updateSession: vi.fn(() => session),
        tmuxName: () => 'tinstar-not-superseded-reattach',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(stopTtyd).toHaveBeenCalledTimes(1)
    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach failure compensation',
    })
  })

  it('compensates a generic failure after reattach has produced a surface', async () => {
    const session = {
      name: 'post-reattach-failure',
      state: 'running',
      port: 6123,
      ttydPid: 99,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const stopTtyd = vi.fn()
    const releasePort = vi.fn()
    const update = vi.fn(() => session)

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: findNoSupersededError,
        acquireLease: () => ({ token: 'generation', release: vi.fn() }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async () => ({ port: 6123, ttydPid: 101 }),
        isCurrent: () => true,
        verifySurface: async () => { throw new Error('verification crashed') },
        stopTtyd,
        releasePort,
        updateSession: update,
        tmuxName: () => 'tinstar-post-reattach-failure',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(stopTtyd).toHaveBeenCalledTimes(1)
    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach failure compensation',
    })
    expect(releasePort).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('durably retires a stale port before publishing a verified replacement', async () => {
    let session = {
      name: 'stale-port-migration',
      state: 'running',
      port: 6123,
      ttydPid: 99,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const releasePort = vi.fn()
    const update = vi.fn((
      _sessionsDir: string,
      _name: string,
      patch: Partial<Session>,
    ) => {
      session = { ...session, ...patch }
      return session
    })
    const verifySurface = vi.fn()
      .mockResolvedValueOnce('unhealthy')
      .mockResolvedValueOnce('verified')
    const stopTtyd = vi.fn()

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: findNoSupersededError,
        acquireLease: () => ({ token: 'generation', release: vi.fn() }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async (_config, opts) => ({ port: opts.port, ttydPid: 101 }),
        isCurrent: () => true,
        verifySurface,
        stopTtyd,
        releasePort,
        updateSession: update,
        tmuxName: () => 'tinstar-stale-port-migration',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(true)

    expect(update.mock.calls.map(call => call[2])).toEqual([
      { port: null, ttydPid: null },
      { port: 7000, ttydPid: 101 },
    ])
    expect(releasePort).toHaveBeenCalledTimes(1)
    expect(releasePort).toHaveBeenCalledWith(6123)
    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach unhealthy-surface retirement',
    })
    expect(session).toMatchObject({ port: 7000, ttydPid: 101 })
  })

  it.each([
    [
      'a second verification failure',
      'throws',
      'reattach failure compensation',
    ],
    [
      'a rejected second reattach',
      'reattach-throws',
      'reattach failure compensation',
    ],
    [
      'ownership loss after the second reattach',
      'stale',
      'reattach lifecycle ownership lost',
    ],
    [
      'an inconclusive second surface',
      'inconclusive',
      'reattach inconclusive-surface compensation',
    ],
  ] as const)(
    'compensates %s after unhealthy-surface retirement',
    async (_case, outcome, secondReason) => {
      let session = {
        name: `retirement-${outcome}`,
        state: 'running',
        port: 6123,
        ttydPid: 99,
        created: '2026-07-30T00:00:00.000Z',
      } as Session
      const stopTtyd = vi.fn()
      const releasePort = vi.fn()
      const updateSession = vi.fn((
        _sessionsDir: string,
        _name: string,
        patch: Partial<Session>,
      ) => {
        session = { ...session, ...patch }
        return session
      })
      let currentChecks = 0
      const isCurrent = vi.fn(() => {
        currentChecks += 1
        return outcome !== 'stale' || currentChecks < 3
      })
      let verifications = 0
      const verifySurface = vi.fn(async () => {
        verifications += 1
        if (verifications === 1) return 'unhealthy' as const
        if (outcome === 'throws') throw new Error('second verification failed')
        return 'inconclusive' as const
      })
      let reattachments = 0
      const reattach = vi.fn(async (
        _config: TinstarConfig,
        opts: { port: number },
      ) => {
        reattachments += 1
        if (outcome === 'reattach-throws' && reattachments === 2) {
          throw new Error('second reattach failed')
        }
        return { port: opts.port, ttydPid: 101 }
      })

      await expect(reattachVerifiedSessionTtydAttempt(
        { dirs: { sessions: '/sessions' } } as TinstarConfig,
        new DocumentStore(),
        session.name,
        'generation',
        {
          identityInspectionUnavailable: () => false,
          isIdentityInspectionError: isNeverIdentityInspectionError,
          findSupersededError: findNoSupersededError,
          acquireLease: () => ({ token: 'generation', release: vi.fn() }),
          getSession: () => session,
          findPort: async () => 7000,
          reattach,
          isCurrent,
          verifySurface,
          stopTtyd,
          releasePort,
          updateSession,
          tmuxName: () => `tinstar-retirement-${outcome}`,
          onTtydRestart: vi.fn(),
        },
      )).resolves.toBe(false)

      expect(stopTtyd).toHaveBeenCalledTimes(2)
      expect(stopTtyd).toHaveBeenNthCalledWith(1, session.name, {
        cancellationReason: 'reattach unhealthy-surface retirement',
      })
      expect(stopTtyd).toHaveBeenNthCalledWith(2, session.name, {
        cancellationReason: secondReason,
      })
      expect(releasePort).toHaveBeenCalledWith(6123)
      expect(releasePort).toHaveBeenCalledWith(7000)
    },
  )

  it('publishes nothing when the generation becomes stale after reattach', async () => {
    const session = {
      name: 'stale-generation-reattach',
      state: 'running',
      port: null,
      ttydPid: null,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const update = vi.fn(() => session)
    const releasePort = vi.fn()
    const stopTtyd = vi.fn()
    const isCurrent = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: findNoSupersededError,
        acquireLease: () => ({ token: 'generation', release: vi.fn() }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async (_config, opts) => ({ port: opts.port, ttydPid: 101 }),
        isCurrent,
        verifySurface: async () => 'verified',
        stopTtyd,
        releasePort,
        updateSession: update,
        tmuxName: () => 'tinstar-stale-generation-reattach',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(update).not.toHaveBeenCalled()
    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach lifecycle ownership lost',
    })
    expect(releasePort).toHaveBeenCalledTimes(1)
    expect(releasePort).toHaveBeenCalledWith(7000)
  })

  it('labels compensation when verified terminal publication is refused', async () => {
    const session = {
      name: 'publication-refused-reattach',
      state: 'running',
      port: null,
      ttydPid: null,
      created: '2026-07-30T00:00:00.000Z',
    } as Session
    const stopTtyd = vi.fn()
    const releasePort = vi.fn()

    await expect(reattachVerifiedSessionTtydAttempt(
      { dirs: { sessions: '/sessions' } } as TinstarConfig,
      new DocumentStore(),
      session.name,
      'generation',
      {
        identityInspectionUnavailable: () => false,
        isIdentityInspectionError: isNeverIdentityInspectionError,
        findSupersededError: findNoSupersededError,
        acquireLease: () => ({ token: 'generation', release: vi.fn() }),
        getSession: () => session,
        findPort: async () => 7000,
        reattach: async (_config, opts) => ({
          port: opts.port,
          ttydPid: 101,
        }),
        isCurrent: () => true,
        verifySurface: async () => 'verified',
        stopTtyd,
        releasePort,
        updateSession: vi.fn(() => null),
        tmuxName: () => 'tinstar-publication-refused-reattach',
        onTtydRestart: vi.fn(),
      },
    )).resolves.toBe(false)

    expect(stopTtyd).toHaveBeenCalledWith(session.name, {
      cancellationReason: 'reattach publication compensation',
    })
    expect(releasePort).toHaveBeenCalledWith(7000)
  })

  it('single-flights concurrent reattach attempts for the same name', async () => {
    let finish!: (value: boolean) => void
    const operation = vi.fn(() => new Promise<boolean>(resolve => {
      finish = resolve
    }))
    const singleFlight = createSessionTtydReattachSingleFlight(operation)

    const first = singleFlight('same-name', 'generation-1')
    const second = singleFlight('same-name', 'generation-1')
    expect(first).toBe(second)
    expect(operation).toHaveBeenCalledTimes(1)

    const newer = singleFlight('same-name', 'generation-2')
    expect(newer).not.toBe(first)
    expect(singleFlight('same-name', 'generation-1')).toBe(first)
    expect(operation).toHaveBeenCalledTimes(1)

    finish(true)
    await expect(first).resolves.toBe(true)
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2))
    finish(false)
    await expect(newer).resolves.toBe(false)

    operation.mockImplementationOnce(async () => true)
    await singleFlight('same-name', 'generation-3')
    expect(operation).toHaveBeenCalledTimes(3)
  })
})

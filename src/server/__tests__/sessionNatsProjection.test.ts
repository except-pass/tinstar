import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterBootDeletionCleanups,
  getLiveSessionForBoot,
  reconcileDeletingSessionOnBoot,
  sessionNatsProjection,
  startupReattachStillCurrent,
} from '../index'
import {
  clearStoppedSessionPort,
  invalidatePersistedSessionBackendGenerationForConfig,
  persistedSessionBackendGenerationForConfig,
} from '../api/routes'
import {
  createSession,
  deleteSession,
  getSession,
  setState,
  updateSession,
  type TinstarConfig,
} from '../sessions'
import { DocumentStore } from '../stores/document-store'
import type { Run } from '../../domain/types'

const scratchRoots: string[] = []

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
})

afterEach(() => {
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
})

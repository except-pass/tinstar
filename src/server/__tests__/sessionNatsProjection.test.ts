import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLiveSessionForBoot, sessionNatsProjection } from '../index'
import { createSession, getSession, setState, updateSession } from '../sessions'
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
})

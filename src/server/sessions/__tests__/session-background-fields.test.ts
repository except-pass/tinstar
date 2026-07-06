// @vitest-environment node
//
// U1 of the background-sessions plan: `background` and `blocked` are persisted
// on the session record, backfilled for pre-existing session.json files, and
// mirrored onto the Run projection so flips emit SSE deltas.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, getSession, type Session } from '../session'
import { DocumentStore } from '../../stores/document-store'
import type { Run } from '../../../domain/types'

let sessionsDir: string

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'tinstar-bg-fields-'))
})

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true })
})

describe('getSession backfill — background/blocked', () => {
  it('backfills both fields to false for a pre-existing session.json without them', () => {
    // Simulate a session persisted before the fields existed: create one, then
    // strip the new fields from the raw JSON on disk.
    createSession(sessionsDir, { name: 'legacy', backend: 'tmux' })
    const file = join(sessionsDir, 'legacy', 'session.json')
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    delete raw.background
    delete raw.blocked
    writeFileSync(file, JSON.stringify(raw, null, 2))

    const sess = getSession(sessionsDir, 'legacy')!
    expect(sess.background).toBe(false)
    expect(sess.blocked).toBe(false)
  })

  it('backfills a hand-written minimal session.json (no fields at all beyond the old shape)', () => {
    const dir = join(sessionsDir, 'ancient')
    mkdirSync(dir, { recursive: true })
    const oldShape: Partial<Session> = {
      name: 'ancient',
      backend: 'tmux',
      state: 'idle',
      project: null,
      workspace: { path: null, worktree: false, branch: null, basePath: null },
      conversation: { id: null },
      profile: null,
      oneshot: false,
      skipPermissions: false,
      cliTemplate: null,
      adapter: null,
      nats: null,
      port: null,
      ttydPid: null,
      created: '2026-01-01T00:00:00.000Z',
      lastActive: '2026-01-01T00:00:00.000Z',
    }
    writeFileSync(join(dir, 'session.json'), JSON.stringify(oldShape, null, 2))

    const sess = getSession(sessionsDir, 'ancient')!
    expect(sess.background).toBe(false)
    expect(sess.blocked).toBe(false)
  })
})

describe('createSession — background/blocked defaults', () => {
  it('defaults both fields to false and persists them to session.json', () => {
    const created = createSession(sessionsDir, { name: 's1', backend: 'tmux' })
    expect(created.background).toBe(false)
    expect(created.blocked).toBe(false)

    const onDisk = JSON.parse(
      readFileSync(join(sessionsDir, 's1', 'session.json'), 'utf-8'),
    ) as Session
    expect(onDisk.background).toBe(false)
    expect(onDisk.blocked).toBe(false)
  })

  it('persists background: true when opted in at creation', () => {
    const created = createSession(sessionsDir, { name: 's2', backend: 'tmux', background: true })
    expect(created.background).toBe(true)
    // Round-trips through getSession — the backfill must not stomp a real true.
    expect(getSession(sessionsDir, 's2')!.background).toBe(true)
  })
})

// Boot-rehydrate projection seam. `initBackend` in src/server/index.ts has no
// test harness (it is the whole plugin server), so this pins the two seams the
// rehydrate path is built from: (1) a session.json persisted with
// background: true survives getSession un-stomped, and (2) mirroring the
// session fields onto an existing Run via the refresh spread emits exactly one
// docstore delta (the comparator entry). The literal spread in index.ts is
// exercised by e2e in a later unit.
describe('rehydrate projection seam — session fields onto the Run', () => {
  function makeRun(overrides: Partial<Run> = {}): Run {
    return {
      id: 'bg1',
      status: 'idle',
      background: false,
      blocked: false,
      sessionId: 'bg1',
      initiative: '',
      epic: '',
      task: '',
      repo: '',
      worktree: '',
      taskId: '',
      worktreeId: '',
      createdAt: '2026-07-01T00:00:00.000Z',
      touchedFiles: [],
      recapEntries: [],
      rawLogs: '',
      port: null,
      backend: 'tmux',
      ...overrides,
    }
  }

  it('projects background/blocked from the persisted session onto a stale Run with one delta', () => {
    createSession(sessionsDir, { name: 'bg1', backend: 'tmux', background: true, blocked: true })
    const sess = getSession(sessionsDir, 'bg1')!

    const store = new DocumentStore()
    // Pre-restart Run that never knew about the fields (defaults false).
    const existingRun = makeRun()
    store.upsertRun('bg1', existingRun)

    const events: unknown[] = []
    store.changes.on('change', e => events.push(e))

    // The "refresh fields that mirror live session state" spread from
    // src/server/index.ts boot rehydrate.
    store.upsertRun('bg1', {
      ...existingRun,
      background: sess.background ?? false,
      blocked: sess.blocked ?? false,
    })

    expect(events).toHaveLength(1)
    expect(store.getRun('bg1')!.background).toBe(true)
    expect(store.getRun('bg1')!.blocked).toBe(true)
  })

  it('is a no-op (no delta) when the Run already mirrors the session', () => {
    createSession(sessionsDir, { name: 'bg1', backend: 'tmux' })
    const sess = getSession(sessionsDir, 'bg1')!

    const store = new DocumentStore()
    const existingRun = makeRun()
    store.upsertRun('bg1', existingRun)

    const events: unknown[] = []
    store.changes.on('change', e => events.push(e))

    store.upsertRun('bg1', {
      ...existingRun,
      background: sess.background ?? false,
      blocked: sess.blocked ?? false,
    })

    expect(events).toHaveLength(0)
  })
})

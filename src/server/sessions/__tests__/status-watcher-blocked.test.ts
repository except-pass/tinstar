// @vitest-environment node
//
// U3 of the background-sessions plan: blocked-state changes are observable.
// Pins the three verified silent-failure paths of the pre-U3 StatusWatcher:
//   1. a block that begins while the session is already `idle` emitted nothing
//      (transitionState was guarded by `session.state !== 'idle'`),
//   2. the in-memory processTreeOverride died on restart (blocked was never
//      persisted to session.json),
//   3. an override clearing while the status string stayed `idle` emitted
//      nothing, leaving stale "Waiting on permission" attention.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderTranscriptAdapter } from '../../providers/lifecycle'
import { log } from '../../logger'
import { StatusWatcher } from '../status-watcher'
import { createSession, getSession, updateSession, type Session, type SessionState } from '../session'

// checkProcessTree shells out to tmux/pgrep via execFile. Script the process
// tree per test: pane pid 100 → agent pid 200 → children controlled by
// `hasChildren`.
const proc = vi.hoisted(() => ({
  hasChildren: false,
  childError: false,
  paneTimeout: false,
  paneFailure: null as null | 'missing' | 'permission' | 'enoent',
  deferPane: false,
  finishPane: null as null | (() => void),
  calls: 0,
  tmuxArgs: [] as string[],
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      proc.calls++
      if (cmd === 'tmux') {
        proc.tmuxArgs = args
        if (proc.deferPane) {
          proc.finishPane = () => cb(
            Object.assign(new Error('missing tmux pane'), { code: 1 }),
            '',
            'can\'t find session: tinstar-delayed',
          )
          return
        }
        if (proc.paneTimeout) {
          return cb(
            Object.assign(new Error('tmux probe timed out'), {
              killed: true,
              signal: 'SIGTERM',
            }),
            '',
            '',
          )
        }
        if (proc.paneFailure === 'missing') {
          return cb(
            Object.assign(new Error('missing tmux pane'), { code: 1 }),
            '',
            'can\'t find session: tinstar-missing',
          )
        }
        if (proc.paneFailure === 'permission') {
          return cb(
            Object.assign(new Error('tmux permission denied'), { code: 1 }),
            '',
            'error connecting to /tmp/tmux-1000/default (Permission denied)',
          )
        }
        if (proc.paneFailure === 'enoent') {
          return cb(
            Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }),
            '',
            '',
          )
        }
        return cb(null, '100\n', '')
      }
      if (cmd === 'pgrep' && args[1] === '100') return cb(null, '200\n', '')
      if (cmd === 'pgrep' && args[1] === '200') {
        if (proc.childError) {
          return cb(Object.assign(new Error('pgrep permission denied'), { code: 2 }), '', '')
        }
        return proc.hasChildren
          ? cb(null, '300\n', '')
          : cb(Object.assign(new Error('no children'), { code: 1 }), '', '')
      }
      return cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`), '', '')
    },
  }
})

let sessionsDir: string
let onStatusChanged: ReturnType<typeof vi.fn>
let onRecapEntries: ReturnType<typeof vi.fn>
let watcher: StatusWatcher

// Test-seam accessor for the watcher's private internals.
function internals(w: StatusWatcher) {
  return w as unknown as {
    checkSession(session: Session): Promise<void>
    checkProcessTree(session: Session): Promise<void>
    processTreeOverride: Set<string>
    transcriptPaths: Map<string, string>
    transcriptAdapters: Map<string, ProviderTranscriptAdapter>
  }
}

function makeSession(name: string, state: SessionState, extra: Partial<Session> = {}): Session {
  createSession(sessionsDir, { name, backend: 'tmux' })
  updateSession(sessionsDir, name, { state, ...extra })
  return getSession(sessionsDir, name)!
}

/** Write a transcript whose last line is an assistant text-only turn → idle, no pending tool_use. */
function writeIdleTranscript(): string {
  const path = join(sessionsDir, 'transcript.jsonl')
  writeFileSync(path, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'done' }] },
  }) + '\n')
  return path
}

/** Write a transcript whose last line is an assistant tool_use turn → running, tool pending. */
function writePendingTranscript(): string {
  const path = join(sessionsDir, 'transcript-pending.jsonl')
  writeFileSync(path, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  }) + '\n')
  return path
}

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'tinstar-watcher-blocked-'))
  onStatusChanged = vi.fn()
  onRecapEntries = vi.fn()
  watcher = new StatusWatcher({ sessionsDir, onStatusChanged, onRecapEntries })
  proc.hasChildren = false
  proc.childError = false
  proc.paneTimeout = false
  proc.paneFailure = null
  proc.deferPane = false
  proc.finishPane = null
  proc.calls = 0
  proc.tmuxArgs = []
})

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true })
})

describe('StatusWatcher blocked signal — override added', () => {
  it('looks up the exact tmux session so a prefixed hand cannot keep a missing parent live', async () => {
    const session = makeSession('s0', 'idle')
    await internals(watcher).checkProcessTree(session)

    expect(proc.tmuxArgs).toEqual(['list-panes', '-t', '=tinstar-s0:', '-F', '#{pane_pid}'])
  })

  it('treats a timed-out pane probe as inconclusive instead of stopping a live session', async () => {
    const session = makeSession('slow-pane', 'running')
    proc.paneTimeout = true

    await internals(watcher).checkProcessTree(session)

    expect(getSession(sessionsDir, session.name)?.state).toBe('running')
    expect(onStatusChanged).not.toHaveBeenCalled()
  })

  it.each(['permission', 'enoent'] as const)(
    'treats a %s pane probe failure as inconclusive',
    async (failure) => {
      const session = makeSession(`pane-${failure}`, 'running')
      proc.paneFailure = failure

      await internals(watcher).checkProcessTree(session)

      expect(getSession(sessionsDir, session.name)?.state).toBe('running')
      expect(onStatusChanged).not.toHaveBeenCalled()
    },
  )

  it('marks stopped only when tmux reports an ordinary missing target', async () => {
    const session = makeSession('pane-missing', 'running')
    proc.paneFailure = 'missing'

    await internals(watcher).checkProcessTree(session)

    expect(getSession(sessionsDir, session.name)?.state).toBe('stopped')
    expect(onStatusChanged).toHaveBeenCalledWith(
      session.name,
      'stopped',
      false,
    )
  })

  it('does not apply a delayed pane miss to a newer backend generation', async () => {
    const session = makeSession('pane-generation', 'running')
    let generation = 'generation-1'
    watcher = new StatusWatcher({
      sessionsDir,
      onStatusChanged,
      onRecapEntries,
      captureBackendGeneration: () => generation,
      isBackendGenerationCurrent: (_name, captured) =>
        captured === generation,
    })
    proc.deferPane = true

    const checking = internals(watcher).checkProcessTree(session)
    await vi.waitFor(() => expect(proc.finishPane).not.toBeNull())
    generation = 'generation-2'
    proc.finishPane!()
    await checking

    expect(getSession(sessionsDir, session.name)?.state).toBe('running')
    expect(onStatusChanged).not.toHaveBeenCalled()
  })

  it('warns once while backend ownership is unavailable for liveness', async () => {
    const session = makeSession('owner-unavailable', 'running')
    watcher = new StatusWatcher({
      sessionsDir,
      onStatusChanged,
      onRecapEntries,
      captureBackendGeneration: () => null,
    })
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)

    await internals(watcher).checkProcessTree(session)
    await internals(watcher).checkProcessTree(session)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'status-watcher',
      expect.stringContaining('backend ownership is unavailable'),
    )
    expect(proc.tmuxArgs).toEqual([])
    warn.mockRestore()
  })

  it('silent-failure path 1: block beginning while already idle notifies with blocked: true', async () => {
    const session = makeSession('s1', 'idle')
    const w = internals(watcher)
    await w.checkProcessTree(session) // streak 1 — debounce, nothing yet
    expect(onStatusChanged).not.toHaveBeenCalled()
    await w.checkProcessTree(session) // streak 2 — override added
    expect(onStatusChanged).toHaveBeenCalledWith('s1', 'idle', true)
  })

  it('silent-failure path 2: blocked is persisted to session.json at override add (restart-safe)', async () => {
    const session = makeSession('s2', 'idle')
    const w = internals(watcher)
    await w.checkProcessTree(session)
    await w.checkProcessTree(session)
    // The signal must live on disk, not only in watcher memory — a fresh
    // watcher (server restart) has an empty processTreeOverride set.
    expect(getSession(sessionsDir, 's2')!.blocked).toBe(true)
  })

  it('debounce preserved: a single no-children poll neither notifies nor persists', async () => {
    const session = makeSession('s3', 'idle')
    await internals(watcher).checkProcessTree(session)
    expect(onStatusChanged).not.toHaveBeenCalled()
    expect(getSession(sessionsDir, 's3')!.blocked).toBe(false)
  })

  it('treats an operational pgrep failure as inconclusive, not another no-child poll', async () => {
    const session = makeSession('pgrep-error', 'idle')
    const w = internals(watcher)
    await w.checkProcessTree(session)
    proc.childError = true
    await w.checkProcessTree(session)
    proc.childError = false
    await w.checkProcessTree(session)

    expect(onStatusChanged).not.toHaveBeenCalled()
    expect(getSession(sessionsDir, session.name)?.blocked).toBe(false)
  })

  it('block detected while running still transitions to idle, now carrying blocked: true', async () => {
    const session = makeSession('s4', 'running')
    const w = internals(watcher)
    await w.checkProcessTree(session)
    await w.checkProcessTree(session)
    expect(onStatusChanged).toHaveBeenCalledWith('s4', 'idle', true)
    const onDisk = getSession(sessionsDir, 's4')!
    expect(onDisk.state).toBe('idle')
    expect(onDisk.blocked).toBe(true)
  })

  it('parses recap entries when a cached transcript is blocked into idle', async () => {
    const session = makeSession('s4-recap', 'running')
    const transcriptPath = writeIdleTranscript()
    const recapEntries = [{
      id: 'blocked-recap',
      type: 'agent' as const,
      content: 'Finished before waiting for permission',
      timestamp: '2026-07-31T00:00:00.000Z',
    }]
    const transcript: ProviderTranscriptAdapter = {
      discover: async () => transcriptPath,
      readStatus: () => ({ state: 'running', toolPending: true }),
      parseRecapEntries: vi.fn(() => recapEntries),
      resetOffset: vi.fn(),
    }
    const w = internals(watcher)
    w.transcriptAdapters.set(session.name, transcript)
    w.transcriptPaths.set(session.name, transcriptPath)

    await w.checkProcessTree(session)
    await w.checkProcessTree(session)

    expect(onRecapEntries).toHaveBeenCalledWith(session.name, recapEntries)
  })
})

describe('StatusWatcher blocked signal — override removed', () => {
  it('silent-failure path 3: override clearing while status stays idle notifies with blocked: false', async () => {
    const session = makeSession('s5', 'idle', { blocked: true, conversation: { id: 'conv-s5' } })
    const w = internals(watcher)
    // A new watcher starts with no in-memory override. The persisted flag must
    // rehydrate before transcript evidence clears it.
    w.transcriptPaths.set('s5', writeIdleTranscript())

    await w.checkSession(session)

    expect(onStatusChanged).toHaveBeenCalledWith('s5', 'idle', false)
    expect(getSession(sessionsDir, 's5')!.blocked).toBe(false)
  })

  it('keeps polling a blocked transcript-less provider until children return', async () => {
    const session = makeSession('s5-generic', 'idle', {
      adapter: 'generic',
      blocked: true,
    })
    proc.hasChildren = true

    await internals(watcher).checkSession(session)

    expect(onStatusChanged).toHaveBeenCalledWith('s5-generic', 'running', false)
    expect(getSession(sessionsDir, 's5-generic')).toMatchObject({
      state: 'running',
      blocked: false,
    })
  })

  it('children returning while override is set notifies with blocked: false and persists', async () => {
    const session = makeSession('s6', 'idle', { blocked: true })
    const w = internals(watcher)
    w.processTreeOverride.add('s6')
    proc.hasChildren = true

    await w.checkProcessTree(session)

    expect(onStatusChanged).toHaveBeenCalledWith('s6', 'running', false)
    const onDisk = getSession(sessionsDir, 's6')!
    expect(onDisk.state).toBe('running')
    expect(onDisk.blocked).toBe(false)
  })

  it('skip-until-JSONL-changes preserved: pending tool_use with override set does nothing', async () => {
    const session = makeSession('s7', 'idle', { blocked: true, conversation: { id: 'conv-s7' } })
    const w = internals(watcher)
    w.processTreeOverride.add('s7')
    w.transcriptPaths.set('s7', writePendingTranscript())

    await w.checkSession(session)

    // Already determined blocked — no process-tree probe, no notify, no flip.
    expect(proc.calls).toBe(0)
    expect(onStatusChanged).not.toHaveBeenCalled()
    expect(getSession(sessionsDir, 's7')!.blocked).toBe(true)
  })
})

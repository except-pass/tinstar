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
import { StatusWatcher } from '../status-watcher'
import { createSession, getSession, updateSession, type Session, type SessionState } from '../session'

// checkProcessTree shells out to tmux/pgrep via execFile. Script the process
// tree per test: pane pid 100 → agent pid 200 → children controlled by
// `hasChildren`. Callbacks fire synchronously so the whole chain completes
// within the checkProcessTree call.
const proc = vi.hoisted(() => ({ hasChildren: false, calls: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      proc.calls++
      if (cmd === 'tmux') return cb(null, '100\n', '')
      if (cmd === 'pgrep' && args[1] === '100') return cb(null, '200\n', '')
      if (cmd === 'pgrep' && args[1] === '200') {
        return proc.hasChildren ? cb(null, '300\n', '') : cb(new Error('no children'), '', '')
      }
      return cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`), '', '')
    },
  }
})

let sessionsDir: string
let onStatusChanged: ReturnType<typeof vi.fn>
let watcher: StatusWatcher

// Test-seam accessor for the watcher's private internals.
function internals(w: StatusWatcher) {
  return w as unknown as {
    checkSession(session: Session): void
    checkProcessTree(session: Session): void
    processTreeOverride: Set<string>
    claudeTranscripts: Map<string, string>
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
  watcher = new StatusWatcher({ sessionsDir, onStatusChanged })
  proc.hasChildren = false
  proc.calls = 0
})

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true })
})

describe('StatusWatcher blocked signal — override added', () => {
  it('silent-failure path 1: block beginning while already idle notifies with blocked: true', () => {
    const session = makeSession('s1', 'idle')
    const w = internals(watcher)
    w.checkProcessTree(session) // streak 1 — debounce, nothing yet
    expect(onStatusChanged).not.toHaveBeenCalled()
    w.checkProcessTree(session) // streak 2 — override added
    expect(onStatusChanged).toHaveBeenCalledWith('s1', 'idle', true)
  })

  it('silent-failure path 2: blocked is persisted to session.json at override add (restart-safe)', () => {
    const session = makeSession('s2', 'idle')
    const w = internals(watcher)
    w.checkProcessTree(session)
    w.checkProcessTree(session)
    // The signal must live on disk, not only in watcher memory — a fresh
    // watcher (server restart) has an empty processTreeOverride set.
    expect(getSession(sessionsDir, 's2')!.blocked).toBe(true)
  })

  it('debounce preserved: a single no-children poll neither notifies nor persists', () => {
    const session = makeSession('s3', 'idle')
    internals(watcher).checkProcessTree(session)
    expect(onStatusChanged).not.toHaveBeenCalled()
    expect(getSession(sessionsDir, 's3')!.blocked).toBe(false)
  })

  it('block detected while running still transitions to idle, now carrying blocked: true', () => {
    const session = makeSession('s4', 'running')
    const w = internals(watcher)
    w.checkProcessTree(session)
    w.checkProcessTree(session)
    expect(onStatusChanged).toHaveBeenCalledWith('s4', 'idle', true)
    const onDisk = getSession(sessionsDir, 's4')!
    expect(onDisk.state).toBe('idle')
    expect(onDisk.blocked).toBe(true)
  })
})

describe('StatusWatcher blocked signal — override removed', () => {
  it('silent-failure path 3: override clearing while status stays idle notifies with blocked: false', () => {
    const session = makeSession('s5', 'idle', { blocked: true, conversation: { id: 'conv-s5' } })
    const w = internals(watcher)
    w.processTreeOverride.add('s5')
    // Session has no workspace.path — resolveClaudeTranscriptPath serves the
    // cached path, pointing at a transcript with no pending tool_use.
    w.claudeTranscripts.set('s5', writeIdleTranscript())

    w.checkSession(session)

    expect(onStatusChanged).toHaveBeenCalledWith('s5', 'idle', false)
    expect(getSession(sessionsDir, 's5')!.blocked).toBe(false)
  })

  it('children returning while override is set notifies with blocked: false and persists', () => {
    const session = makeSession('s6', 'idle', { blocked: true })
    const w = internals(watcher)
    w.processTreeOverride.add('s6')
    proc.hasChildren = true

    w.checkProcessTree(session)

    expect(onStatusChanged).toHaveBeenCalledWith('s6', 'running', false)
    const onDisk = getSession(sessionsDir, 's6')!
    expect(onDisk.state).toBe('running')
    expect(onDisk.blocked).toBe(false)
  })

  it('skip-until-JSONL-changes preserved: pending tool_use with override set does nothing', () => {
    const session = makeSession('s7', 'idle', { blocked: true, conversation: { id: 'conv-s7' } })
    const w = internals(watcher)
    w.processTreeOverride.add('s7')
    w.claudeTranscripts.set('s7', writePendingTranscript())

    w.checkSession(session)

    // Already determined blocked — no process-tree probe, no notify, no flip.
    expect(proc.calls).toBe(0)
    expect(onStatusChanged).not.toHaveBeenCalled()
    expect(getSession(sessionsDir, 's7')!.blocked).toBe(true)
  })
})

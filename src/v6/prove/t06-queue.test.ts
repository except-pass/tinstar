import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FmCommandRunner } from '../../server/v6/shell/fmExec'
import { submitIntent, type IntentSubmission } from '../../server/v6/shell/submitIntent'

const LIVE_ROOTS = [
  '/Users/wtg/repo/firstmate',
  '/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home',
]

const envelope = {
  schema: 'tinstar.v6.intent/1',
  kind: 'thread.message',
  requestId: 'req-t06',
  revision: null,
  anchor: { type: 'worker', ids: ['alpha'] },
  body: { text: 'hold this until the primary is back' },
}

interface Call {
  script: string
  args: string[]
  env: NodeJS.ProcessEnv
}

function livePath(path: string): boolean {
  return LIVE_ROOTS.some(root => path === root || path.startsWith(`${root}/`))
}

function layout(): { root: string; home: string; binDir: string; projectionFile: string; inbox: string } {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-t06-'))
  const home = join(root, 'fm-home')
  const binDir = join(root, 'bin')
  const inbox = join(home, 'state', 'inbox')
  mkdirSync(inbox, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(home, 'state', 'pane'), '%42\n')
  process.env.TINSTAR_CONFIG_HOME = join(root, 'config')
  return { root, home, binDir, inbox, projectionFile: join(root, 'config', 'v6', 'projection.json') }
}

function runnerFor(
  home: string,
  note: 'saved' | 'exit1' | 'exit3',
  ready: 'closed' | 'poisoned-down',
): { runner: FmCommandRunner; calls: Call[] } {
  const calls: Call[] = []
  const inbox = join(home, 'state', 'inbox')
  const runner: FmCommandRunner = {
    exec: async (script, args, env) => {
      calls.push({ script, args, env })
      const fmHome = env.FM_HOME ?? ''
      if (livePath(fmHome) || livePath(script)) throw new Error(`refusing live First Mate path ${fmHome} ${script}`)
      if (args[0] === 'ask' || args.includes('ask')) throw new Error('ask is not delivery')
      if (args[0] === 'note') {
        if (note === 'exit1') {
          return {
            code: 1,
            stdout: JSON.stringify({
              schema: 'fm-inbox-note.v1',
              saved: true,
              id: 'note-decoy',
              announced: true,
              applied: true,
              delivered: true,
              processing: true,
              pane: '%42',
            }),
            stderr: 'nothing saved',
          }
        }
        const requestId = args[args.indexOf('--request-id') + 1] ?? 'missing'
        const body = args[args.length - 1] ?? ''
        const id = `note-${requestId}`
        writeFileSync(join(inbox, `${id}.note`), body)
        const announced = note === 'saved'
        return {
          code: announced ? 0 : 3,
          stdout: JSON.stringify({
            schema: 'fm-inbox-note.v1',
            outcome: 'created',
            id,
            request_id: requestId,
            saved: true,
            announced,
            acknowledged: false,
            applied: true,
            delivered: true,
            processing: true,
            pane: '%42',
          }),
          stderr: '',
        }
      }
      if (args[0] === 'ready') {
        if (ready === 'poisoned-down') {
          return {
            code: 1,
            stdout: JSON.stringify({
              schema: 'fm-primary-ready.v1',
              can_receive: true,
              pane: '%42',
              session: 'worker-a',
              delivered: true,
              processing: true,
            }),
            stderr: 'primary down',
          }
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: 'fm-primary-ready.v1',
            can_receive: false,
            pane: '%42',
            session: 'worker-a',
            endpoint: { exists: true, target: 'sess:alpha' },
            applied: true,
            delivered: true,
            processing: true,
          }),
          stderr: '',
        }
      }
      throw new Error(`unexpected inbox subcommand ${args[0]}`)
    },
  }
  return { runner, calls }
}

function stored(file: string, requestId: string): { noteId?: string; disposition?: string } | undefined {
  if (!existsSync(file)) return undefined
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { intents?: Record<string, { noteId?: string; disposition?: string }> }
  return doc.intents?.[requestId]
}

function assertIsolated(home: string, binDir: string, calls: Call[]): void {
  expect(livePath(home)).toBe(false)
  expect(livePath(binDir)).toBe(false)
  for (const call of calls) {
    expect(call.env.FM_HOME).toBe(home)
    expect(call.env.TMUX).toBeUndefined()
    expect(call.script).toBe(join(binDir, 'fm-inbox.sh'))
    expect(call.args[0]).not.toBe('ask')
    expect(livePath(call.script)).toBe(false)
    expect(livePath(call.env.FM_HOME ?? '')).toBe(false)
  }
}

function assertHeldOrFailed(result: IntentSubmission, file: string, noteSaved: boolean): void {
  expect(result.applied).toBe(false)
  expect(result.canReceive).not.toBe(true)
  expect(result.detail.trim().length).toBeGreaterThan(0)
  expect(result.detail.toLowerCase()).not.toMatch(/delivered|processing/)
  if (!noteSaved) {
    expect(result.disposition).toBe('failed')
    expect(result.noteId).toBeNull()
    expect(stored(file, result.requestId)?.disposition).not.toBe('queued')
    return
  }
  // A saved note is the durable queue, or the call fails in the open.
  // not-receivable and saved-unannounced are neither.
  expect(['queued', 'failed']).toContain(result.disposition)
  if (result.disposition === 'failed') {
    expect(stored(file, result.requestId)).toMatchObject({ disposition: 'failed' })
    return
  }
  expect(result.noteId).toBeTruthy()
  expect(stored(file, result.requestId)).toMatchObject({
    noteId: result.noteId,
    disposition: 'queued',
  })
}

const roots: string[] = []
let previousConfig: string | undefined

afterEach(() => {
  if (previousConfig === undefined) delete process.env.TINSTAR_CONFIG_HOME
  else process.env.TINSTAR_CONFIG_HOME = previousConfig
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('T06 primary unavailable', () => {
  it('keeps a saved inbox note unapplied when ready reports a pane but cannot receive', async () => {
    previousConfig = process.env.TINSTAR_CONFIG_HOME
    const place = layout()
    roots.push(place.root)
    writeFileSync(join(place.inbox, 'already.note'), 'saved before this action')
    const { runner, calls } = runnerFor(place.home, 'saved', 'closed')
    const result = await submitIntent(envelope, {
      home: place.home,
      binDir: place.binDir,
      projectionFile: place.projectionFile,
      runner,
    })
    assertIsolated(place.home, place.binDir, calls)
    assertHeldOrFailed(result, place.projectionFile, true)
    expect(existsSync(join(place.inbox, 'note-req-t06.note'))).toBe(true)
    expect(readFileSync(join(place.inbox, 'note-req-t06.note'), 'utf8')).toContain('hold this until the primary is back')
    expect(existsSync(join(place.home, 'state', 'pane'))).toBe(true)
    expect(calls.map(call => call.args[0])).toEqual(['note', 'ready'])
  })

  it('does not trust can_receive from a failed ready payload that names a pane', async () => {
    previousConfig = process.env.TINSTAR_CONFIG_HOME
    const place = layout()
    roots.push(place.root)
    const { runner, calls } = runnerFor(place.home, 'saved', 'poisoned-down')
    const result = await submitIntent({ ...envelope, requestId: 'req-t06-down' }, {
      home: place.home,
      binDir: place.binDir,
      projectionFile: place.projectionFile,
      runner,
    })
    assertIsolated(place.home, place.binDir, calls)
    assertHeldOrFailed(result, place.projectionFile, true)
    expect(result.canReceive).toBe('unknown')
    expect(result.disposition).toBe('queued')
    expect(existsSync(join(place.inbox, 'note-req-t06-down.note'))).toBe(true)
  })

  it('fails explicitly when nothing is saved, even if a pane and an older inbox file exist', async () => {
    previousConfig = process.env.TINSTAR_CONFIG_HOME
    const place = layout()
    roots.push(place.root)
    writeFileSync(join(place.inbox, 'already.note'), 'an older note is not this action')
    const { runner, calls } = runnerFor(place.home, 'exit1', 'closed')
    const result = await submitIntent({ ...envelope, requestId: 'req-t06-exit1' }, {
      home: place.home,
      binDir: place.binDir,
      projectionFile: place.projectionFile,
      runner,
    })
    assertIsolated(place.home, place.binDir, calls)
    expect(result.disposition).toBe('failed')
    expect(result.applied).toBe(false)
    expect(result.noteId).toBeNull()
    expect(result.detail).toMatch(/nothing saved/)
    expect(calls.map(call => call.args[0])).toEqual(['note'])
    expect(existsSync(join(place.inbox, 'note-req-t06-exit1.note'))).toBe(false)
    expect(stored(place.projectionFile, 'req-t06-exit1')).toBeUndefined()
  })

  it('fails explicitly when the primary home is not configured', async () => {
    previousConfig = process.env.TINSTAR_CONFIG_HOME
    const place = layout()
    roots.push(place.root)
    const { runner, calls } = runnerFor(place.home, 'saved', 'closed')
    const result = await submitIntent(envelope, {
      home: '',
      binDir: '',
      projectionFile: place.projectionFile,
      runner,
    })
    expect(calls).toHaveLength(0)
    expect(result.disposition).toBe('failed')
    expect(result.applied).toBe(false)
    expect(result.detail).toMatch(/not configured/)
    expect(stored(place.projectionFile, envelope.requestId)).toBeUndefined()
  })

  it('keeps an unannounced save unapplied when the primary cannot receive', async () => {
    previousConfig = process.env.TINSTAR_CONFIG_HOME
    const place = layout()
    roots.push(place.root)
    const { runner, calls } = runnerFor(place.home, 'exit3', 'closed')
    const result = await submitIntent({ ...envelope, requestId: 'req-t06-exit3' }, {
      home: place.home,
      binDir: place.binDir,
      projectionFile: place.projectionFile,
      runner,
    })
    assertIsolated(place.home, place.binDir, calls)
    assertHeldOrFailed(result, place.projectionFile, true)
    expect(result.announced).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(existsSync(join(place.inbox, 'note-req-t06-exit3.note'))).toBe(true)
  })
})

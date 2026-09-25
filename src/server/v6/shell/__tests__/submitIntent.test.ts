import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fmChildEnv, type CommandResult, type FmCommandRunner } from '../fmExec'
import { readReceipts, submitIntent } from '../submitIntent'

const envelope = {
  schema: 'tinstar.v6.intent/1',
  kind: 'thread.message',
  requestId: 'req-1',
  revision: null,
  anchor: { type: 'worker', ids: ['alpha'] },
  body: { text: 'hello worker' },
}

function noteJson(opts: { outcome?: string; announced?: boolean; saved?: boolean; id?: string; code?: number }): CommandResult {
  return {
    code: opts.code ?? 0,
    stdout: JSON.stringify({
      schema: 'fm-inbox-note.v1',
      outcome: opts.outcome ?? 'created',
      id: opts.id ?? 'note-1',
      request_id: 'req-1',
      saved: opts.saved ?? true,
      announced: opts.announced ?? true,
      acknowledged: false,
    }),
    stderr: '',
  }
}

function readyJson(can: boolean | 'unknown', code = 0): CommandResult {
  return {
    code,
    stdout: JSON.stringify({ schema: 'fm-primary-ready.v1', can_receive: can }),
    stderr: code === 0 ? '' : 'down',
  }
}

function runnerOf(handler: (script: string, args: string[], env: NodeJS.ProcessEnv) => CommandResult): FmCommandRunner & { calls: Array<{ script: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ script: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  return {
    calls,
    exec: async (script, args, env) => {
      calls.push({ script, args, env })
      return handler(script, args, env)
    },
  }
}

function opts(runner: FmCommandRunner, file: string) {
  return { home: '/tmp/v6-fm-home', binDir: '/tmp/v6-bin', projectionFile: file, runner }
}

describe('submitIntent', () => {
  it('submits thread.message with note --request-id --json and stays unapplied', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'v6-intent-')), 'projection.json')
    const runner = runnerOf((script, args) => {
      expect(script.endsWith('/fm-inbox.sh')).toBe(true)
      if (args[0] === 'note') return noteJson({})
      if (args[0] === 'ready') return readyJson(true)
      throw new Error(`unexpected ${args[0]}`)
    })
    const result = await submitIntent(envelope, opts(runner, file))
    expect(result.disposition).toBe('queued')
    expect(result.applied).toBe(false)
    expect(result.noteId).toBe('note-1')
    const note = runner.calls[0]!
    expect(note.args.slice(0, 4)).toEqual(['note', '--request-id', 'req-1', '--json'])
    expect(note.args[4]).toBe('--')
    expect(JSON.parse(note.args[5]!)).toMatchObject({ kind: 'thread.message', requestId: 'req-1' })
    expect(runner.calls.map(call => call.args[0])).toEqual(['note', 'ready'])
    expect(note.env.FM_HOME).toBe('/tmp/v6-fm-home')
    expect(note.env.TMUX).toBeUndefined()
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { intents: Record<string, { noteId: string }> }
    expect(stored.intents['req-1']?.noteId).toBe('note-1')
  })

  it('does not call the inbox when the envelope is invalid or carries a command', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'v6-intent-')), 'projection.json')
    const runner = runnerOf(() => noteJson({}))
    const bad = await submitIntent({ ...envelope, kind: 'shell.run' }, opts(runner, file))
    expect(bad.disposition).toBe('failed')
    expect(bad.applied).toBe(false)
    const commanded = await submitIntent({ ...envelope, body: { text: 'x', command: 'rm' } }, opts(runner, file))
    expect(commanded.disposition).toBe('failed')
    expect(runner.calls).toHaveLength(0)
  })

  it('exit 3 is saved, not announced, and not applied', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'v6-intent-')), 'projection.json')
    const runner = runnerOf((_script, args) => args[0] === 'ready' ? readyJson(true) : noteJson({ code: 3, announced: false }))
    const result = await submitIntent(envelope, opts(runner, file))
    expect(result.disposition).toBe('saved-unannounced')
    expect(result.applied).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.detail).toMatch(/not announced/)
  })

  it('can_receive other than true stays queued and is not applied', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'v6-intent-')), 'projection.json')
    for (const can of [false, 'unknown'] as const) {
      const runner = runnerOf((_script, args) => args[0] === 'ready' ? readyJson(can) : noteJson({}))
      const result = await submitIntent({ ...envelope, requestId: `req-${can}` }, opts(runner, file))
      expect(result.disposition).toBe('queued')
      expect(result.applied).toBe(false)
      expect(result.canReceive).toBe(can)
    }
  })

  it('exit 1 saves nothing and does not ask', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'v6-intent-')), 'projection.json')
    const runner = runnerOf(() => ({ code: 1, stdout: '', stderr: 'nothing saved' }))
    const result = await submitIntent(envelope, opts(runner, file))
    expect(result.disposition).toBe('failed')
    expect(result.noteId).toBeNull()
    expect(result.applied).toBe(false)
    expect(runner.calls.map(call => call.args[0])).toEqual(['note'])
    expect(JSON.stringify(runner.calls)).not.toContain('ask')
  })

  it('replays the same request id onto the original note', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'v6-intent-')), 'projection.json')
    const runner = runnerOf((_script, args) => args[0] === 'ready' ? readyJson(true) : noteJson({ outcome: 'replay', id: 'note-original' }))
    const result = await submitIntent(envelope, opts(runner, file))
    expect(result.noteId).toBe('note-original')
    expect(result.noteOutcome).toBe('replay')
    expect(result.disposition).toBe('queued')
    expect(result.applied).toBe(false)
  })

  it('replaces an inherited FM_HOME', () => {
    const previous = process.env.FM_HOME
    process.env.FM_HOME = '/Users/wtg/repo/firstmate'
    try {
      const env = fmChildEnv('/tmp/isolated-home')
      expect(env.FM_HOME).toBe('/tmp/isolated-home')
    } finally {
      if (previous === undefined) delete process.env.FM_HOME
      else process.env.FM_HOME = previous
    }
  })
})

describe('readReceipts', () => {
  it('shows a prose reply without marking it applied', async () => {
    const runner = runnerOf(() => ({
      code: 0,
      stdout: JSON.stringify({
        schema: 'fm-inbox-receipts.v1',
        pending: [{
          id: 'note-1',
          request_id: 'req-1',
          announced: true,
          acknowledged: false,
          reply: { id: 'note-1', body: 'captain says hi', cursor: '000000000001' },
        }],
        handled: [],
        omitted: [],
      }),
      stderr: '',
    }))
    const { reply } = await readReceipts({ home: '/tmp/h', binDir: '/tmp/b', runner }, 'req-1')
    expect(reply?.body).toBe('captain says hi')
    expect(reply?.appliedOutcome).toBeNull()
    expect(runner.calls[0]!.args).toEqual(['receipts'])
  })

  it('honors omitted[] by asking for the full reply list', async () => {
    let calls = 0
    const runner = runnerOf((_script, args) => {
      calls += 1
      if (args.length === 1) {
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: 'fm-inbox-receipts.v1',
            pending: [],
            handled: [],
            omitted: [{ surface: 'replies', reveal: 'pass --all-replies' }],
          }),
          stderr: '',
        }
      }
      expect(args).toEqual(['receipts', '--all-pending', '--all-handled', '--all-replies'])
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: 'fm-inbox-receipts.v1',
          pending: [{
            id: 'note-9',
            request_id: 'req-9',
            announced: true,
            acknowledged: true,
            reply: {
              id: 'note-9',
              body: JSON.stringify({
                schema: 'tinstar.v6.receipt/1',
                requestId: 'req-9',
                outcome: 'applied',
                detail: 'landed',
              }),
              cursor: '000000000009',
            },
          }],
          handled: [],
          omitted: [],
        }),
        stderr: '',
      }
    })
    const { reply } = await readReceipts({ home: '/tmp/h', binDir: '/tmp/b', runner }, 'req-9')
    expect(calls).toBe(2)
    expect(reply?.appliedOutcome).toBe('applied')
    expect(reply?.receiptDetail).toBe('landed')
  })

  it('does not apply a receipt whose request id does not match the note', async () => {
    const runner = runnerOf(() => ({
      code: 0,
      stdout: JSON.stringify({
        schema: 'fm-inbox-receipts.v1',
        pending: [{
          id: 'note-1',
          request_id: 'req-1',
          announced: true,
          acknowledged: false,
          reply: {
            body: JSON.stringify({
              schema: 'tinstar.v6.receipt/1',
              requestId: 'someone-else',
              outcome: 'applied',
              detail: 'no',
            }),
            cursor: '000000000002',
          },
        }],
        handled: [],
        omitted: [],
      }),
      stderr: '',
    }))
    const { reply } = await readReceipts({ home: '/tmp/h', binDir: '/tmp/b', runner }, 'req-1')
    expect(reply?.appliedOutcome).toBeNull()
  })
})

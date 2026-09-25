import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult, FmCommandRunner } from '../../shell/fmExec'
import { registerThreadRoutes } from '../routes'

interface Captured {
  script: string
  args: string[]
}

interface NoteRecord {
  id: string
  body: string
}

function noteJson(opts: { outcome?: string; id: string; requestId: string }): CommandResult {
  return {
    code: 0,
    stdout: JSON.stringify({
      schema: 'fm-inbox-note.v1',
      outcome: opts.outcome ?? 'created',
      id: opts.id,
      request_id: opts.requestId,
      saved: true,
      announced: true,
      acknowledged: false,
    }),
    stderr: '',
  }
}

function readyJson(): CommandResult {
  return {
    code: 0,
    stdout: JSON.stringify({ schema: 'fm-primary-ready.v1', can_receive: true }),
    stderr: '',
  }
}

function fixtureRunner(): FmCommandRunner & { calls: Captured[]; notes: Map<string, NoteRecord>; replies: Map<string, { body: string; cursor: string; noteId?: string }> } {
  const calls: Captured[] = []
  const notes = new Map<string, NoteRecord>()
  const replies = new Map<string, { body: string; cursor: string; noteId?: string }>()
  let seq = 0
  const runner: FmCommandRunner & { calls: Captured[]; notes: Map<string, NoteRecord>; replies: Map<string, { body: string; cursor: string; noteId?: string }> } = {
    calls,
    notes,
    replies,
    exec: async (script, args) => {
      calls.push({ script, args })
      if (args[0] === 'note') {
        const requestId = args[2] ?? ''
        const body = args[5] ?? ''
        const existing = notes.get(requestId)
        if (existing) return noteJson({ outcome: 'replay', id: existing.id, requestId })
        const id = `note-${++seq}`
        notes.set(requestId, { id, body })
        return noteJson({ id, requestId })
      }
      if (args[0] === 'ready') return readyJson()
      if (args[0] === 'receipts') {
        const pending = [...notes.entries()].map(([requestId, note]) => {
          const reply = replies.get(note.id)
          const noteId = reply?.noteId ?? note.id
          return {
            id: noteId,
            request_id: requestId,
            body: note.body,
            announced: true,
            acknowledged: false,
            reply: reply
              ? { id: noteId, body: reply.body, cursor: reply.cursor }
              : null,
          }
        })
        return {
          code: 0,
          stdout: JSON.stringify({ schema: 'fm-inbox-receipts.v1', pending, handled: [], omitted: [] }),
          stderr: '',
        }
      }
      throw new Error(`fixture runner refused ${args[0]}`)
    },
  }
  return runner
}

async function listen(runner: FmCommandRunner, ids?: { thread?: string[]; request?: string[] }): Promise<{ base: string; close: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), 'ts-threads-fixture-'))
  const server = createServer()
  let threadSeq = 0
  let requestSeq = 0
  registerThreadRoutes(server, {
    storeFile: join(root, 'threads.json'),
    projectionFile: join(root, 'projection.json'),
    home: join(root, 'fm-home'),
    binDir: join(root, 'bin'),
    runner,
    now: () => '2026-09-25T06:00:00.000Z',
    newThreadId: () => ids?.thread?.[threadSeq++] ?? `thr-fixture-${threadSeq++}`,
    newRequestId: () => ids?.request?.[requestSeq++] ?? `req-fixture-${requestSeq++}`,
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listener has no port')
  if (address.port === 5280 || address.port === 5281) throw new Error('refusing the user server ports')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise(resolve => server.close(() => resolve()))
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: { ok: boolean; data?: { thread: ThreadPayload | null }; error?: { message: string } } }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() as { ok: boolean; data?: { thread: ThreadPayload | null }; error?: { message: string } } }
}

interface ThreadPayload {
  id: string
  fixture: boolean
  anchor: { type: string; ids: string[]; textSelection: { text: string; field?: string } | null; labels: string[]; revision: string | null }
  display: { status: string; changedLine: string | null; position: { columnId: string | null; index: number | null } | null }
  messages: Array<{ role: string; text: string; disposition: string; noteId: string | null; requestId: string | null; previousNoteId: string | null; pending: boolean }>
}

function envelopeFrom(runner: { calls: Captured[] }, nth = 0): Record<string, unknown> {
  const notes = runner.calls.filter(call => call.args[0] === 'note')
  return JSON.parse(notes[nth]?.args[5] ?? '{}') as Record<string, unknown>
}

describe('registerThreadRoutes fixture transport', () => {
  it('T16 stores an epic card, a selection, a plan, and a plan task as thread.message', async () => {
    const runner = fixtureRunner()
    const server = await listen(runner)
    try {
      const card = await post(server.base, '/api/v6/threads', {
        text: 'talk about this card',
        fixture: true,
        portfolio: { epics: [{ id: 'everything', body: 'x'.repeat(5000) }] },
        anchor: {
          type: 'epic',
          ids: ['epic-alpha'],
          labels: ['Alpha'],
          revision: 'rev-card',
          textSelection: { text: 'the title words', field: 'title' },
        },
      })
      expect(card.json.ok).toBe(true)
      expect(card.json.data?.thread?.anchor.ids).toEqual(['epic-alpha'])
      expect(card.json.data?.thread?.anchor.textSelection).toEqual({ text: 'the title words', field: 'title' })
      expect(card.json.data?.thread?.fixture).toBe(true)
      const cardNote = envelopeFrom(runner, 0)
      expect(cardNote).toMatchObject({
        schema: 'tinstar.v6.intent/1',
        kind: 'thread.message',
        revision: 'rev-card',
        anchor: { type: 'epic', ids: ['epic-alpha'] },
      })
      expect(cardNote.portfolio).toBeUndefined()
      expect(JSON.stringify(cardNote)).not.toContain('everything')
      const cardBody = cardNote.body as Record<string, unknown>
      expect(cardBody.labels).toEqual(['Alpha'])
      expect(cardBody.textSelection).toEqual({ text: 'the title words', field: 'title' })
      expect(cardBody.fixture).toBe(true)
      expect(cardBody.recipient).toBe('firstmate')
      expect(cardBody.previousNoteId).toBeNull()
      expect(cardBody).not.toHaveProperty('portfolio')

      const selection = await post(server.base, '/api/v6/threads', {
        text: 'these three',
        fixture: true,
        anchor: { type: 'selection', ids: ['epic-b', 'epic-a', 'epic-c'] },
      })
      expect(selection.json.data?.thread?.anchor).toMatchObject({ type: 'selection', ids: ['epic-b', 'epic-a', 'epic-c'] })
      expect(envelopeFrom(runner, 1).anchor).toEqual({ type: 'selection', ids: ['epic-b', 'epic-a', 'epic-c'] })

      const plan = await post(server.base, '/api/v6/threads', {
        text: 'the whole plan',
        fixture: true,
        anchor: { type: 'plan', ids: ['stretch-west'] },
      })
      expect(plan.json.data?.thread?.anchor.type).toBe('plan')
      expect(envelopeFrom(runner, 2).anchor).toEqual({ type: 'plan', ids: ['stretch-west'] })

      const task = await post(server.base, '/api/v6/threads', {
        text: 'this plan task',
        fixture: true,
        anchor: { type: 'task', ids: ['task-9'] },
      })
      expect(task.json.data?.thread?.anchor).toMatchObject({ type: 'task', ids: ['task-9'] })
      expect(envelopeFrom(runner, 3).anchor).toEqual({ type: 'task', ids: ['task-9'] })

      const subcommands = runner.calls.map(call => call.args[0])
      expect(subcommands.every(name => name === 'note' || name === 'ready')).toBe(true)
      expect(JSON.stringify(runner.calls)).not.toContain('fm-send')
      expect(JSON.stringify(runner.calls)).not.toContain('send-keys')
      expect(runner.calls.some(call => call.args.includes('ask'))).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('T17 shows queued until the reply note id matches, then a second turn, and a replay adds nothing', async () => {
    const runner = fixtureRunner()
    const server = await listen(runner, { thread: ['thr-same'], request: ['req-turn-1', 'req-turn-2'] })
    try {
      const first = await post(server.base, '/api/v6/threads', {
        text: 'first turn',
        fixture: true,
        anchor: { type: 'epic', ids: ['epic-alpha'] },
      })
      const thread = first.json.data?.thread
      expect(thread?.id).toBe('thr-same')
      expect(thread?.messages).toEqual([
        expect.objectContaining({ role: 'user', text: 'first turn', disposition: 'queued', noteId: 'note-1', requestId: 'req-turn-1', pending: true }),
      ])

      const early = await post(server.base, `/api/v6/threads/${thread!.id}/receipts`, {})
      expect(early.json.data?.thread?.messages).toHaveLength(1)
      expect(early.json.data?.thread?.messages[0]?.disposition).toBe('queued')

      runner.replies.set('note-1', { body: 'captain says hi', cursor: '000000000001', noteId: 'other-note' })
      const mismatched = await post(server.base, `/api/v6/threads/${thread!.id}/receipts`, {})
      expect(mismatched.json.data?.thread?.messages).toHaveLength(1)

      runner.replies.set('note-1', { body: 'captain says hi', cursor: '000000000001' })
      const answered = await post(server.base, `/api/v6/threads/${thread!.id}/receipts`, {})
      expect(answered.json.data?.thread?.messages.map(message => [message.role, message.text, message.noteId])).toEqual([
        ['user', 'first turn', 'note-1'],
        ['firstmate', 'captain says hi', 'note-1'],
      ])
      expect(answered.json.data?.thread?.messages[0]?.pending).toBe(false)

      const second = await post(server.base, '/api/v6/threads', {
        threadId: 'thr-same',
        text: 'second turn',
        fixture: true,
        anchor: { type: 'epic', ids: ['epic-alpha'] },
      })
      const secondNote = envelopeFrom(runner, 1)
      expect(secondNote.requestId).toBe('req-turn-2')
      expect((secondNote.body as { threadId: string; previousNoteId: string }).threadId).toBe('thr-same')
      expect((secondNote.body as { previousNoteId: string }).previousNoteId).toBe('note-1')
      expect(second.json.data?.thread?.id).toBe('thr-same')
      expect(second.json.data?.thread?.messages.filter(message => message.role === 'user')).toHaveLength(2)

      runner.replies.set('note-2', { body: 'second reply', cursor: '000000000002' })
      const both = await post(server.base, '/api/v6/threads/thr-same/receipts', {})
      expect(both.json.data?.thread?.messages.map(message => message.text)).toEqual([
        'first turn',
        'captain says hi',
        'second turn',
        'second reply',
      ])

      const replay = await post(server.base, '/api/v6/threads', {
        threadId: 'thr-same',
        requestId: 'req-turn-1',
        text: 'this replay must not become a turn',
        fixture: true,
        anchor: { type: 'epic', ids: ['epic-replaced'] },
      })
      expect(replay.json.data?.thread?.anchor.ids).toEqual(['epic-alpha'])
      expect(replay.json.data?.thread?.messages.map(message => message.text)).toEqual([
        'first turn',
        'captain says hi',
        'second turn',
        'second reply',
      ])
      expect(runner.notes.size).toBe(2)
      const replayed = runner.calls.filter(call => call.args[0] === 'note' && call.args[2] === 'req-turn-1')
      expect(replayed).toHaveLength(2)
      expect(JSON.parse(replayed[1]?.args[5] ?? '{}')).toMatchObject({ requestId: 'req-turn-1' })
    } finally {
      await server.close()
    }
  })

  it('keeps the thread when the anchor moves and shows changed ids when it is archived', async () => {
    const runner = fixtureRunner()
    const server = await listen(runner)
    try {
      const created = await post(server.base, '/api/v6/threads', {
        text: 'stay with the card',
        fixture: true,
        anchor: { type: 'epic', ids: ['epic-alpha'] },
      })
      const id = created.json.data?.thread?.id
      expect(id).toBeTruthy()

      const moved = await post(server.base, `/api/v6/threads/${id}/presence`, {
        archived: false,
        occupantIds: ['epic-alpha'],
        position: { columnId: 'col-b', index: 3 },
      })
      expect(moved.json.data?.thread?.id).toBe(id)
      expect(moved.json.data?.thread?.anchor.ids).toEqual(['epic-alpha'])
      expect(moved.json.data?.thread?.display.status).toBe('current')
      expect(moved.json.data?.thread?.display.changedLine).toBeNull()
      expect(moved.json.data?.thread?.display.position).toEqual({ columnId: 'col-b', index: 3 })
      expect(moved.json.data?.thread?.messages[0]?.text).toBe('stay with the card')

      const archived = await post(server.base, `/api/v6/threads/${id}/presence`, {
        archived: true,
        occupantIds: ['usurper'],
        position: { columnId: 'col-b', index: 3 },
      })
      expect(archived.json.data?.thread?.anchor.ids).toEqual(['epic-alpha'])
      expect(archived.json.data?.thread?.display.changedLine).toBe('changed — epic-alpha')
      expect(JSON.stringify(archived.json.data?.thread?.anchor)).not.toContain('usurper')

      const still = await fetch(`${server.base}/api/v6/threads?type=epic&ids=epic-alpha`)
      const stillJson = await still.json() as { data: { thread: ThreadPayload } }
      expect(stillJson.data.thread.id).toBe(id)
      expect(stillJson.data.thread.display.changedLine).toBe('changed — epic-alpha')

      const occupant = await fetch(`${server.base}/api/v6/threads?type=epic&ids=usurper`)
      const occupantJson = await occupant.json() as { data: { thread: ThreadPayload | null } }
      expect(occupantJson.data.thread).toBeNull()
    } finally {
      await server.close()
    }
  })

  it('refuses a command field before any inbox call', async () => {
    const runner = fixtureRunner()
    const server = await listen(runner)
    try {
      const refused = await post(server.base, '/api/v6/threads', {
        text: 'hello',
        command: 'rm',
        anchor: { type: 'epic', ids: ['epic-alpha'] },
      })
      expect(refused.status).toBe(403)
      expect(runner.calls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })
})

describe('thread production sources', () => {
  it('does not call fm-send, ask, or send-keys', () => {
    const roots = [
      join(process.cwd(), 'src/v6/threads'),
      join(process.cwd(), 'src/server/v6/threads'),
    ]
    const files: string[] = []
    for (const root of roots) {
      for (const name of readdirSync(root)) {
        if (name === '__tests__' || name.endsWith('.md')) continue
        files.push(readFileSync(join(root, name), 'utf8'))
      }
    }
    const source = files.join('\n')
    for (const banned of ['fm-send', 'fm-spawn', 'fm-control', 'fm-teardown', 'send-keys', 'child_process', 'fm-inbox.sh', "'ask'", '"ask"']) {
      expect(source, banned).not.toContain(banned)
    }
    expect(source).toContain('submitIntent')
    expect(source).toContain('export function ContextThread')
    expect(source).toContain('export function registerThreadRoutes')
  })
})

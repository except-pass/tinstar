import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fmChildEnv } from '../../shell/fmExec'
import { registerThreadRoutes } from '../routes'

/**
 * The real inbox script, or a skip reason. Never falls back to a live home
 * and never substitutes a mock.
 */
function resolveInboxScript(): { ok: true; script: string } | { ok: false; reason: string } {
  const raw = process.env.FM_V6_BIN?.trim()
  if (!raw) {
    return {
      ok: false,
      reason: 'FM_V6_BIN is unset, so fm-inbox.sh is not on this machine. Refusing to mock or use a live First Mate home.',
    }
  }
  const script = raw.endsWith('.sh') ? raw : join(raw, 'fm-inbox.sh')
  if (!existsSync(script)) {
    return {
      ok: false,
      reason: `fm-inbox.sh is not at ${script}. Refusing to mock or use a live First Mate home.`,
    }
  }
  return { ok: true, script }
}

const resolvedInbox = resolveInboxScript()

function assertTempHome(home: string): void {
  const forbidden = [
    '/Users/wtg/repo/firstmate',
    '/Users/wtg/repo/tinstar',
    '/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home',
  ]
  for (const root of forbidden) {
    if (home === root || home.startsWith(`${root}/`)) throw new Error(`refusing to write ${root}`)
  }
  if (!home.startsWith(`${tmpdir()}/`)) throw new Error('FM_HOME must be a temp directory')
}

function noteBodies(home: string): unknown[] {
  const dir = join(home, 'state', 'inbox')
  return readdirSync(dir)
    .filter(name => name.endsWith('.note'))
    .map(name => {
      const text = readFileSync(join(dir, name), 'utf8')
      const marker = text.indexOf('\n--\n')
      if (marker < 0) throw new Error(`note ${name} has no body`)
      return JSON.parse(text.slice(marker + 4)) as unknown
    })
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(script, args, { env, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : null
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

interface ThreadPayload {
  id: string
  anchor: { ids: string[] }
  messages: Array<{ role: string; text: string; disposition: string; noteId: string | null; requestId: string | null; previousNoteId: string | null; pending: boolean }>
}

async function post(base: string, path: string, body: unknown): Promise<ThreadPayload> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await response.json() as { ok: boolean; data?: { thread: ThreadPayload }; error?: { message: string } }
  if (!json.ok || !json.data?.thread) throw new Error(json.error?.message ?? `POST ${path} failed`)
  return json.data.thread
}

describe('threads against the real fm-inbox.sh', () => {
  it.skipIf(!resolvedInbox.ok)(
    resolvedInbox.ok
      ? 'correlates two turns on one thread id and ignores a replay of the first request id'
      : `skipped: ${resolvedInbox.reason}`,
    async () => {
    if (!resolvedInbox.ok) return
    const script = resolvedInbox.script
    const home = mkdtempSync(join(tmpdir(), 'ts-threads-fm-'))
    const config = mkdtempSync(join(tmpdir(), 'ts-threads-cfg-'))
    assertTempHome(home)
    const server: Server = createServer()
    try {
      registerThreadRoutes(server, {
        storeFile: join(config, 'threads.json'),
        projectionFile: join(config, 'projection.json'),
        home,
        binDir: dirname(script),
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('listener has no port')
      expect(address.port).not.toBe(5280)
      expect(address.port).not.toBe(5281)
      const base = `http://127.0.0.1:${address.port}`

      const first = await post(base, '/api/v6/threads', {
        text: 'turn one about the card',
        anchor: { type: 'epic', ids: ['epic-live'], labels: ['Live card'] },
      })
      expect(first.messages).toHaveLength(1)
      expect(first.messages[0]?.disposition).toBe('not-receivable')
      expect(first.messages[0]?.pending).toBe(true)
      const firstNote = first.messages[0]?.noteId
      const firstRequest = first.messages[0]?.requestId
      expect(firstNote).toBeTruthy()
      expect(firstRequest).toBeTruthy()

      const saved = noteBodies(home)
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({
        schema: 'tinstar.v6.intent/1',
        kind: 'thread.message',
        requestId: firstRequest,
        anchor: { type: 'epic', ids: ['epic-live'] },
        body: {
          threadId: first.id,
          text: 'turn one about the card',
          previousNoteId: null,
          recipient: 'firstmate',
          labels: ['Live card'],
        },
      })
      expect(JSON.stringify(saved[0])).not.toContain('portfolio')

      const reply = await run(script, ['reply', '--json', firstNote!, 'reply to turn one'], fmChildEnv(home))
      expect(reply.code).toBe(0)

      const withReply = await post(base, `/api/v6/threads/${first.id}/receipts`, {})
      expect(withReply.messages.map(message => [message.role, message.text, message.noteId])).toEqual([
        ['user', 'turn one about the card', firstNote],
        ['firstmate', 'reply to turn one', firstNote],
      ])

      const second = await post(base, '/api/v6/threads', {
        threadId: first.id,
        text: 'turn two, same thread',
        anchor: { type: 'epic', ids: ['epic-live'] },
      })
      const secondUser = second.messages.filter(message => message.role === 'user')
      expect(second.id).toBe(first.id)
      expect(secondUser).toHaveLength(2)
      expect(secondUser[1]?.requestId).not.toBe(firstRequest)
      expect(secondUser[1]?.previousNoteId).toBe(firstNote)
      expect(secondUser[1]?.noteId).toBeTruthy()
      expect(secondUser[1]?.noteId).not.toBe(firstNote)

      const bodies = noteBodies(home) as Array<{ requestId: string; body: { previousNoteId: string | null; threadId: string } }>
      expect(bodies).toHaveLength(2)
      const secondBody = bodies.find(item => item.requestId === secondUser[1]?.requestId)
      expect(secondBody?.body.threadId).toBe(first.id)
      expect(secondBody?.body.previousNoteId).toBe(firstNote)

      const secondReply = await run(script, ['reply', '--json', secondUser[1]!.noteId!, 'reply to turn two'], fmChildEnv(home))
      expect(secondReply.code).toBe(0)
      const both = await post(base, `/api/v6/threads/${first.id}/receipts`, {})
      expect(both.messages.map(message => message.text)).toEqual([
        'turn one about the card',
        'reply to turn one',
        'turn two, same thread',
        'reply to turn two',
      ])

      const replay = await post(base, '/api/v6/threads', {
        threadId: first.id,
        requestId: firstRequest,
        text: 'replay must not add a turn',
        anchor: { type: 'epic', ids: ['someone-else'] },
      })
      expect(replay.anchor.ids).toEqual(['epic-live'])
      expect(replay.messages.filter(message => message.role === 'user')).toHaveLength(2)
      expect(noteBodies(home)).toHaveLength(2)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(home, { recursive: true, force: true })
      rmSync(config, { recursive: true, force: true })
    }
  })
})

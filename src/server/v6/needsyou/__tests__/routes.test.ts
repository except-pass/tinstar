import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionFixture, driftFixture, failureFixture } from '../../../../v6/needsyou/fixtures'
import { readAttention } from '../store'
import { registerNeedsYouRoutes, type SubmitIntent } from '../routes'

const AT = '2026-09-25T03:00:00.000Z'

function queuedReply(requestId: string) {
  return {
    requestId,
    noteId: 'note-1',
    disposition: 'queued' as const,
    applied: false as const,
    detail: 'queued',
  }
}

describe('registerNeedsYouRoutes', () => {
  const servers: Server[] = []
  const dirs: string[] = []
  let dir: string
  let base: string
  let submit: ReturnType<typeof vi.fn<SubmitIntent>>

  async function listen(opts?: { dir?: string; inbox?: { home: string; binDir: string } }) {
    dir = opts?.dir ?? mkdtempSync(join(tmpdir(), 'needsyou-store-'))
    dirs.push(dir)
    submit = vi.fn<SubmitIntent>(async raw => {
      const requestId = raw && typeof raw === 'object' && 'requestId' in raw && typeof raw.requestId === 'string'
        ? raw.requestId
        : 'req'
      return queuedReply(requestId)
    })
    const handle = registerNeedsYouRoutes({
      dir: opts && !('dir' in opts) ? undefined : dir,
      submitIntent: submit,
      inbox: opts?.inbox,
      now: () => AT,
    })
    const server = createServer((req, res) => {
      void handle(req, res).then(handled => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404
          res.end()
        }
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    expect(address.port).not.toBe(5280)
    expect(address.port).not.toBe(5281)
    base = `http://127.0.0.1:${address.port}`
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  async function post(path: string, body: unknown, headers?: Record<string, string>) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('keeps an open item and its answer across a reload, and updates the same id in place', async () => {
    await listen()
    const created = await post('/api/v6/needsyou/items', decisionFixture())
    expect(created.status).toBe(200)
    const opened = readAttention(dir)
    expect(opened.items).toHaveLength(1)
    expect(opened.items[0]?.item.state).toBe('open')
    expect(opened.items[0]?.item.provenance.workerId).toBe('worker-alpha')
    expect(opened.items[0]?.fixture).toBe(true)

    const renamed = await post('/api/v6/needsyou/items', decisionFixture({ headline: 'Keep one queue, still' }))
    expect(renamed.status).toBe(200)
    expect(readAttention(dir).items).toHaveLength(1)
    expect(readAttention(dir).items[0]?.item.headline).toBe('Keep one queue, still')

    const other = await post('/api/v6/needsyou/items', failureFixture())
    expect(other.status).toBe(200)
    expect(readAttention(dir).items).toHaveLength(2)

    const answer = await post('/api/v6/needsyou/ny-decision/answer', {
      revision: 'rev-decision',
      requestId: 'req-keep',
      kind: 'attention.answer',
      body: { optionId: 'keep', comment: 'ship the one queue' },
    })
    expect(answer.status).toBe(200)
    const answered = await answer.json() as { data: { delivery: string; applied: boolean; item: { state: string } } }
    expect(answered.data.delivery).toBe('queued')
    expect(answered.data.applied).toBe(false)
    expect(answered.data.item.state).toBe('answered')
    expect(submit).toHaveBeenCalledTimes(1)
    const envelope = submit.mock.calls[0]?.[0] as { kind: string; revision: string; anchor: { type: string; ids: string[] }; body: Record<string, unknown> }
    expect(envelope.kind).toBe('attention.answer')
    expect(envelope.revision).toBe('rev-decision')
    expect(envelope.anchor).toEqual({ type: 'needsyou', ids: ['ny-decision'] })
    expect(envelope.body).toEqual({ optionId: 'keep', comment: 'ship the one queue' })

    const reloaded = readAttention(dir)
    const row = reloaded.items.find(item => item.item.id === 'ny-decision')
    expect(row?.item.state).toBe('answered')
    expect(row?.item.state).not.toBe('resolved')
    expect(row?.delivery).toBe('queued')
    expect(row?.item.response?.body).toEqual({ optionId: 'keep', comment: 'ship the one queue' })
    expect(row?.item.provenance.workerId).toBe('worker-alpha')
    expect(reloaded.items).toHaveLength(2)
  })

  it('rejects a stale revision before submitIntent and leaves the file unchanged', async () => {
    await listen()
    await post('/api/v6/needsyou/items', decisionFixture())
    const file = join(dir, 'items.json')
    const before = readFileSync(file, 'utf8')
    const stale = await post('/api/v6/needsyou/ny-decision/answer', {
      revision: 'rev-old',
      requestId: 'req-stale',
      kind: 'attention.answer',
      body: { optionId: 'keep' },
    })
    expect(stale.status).toBe(409)
    const body = await stale.json() as { ok: boolean; error: { message: string; details: { applied: boolean } } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toMatch(/revision mismatch/)
    expect(body.error.details.applied).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(submit).not.toHaveBeenCalled()
    expect(readAttention(dir).items[0]?.item.state).toBe('open')
    expect(readAttention(dir).items[0]?.item.response).toBeNull()
  })

  it('does not write a First Mate home and does not store an undeclared choice', async () => {
    await listen()
    const fmHome = join(dir, 'fm-home')
    mkdirSync(fmHome)
    await post('/api/v6/needsyou/items', decisionFixture())
    const bad = await post('/api/v6/needsyou/ny-decision/answer', {
      revision: 'rev-decision',
      requestId: 'req-bad-choice',
      kind: 'attention.answer',
      body: { optionId: 'not-offered' },
    })
    expect(bad.status).toBe(400)
    expect(submit).not.toHaveBeenCalled()
    expect(readAttention(dir).items[0]?.item.response).toBeNull()
    expect(readdirSync(fmHome)).toEqual([])

    const commanded = await post('/api/v6/needsyou/ny-decision/answer', {
      revision: 'rev-decision',
      requestId: 'req-command',
      kind: 'attention.answer',
      body: { optionId: 'keep', command: 'rm -rf /' },
    })
    expect(commanded.status).toBe(400)
    expect(submit).not.toHaveBeenCalled()
    expect(readdirSync(fmHome)).toEqual([])
  })

  it('applies one receipt and ignores a second', async () => {
    await listen()
    await post('/api/v6/needsyou/items', decisionFixture())
    await post('/api/v6/needsyou/ny-decision/answer', {
      revision: 'rev-decision',
      requestId: 'req-once',
      kind: 'attention.answer',
      body: { optionId: 'split' },
    })
    const first = await post('/api/v6/needsyou/receipts', {
      schema: 'tinstar.v6.receipt/1',
      requestId: 'req-once',
      outcome: 'applied',
      detail: 'landed',
    })
    expect(first.status).toBe(200)
    const applied = await first.json() as { data: { changed: boolean; applied: boolean; item: { delivery: string; item: { state: string }; receiptDetail: string } } }
    expect(applied.data.changed).toBe(true)
    expect(applied.data.applied).toBe(true)
    expect(applied.data.item.delivery).toBe('applied')
    expect(applied.data.item.item.state).toBe('answered')
    expect(applied.data.item.receiptDetail).toBe('landed')

    const second = await post('/api/v6/needsyou/receipts', {
      schema: 'tinstar.v6.receipt/1',
      requestId: 'req-once',
      outcome: 'rejected',
      detail: 'too late',
    })
    const again = await second.json() as { data: { changed: boolean; item: { delivery: string; item: { state: string }; receiptDetail: string } } }
    expect(again.data.changed).toBe(false)
    expect(again.data.item.delivery).toBe('applied')
    expect(again.data.item.item.state).toBe('answered')
    expect(again.data.item.receiptDetail).toBe('landed')
    expect(readAttention(dir).items[0]?.item.state).not.toBe('resolved')
  })

  it('drops an unapplied answer when a new revision is observed', async () => {
    await listen()
    await post('/api/v6/needsyou/items', decisionFixture())
    await post('/api/v6/needsyou/ny-decision/answer', {
      revision: 'rev-decision',
      requestId: 'req-old',
      kind: 'attention.answer',
      body: { optionId: 'keep' },
    })
    await post('/api/v6/needsyou/items', decisionFixture({ revision: 'rev-decision-2', headline: 'Changed call' }))
    const rows = readAttention(dir).items
    expect(rows).toHaveLength(1)
    expect(rows[0]?.item.revision).toBe('rev-decision-2')
    expect(rows[0]?.item.headline).toBe('Changed call')
    expect(rows[0]?.item.state).toBe('open')
    expect(rows[0]?.item.response).toBeNull()
    expect(rows[0]?.delivery).toBe('unanswered')

    const late = await post('/api/v6/needsyou/receipts', {
      schema: 'tinstar.v6.receipt/1',
      requestId: 'req-old',
      outcome: 'applied',
      detail: 'stale receipt',
    })
    const lateBody = await late.json() as { data: { changed: boolean } }
    expect(lateBody.data.changed).toBe(false)
    expect(readAttention(dir).items[0]?.delivery).not.toBe('applied')
  })

  it('acknowledges schedule drift without rewriting plannedMs', async () => {
    await listen()
    await post('/api/v6/needsyou/items', driftFixture())
    const ack = await post('/api/v6/needsyou/ny-drift/answer', {
      revision: 'rev-drift',
      requestId: 'req-ack',
      kind: 'schedule.acknowledge',
      body: { acknowledge: true, plannedMs: 1, elapsedMs: 1 },
    })
    expect(ack.status).toBe(200)
    const row = readAttention(dir).items[0]
    const payload = row?.item.payload as { plannedMs: number; elapsedMs: number; continues: boolean }
    expect(payload.plannedMs).toBe(7_200_000)
    expect(payload.elapsedMs).toBe(11_000_000)
    expect(payload.continues).toBe(true)
    expect(row?.item.state).toBe('open')
    expect(row?.acknowledgement?.delivery).toBe('queued')
    const envelope = submit.mock.calls[0]?.[0] as { kind: string; body: Record<string, unknown> }
    expect(envelope.kind).toBe('schedule.acknowledge')
    expect(envelope.body).toEqual({ acknowledge: true })
  })

  it('stores a failure retry as attention.answer and leaves the worker alone', async () => {
    await listen()
    await post('/api/v6/needsyou/items', failureFixture())
    const retry = await post('/api/v6/needsyou/ny-failure/answer', {
      revision: 'rev-failure',
      requestId: 'req-retry',
      kind: 'attention.answer',
      body: { action: 'retry', command: 'kill' },
    })
    expect(retry.status).toBe(400)
    expect(submit).not.toHaveBeenCalled()

    const clean = await post('/api/v6/needsyou/ny-failure/answer', {
      revision: 'rev-failure',
      requestId: 'req-retry',
      kind: 'attention.answer',
      body: { action: 'retry' },
    })
    expect(clean.status).toBe(200)
    const envelope = submit.mock.calls[0]?.[0] as { kind: string; body: Record<string, unknown> }
    expect(envelope.kind).toBe('attention.answer')
    expect(envelope.body.action).toBe('retry')
    expect(envelope.body.command).toBeUndefined()
    expect(readAttention(dir).items[0]?.item.state).toBe('answered')
    expect(readAttention(dir).items[0]?.delivery).toBe('queued')
  })

  it('keeps unanswered, queued, and resolved as different stored states', async () => {
    await listen()
    await post('/api/v6/needsyou/items', decisionFixture({ id: 'ny-open' }))
    await post('/api/v6/needsyou/items', decisionFixture({ id: 'ny-will-queue' }))
    await post('/api/v6/needsyou/ny-will-queue/answer', {
      revision: 'rev-decision',
      requestId: 'req-q',
      kind: 'attention.answer',
      body: { optionId: 'defer' },
    })
    await post('/api/v6/needsyou/items', decisionFixture({ id: 'ny-done', state: 'resolved' }))
    const items = readAttention(dir).items
    const open = items.find(row => row.item.id === 'ny-open')
    const queuedRow = items.find(row => row.item.id === 'ny-will-queue')
    const resolved = items.find(row => row.item.id === 'ny-done')
    expect(open?.item.state).toBe('open')
    expect(open?.delivery).toBe('unanswered')
    expect(queuedRow?.item.state).toBe('answered')
    expect(queuedRow?.delivery).toBe('queued')
    expect(resolved?.item.state).toBe('resolved')
    expect(resolved?.delivery).not.toBe('queued')
    expect(new Set([open?.item.state, queuedRow?.delivery, resolved?.item.state])).toEqual(new Set(['open', 'queued', 'resolved']))
  })

  it('writes under the projection directory from getConfigRoot and refuses a non-json body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'needsyou-root-'))
    dirs.push(root)
    const previous = process.env.TINSTAR_CONFIG_HOME
    process.env.TINSTAR_CONFIG_HOME = root
    dir = root
    submit = vi.fn<SubmitIntent>(async () => queuedReply('req'))
    const handle = registerNeedsYouRoutes({ submitIntent: submit, now: () => AT })
    const server = createServer((req, res) => {
      void handle(req, res).then(handled => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404
          res.end()
        }
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const saved = await post('/api/v6/needsyou/items', decisionFixture())
      expect(saved.status).toBe(200)
      const file = join(root, 'v6', 'needsyou', 'items.json')
      expect(JSON.parse(readFileSync(file, 'utf8')).schema).toBe('tinstar.v6.needsyou/1')
      const plain = await fetch(`${base}/api/v6/needsyou/ny-decision/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"revision":"rev-decision"}',
      })
      expect(plain.status).toBe(400)
      expect(submit).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.TINSTAR_CONFIG_HOME
      else process.env.TINSTAR_CONFIG_HOME = previous
    }
  })

  it('does not name a shell, a process kill, or a First Mate control script', () => {
    const roots = [
      join(process.cwd(), 'src/v6/needsyou'),
      join(process.cwd(), 'src/server/v6/needsyou'),
    ]
    const files: string[] = []
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        if (name === '__tests__') continue
        const full = join(path, name)
        if (statSync(full).isDirectory()) walk(full)
        else files.push(full)
      }
    }
    for (const root of roots) walk(root)
    const banned = ['fm-spawn', 'fm-send', 'fm-control', 'fm-teardown', 'child_process']
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const word of banned) expect(text, file).not.toContain(word)
    }
    expect(files.length).toBeGreaterThan(3)
  })
})

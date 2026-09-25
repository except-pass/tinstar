import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseNeedsYouItem } from '../../../../v6/contract/needsyou'
import { emptyRow } from '../../../../v6/needsyou/model'
import { emptyPortfolio, seedColumns } from '../../../../v6/portfolio/model'
import type { PortfolioDoc } from '../../../../v6/portfolio/types'
import { defaultAttentionDir, mutateAttention, readAttention } from '../../needsyou/store'
import { resolvePortfolioFile, savePortfolio, loadPortfolio } from '../../portfolio/store'
import { THREADS_SCHEMA, defaultThreadStoreFile, writeThreadDoc, type StoredThread } from '../../threads/store'
import { createAccountHandler } from '../routes'

const NOW = Date.parse('2026-09-25T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const AT = new Date(NOW).toISOString()

interface Envelope {
  ok: boolean
  data?: Record<string, unknown>
  error?: { message?: string }
}

let base = ''
let server: Server

beforeAll(async () => {
  const handler = createAccountHandler({ now: () => NOW })
  server = createServer((req, res) => {
    void handler(req, res).then(handled => {
      if (!handled && !res.headersSent) {
        res.writeHead(404)
        res.end('no')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  expect(address.port).not.toBe(5280)
  expect(address.port).not.toBe(5281)
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
  process.env.TINSTAR_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'v6-account-'))
})

async function send(path: string, init?: RequestInit): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${base}${path}`, init)
  const body = await res.json() as Envelope
  return { status: res.status, body }
}

function post(path: string, payload: unknown) {
  return send(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function portfolioPath(): string {
  const located = resolvePortfolioFile()
  if (!located.ok) throw new Error(located.detail)
  return located.file
}

async function seedBoard(): Promise<void> {
  const oldAt = new Date(NOW - 8 * DAY).toISOString()
  const exactAt = new Date(NOW - 7 * DAY).toISOString()
  const freshAt = new Date(NOW - 6 * DAY).toISOString()
  const doc: PortfolioDoc = {
    ...emptyPortfolio(),
    fixture: true,
    columns: [
      ...seedColumns(),
      { id: 'col-done', name: 'Done', description: 'A label, not a signal', order: 4, revision: '1' },
    ],
    epics: [
      { id: 'epic-done', title: 'Named Done', columnId: 'col-done', initiativeId: null, planSlug: null, completedAt: null, order: 0, revision: '1' },
      { id: 'epic-old', title: 'Old', columnId: 'col-inbox', initiativeId: null, planSlug: null, completedAt: oldAt, order: 1, revision: '1' },
      { id: 'epic-exact', title: 'Exact week', columnId: 'col-inbox', initiativeId: null, planSlug: null, completedAt: exactAt, order: 2, revision: '1' },
      { id: 'epic-fresh', title: 'Fresh', columnId: 'col-inbox', initiativeId: null, planSlug: null, completedAt: freshAt, order: 3, revision: '1' },
    ],
    tasks: [
      { id: 'task-old', project: 'tinstar', epicId: 'epic-old', planId: null, initiativeId: null, revision: '1' },
    ],
  }
  savePortfolio(portfolioPath(), doc)
  const thread: StoredThread = {
    id: 'thr-old',
    anchor: { type: 'epic', ids: ['epic-old'], textSelection: null, revision: null, labels: ['Old'] },
    turns: [],
    fixture: true,
    createdAt: AT,
    updatedAt: AT,
    display: { status: 'current', changedLine: null, position: null },
  }
  writeThreadDoc(defaultThreadStoreFile(), { schema: THREADS_SCHEMA, threads: [thread] })
  const open = parseNeedsYouItem({
    id: 'ny-open',
    type: 'blocked',
    headline: 'Need a reviewer',
    state: 'open',
    provenance: { epicId: 'epic-old' },
    createdAt: AT,
    updatedAt: AT,
    revision: '1',
    executionImpact: 'blocked',
    payload: {
      needed: 'a reviewer',
      why: 'the epic aged out',
      attempts: ['asked once'],
      unblockCondition: 'a reviewer answers',
    },
    response: null,
  })
  const resolved = parseNeedsYouItem({
    id: 'ny-resolved',
    type: 'blocked',
    headline: 'Already done',
    state: 'resolved',
    provenance: { epicId: 'epic-old' },
    createdAt: AT,
    updatedAt: AT,
    revision: '1',
    executionImpact: 'continues',
    payload: {
      needed: 'nothing',
      why: 'closed',
      attempts: [],
      unblockCondition: 'none',
    },
    response: null,
  })
  const other = parseNeedsYouItem({
    id: 'ny-other',
    type: 'blocked',
    headline: 'Other epic',
    state: 'open',
    provenance: { epicId: 'epic-fresh' },
    createdAt: AT,
    updatedAt: AT,
    revision: '1',
    executionImpact: 'blocked',
    payload: {
      needed: 'a note',
      why: 'separate epic',
      attempts: [],
      unblockCondition: 'a note arrives',
    },
    response: null,
  })
  if (!open.ok || !resolved.ok || !other.ok) throw new Error('fixture needs you item did not parse')
  await mutateAttention(defaultAttentionDir(), docAttention => {
    docAttention.items = [
      emptyRow(open.value, true),
      emptyRow(resolved.value, true),
      emptyRow(other.value, true),
    ]
    return docAttention.items.length
  })
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (name === '__tests__') return []
    if (statSync(path).isDirectory()) return filesUnder(path)
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

describe('account routes', () => {
  it('rejects command strings, raw tmux targets, and operations outside the allowlist', async () => {
    const command = await post('/api/v6/account/schedule/sample', {
      taskId: 'task-1',
      plannedMs: 1000,
      elapsedMs: 2000,
      command: 'echo hi',
    })
    expect(command.status).toBe(403)
    expect(command.body.error?.message).toMatch(/command/)

    const nested = await post('/api/v6/account/schedule/sample', {
      taskId: 'task-1',
      plannedMs: 1000,
      elapsedMs: 2000,
      meta: { tmux: 'firstmate:0.0' },
    })
    expect(nested.status).toBe(403)
    expect(nested.body.error?.message).toMatch(/tmux/)

    const target = await send('/api/v6/account/board?target=%3Dfirstmate')
    expect(target.status).toBe(403)
    expect(target.body.error?.message).toMatch(/target/)

    const banned = await post('/api/v6/account/schedule/sample', {
      op: 'spawn',
      taskId: 'task-1',
      plannedMs: 1000,
      elapsedMs: 1,
    })
    expect(banned.status).toBe(403)
    expect(banned.body.error?.message).toMatch(/not allowlisted/)

    const unknown = await post('/api/v6/account/run', { operation: 'kill' })
    expect(unknown.status).toBe(403)
    expect(unknown.body.error?.message).toMatch(/not allowlisted/)

    const missing = await send('/api/v6/account/schedule/task-1')
    expect(missing.status).toBe(404)
  })

  it('keeps one continuing drift item and does not reset elapsed or the baseline', async () => {
    const under = await post('/api/v6/account/schedule/sample', {
      op: 'schedule.sample',
      taskId: 'task-1',
      plannedMs: 10_000,
      elapsedMs: 10_000,
      retryCount: 0,
      activity: 'writing',
    })
    expect(under.status).toBe(200)
    const underTask = under.body.data?.task as { startedAt: string; plannedMs: number }
    expect(under.body.data?.drift).toBeNull()
    expect(under.body.data?.continues).toBe(true)
    expect(under.body.data?.stopped).toBe(false)

    const first = await post('/api/v6/account/schedule/sample', {
      taskId: 'task-1',
      plannedMs: 1,
      elapsedMs: 15_000,
      retryCount: 0,
      activity: 'writing',
    })
    expect(first.status).toBe(200)
    expect(first.body.data?.drift).toMatchObject({ id: 'schedule-drift:task-1', continues: true })
    expect(first.body.data?.stopped).toBe(false)
    expect((first.body.data?.task as { plannedMs: number }).plannedMs).toBe(10_000)

    const second = await post('/api/v6/account/schedule/sample', {
      taskId: 'task-1',
      plannedMs: 50,
      elapsedMs: 18_000,
      retryCount: 2,
      activity: 'still writing',
    })
    expect((second.body.data?.drift as { id: string }).id).toBe('schedule-drift:task-1')
    expect(second.body.data?.task).toMatchObject({
      plannedMs: 10_000,
      elapsedMs: 18_000,
      retryCount: 2,
      startedAt: underTask.startedAt,
    })

    const reset = await post('/api/v6/account/schedule/sample', {
      taskId: 'task-1',
      plannedMs: 10_000,
      elapsedMs: 0,
      retryCount: 3,
    })
    expect(reset.body.data?.task).toMatchObject({ elapsedMs: 18_000, retryCount: 3, plannedMs: 10_000 })

    const rows = readAttention(defaultAttentionDir()).items.filter(row => row.item.type === 'schedule-drift')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.item.id).toBe('schedule-drift:task-1')
    expect(rows[0]?.item.executionImpact).toBe('continues')
    expect(rows[0]?.item.payload).toMatchObject({
      plannedMs: 10_000,
      elapsedMs: 18_000,
      continues: true,
    })
    const explanation = rows[0]?.item.payload && 'explanation' in rows[0].item.payload
      ? rows[0].item.payload.explanation
      : ''
    expect(explanation).toMatch(/work continues/i)

    const ack = await post('/api/v6/account/schedule/task-1/acknowledge', {
      op: 'schedule.acknowledge',
      requestId: 'ack-1',
      plannedMs: 1,
    })
    expect(ack.status).toBe(200)
    expect(ack.body.data?.plannedMs).toBe(10_000)
    expect(ack.body.data?.continues).toBe(true)
    expect(ack.body.data?.stopped).toBe(false)

    const later = await post('/api/v6/account/schedule/sample', {
      taskId: 'task-1',
      plannedMs: 2,
      elapsedMs: 20_000,
      retryCount: 4,
    })
    expect(later.body.data?.task).toMatchObject({ plannedMs: 10_000, elapsedMs: 20_000, startedAt: underTask.startedAt })

    const forecast = await post('/api/v6/account/schedule/task-1/rebudget', { forecastMs: 80_000, plannedMs: 1 })
    expect(forecast.body.data).toMatchObject({ plannedMs: 10_000, forecastMs: 80_000, continues: true, stopped: false })

    const after = readAttention(defaultAttentionDir()).items.filter(row => row.item.type === 'schedule-drift')
    expect(after).toHaveLength(1)
    expect(after[0]?.item.id).toBe('schedule-drift:task-1')
    expect(after[0]?.acknowledgement?.requestId).toBe('ack-1')
    expect(after[0]?.item.payload).toMatchObject({ plannedMs: 10_000, continues: true })
    const noted = after[0]?.item.payload && 'explanation' in after[0].item.payload
      ? after[0].item.payload.explanation
      : ''
    expect(noted).toMatch(/Forecast 80000/)
    expect(noted).toMatch(/work continues/i)
  })

  it('hides epics completed more than seven days and keeps the record', async () => {
    await seedBoard()
    const before = readFileSync(portfolioPath(), 'utf8')
    const board = await send('/api/v6/account/board')
    expect(board.status).toBe(200)
    const ids = ((board.body.data?.board as { epics: { id: string }[] }).epics).map(item => item.id)
    expect(ids).toEqual(['epic-done', 'epic-exact', 'epic-fresh'])
    expect(board.body.data?.archivedEpicIds).toEqual(['epic-old'])

    const read = await send('/api/v6/account/epics/epic-old')
    expect(read.status).toBe(200)
    expect(read.body.data?.hidden).toBe(true)
    expect(read.body.data?.completedAt).toBe(new Date(NOW - 8 * DAY).toISOString())
    expect(read.body.data?.threads).toEqual([
      { id: 'thr-old', anchor: { type: 'epic', ids: ['epic-old'] } },
    ])
    expect(read.body.data?.needsYouIds).toEqual(['ny-open'])
    expect(readFileSync(portfolioPath(), 'utf8')).toBe(before)
    expect(loadPortfolio(portfolioPath()).epics.find(item => item.id === 'epic-old')?.completedAt).toBe(new Date(NOW - 8 * DAY).toISOString())

    const cleared = await post('/api/v6/account/epics/epic-old/completion', { completedAt: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.data?.hidden).toBe(false)
    const active = await send('/api/v6/account/board')
    const activeIds = ((active.body.data?.board as { epics: { id: string; columnId: string }[] }).epics).map(item => item.id)
    expect(activeIds).toContain('epic-old')
    expect(activeIds).toContain('epic-done')
    const stored = loadPortfolio(portfolioPath())
    expect(stored.epics.find(item => item.id === 'epic-old')).toMatchObject({
      completedAt: null,
      columnId: 'col-inbox',
    })
    expect(stored.epics.find(item => item.id === 'epic-done')?.columnId).toBe('col-done')

    const aged = await post('/api/v6/account/epics/epic-done/completion', {
      completedAt: new Date(NOW - 8 * DAY).toISOString(),
    })
    expect(aged.body.data?.hidden).toBe(true)
    const after = await send('/api/v6/account/board')
    const afterIds = ((after.body.data?.board as { epics: { id: string }[] }).epics).map(item => item.id)
    expect(afterIds).not.toContain('epic-done')
    expect(loadPortfolio(portfolioPath()).epics.find(item => item.id === 'epic-done')?.columnId).toBe('col-done')
  })

  it('does not start or stop a process from the account implementation', () => {
    const banned = ["from 'node:child_process'", 'from "node:child_process"', 'process.kill(', 'execFile(', 'spawn(']
    const roots = [
      join(process.cwd(), 'src/v6/account'),
      join(process.cwd(), 'src/server/v6/account'),
    ]
    const sources = roots.flatMap(filesUnder)
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      for (const word of banned) expect(text, file).not.toContain(word)
    }
  })
})

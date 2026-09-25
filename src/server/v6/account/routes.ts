import type { IncomingMessage, ServerResponse } from 'node:http'
import { fail, ok } from '../../api/envelope'
import { readBody } from '../../api/readBody'
import { isRecord } from '../../../v6/contract/result'
import { parseNeedsYouItem } from '../../../v6/contract/needsyou'
import {
  acknowledgeTask,
  applySample,
  driftItemId,
  driftReached,
  driftWire,
  rebudgetTask,
  type SampleInput,
  type ScheduleTask,
} from '../../../v6/account/drift'
import {
  payloadRefusal,
  queryRefusal,
  type AccountRoute,
} from '../../../v6/account/guard'
import { activeBoard, epicHiddenFromActiveBoard } from '../../../v6/account/retention'
import { emptyRow, type AttentionRow } from '../../../v6/needsyou/model'
import { bumpRevision } from '../../../v6/portfolio/model'
import type { Epic } from '../../../v6/portfolio/types'
import { defaultAttentionDir, mutateAttention, readAttention } from '../needsyou/store'
import { loadPortfolio, resolvePortfolioFile, updatePortfolio } from '../portfolio/store'
import { defaultThreadStoreFile, readThreadDoc } from '../threads/store'
import { defaultScheduleFile, readSchedule, updateSchedule } from './scheduleStore'

export interface AccountRouteOptions {
  /** Milliseconds. Tests pin the retention clock. */
  now?: () => number
}

export type AccountHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString()
}

function safeId(id: string): boolean {
  if (id.length === 0 || id.length > 128 || id.startsWith('.')) return false
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false
  return SAFE_ID.test(id)
}

function portfolioFile(res: ServerResponse): string | null {
  const located = resolvePortfolioFile()
  if (!located.ok) {
    fail(res, 'PATH_OUTSIDE_WORKSPACE', located.detail)
    return null
  }
  return located.file
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const type = req.headers['content-type']
  const header = Array.isArray(type) ? type[0] : type
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('application/json')) {
    fail(res, 'BAD_REQUEST', 'Content-Type must be application/json', { status: 415 })
    return null
  }
  let text = ''
  try {
    text = await readBody(req)
  } catch (err) {
    fail(res, 'BAD_REQUEST', err instanceof Error ? err.message : 'body could not be read')
    return null
  }
  try {
    const raw = JSON.parse(text) as unknown
    if (!isRecord(raw)) {
      fail(res, 'BAD_REQUEST', 'body must be a JSON object')
      return null
    }
    return raw
  } catch {
    fail(res, 'BAD_REQUEST', 'body must be JSON')
    return null
  }
}

function rejectPayload(res: ServerResponse, reason: string): void {
  fail(res, 'FORBIDDEN', reason)
}

type GuardResult =
  | { ok: true; body: Record<string, unknown> | null }
  | { ok: false }

function decodeId(raw: string, res: ServerResponse): string | null {
  let id = raw
  try {
    id = decodeURIComponent(raw)
  } catch {
    fail(res, 'BAD_REQUEST', 'id is not valid')
    return null
  }
  if (!safeId(id)) {
    fail(res, 'BAD_REQUEST', 'id is not valid')
    return null
  }
  return id
}

function finiteNumber(raw: unknown, field: string): number | string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return `${field} must be a finite number`
  return raw
}

function lastProgressOf(raw: unknown): SampleInput['lastProgress'] | string {
  if (raw === undefined) return { unknown: true }
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (isRecord(raw) && raw.unknown === true) return { unknown: true }
  return 'lastProgress must be text or { unknown: true }'
}

function threadsFor(epicId: string): { id: string; anchor: { type: string; ids: string[] } }[] {
  const doc = readThreadDoc(defaultThreadStoreFile())
  return doc.threads
    .filter(thread => thread.anchor.ids.includes(epicId))
    .map(thread => ({
      id: thread.id,
      anchor: { type: thread.anchor.type, ids: [...thread.anchor.ids] },
    }))
}

function openNeedsYouIds(epicId: string): string[] {
  const portfolio = resolvePortfolioFile()
  const taskIds = new Set<string>()
  if (portfolio.ok) {
    for (const task of loadPortfolio(portfolio.file).tasks) {
      if (task.epicId === epicId) taskIds.add(task.id)
    }
  }
  return readAttention(defaultAttentionDir()).items
    .filter(row => {
      if (row.item.state !== 'open') return false
      if (row.item.provenance.epicId === epicId) return true
      const taskId = row.item.provenance.taskId
      return typeof taskId === 'string' && taskIds.has(taskId)
    })
    .map(row => row.item.id)
}

async function writeDriftItem(task: ScheduleTask, at: string): Promise<AttentionRow> {
  const id = driftItemId(task.taskId)
  return mutateAttention(defaultAttentionDir(), doc => {
    const existing = doc.items.find(row => row.item.id === id)
    const wire = driftWire(task, at, existing?.item.createdAt ?? task.startedAt)
    const parsed = parseNeedsYouItem(wire)
    if (!parsed.ok) throw new Error(parsed.diagnostic)
    const row = emptyRow(parsed.value, false, undefined, wire)
    if (existing) {
      row.acknowledgement = existing.acknowledgement
      row.spentRequestIds = existing.spentRequestIds
      row.answerRequestId = existing.answerRequestId
      row.delivery = existing.delivery
      row.receiptDetail = existing.receiptDetail
      row.lastError = existing.lastError
    }
    doc.items = existing
      ? doc.items.map(item => item.item.id === id ? row : item)
      : [...doc.items, row]
    return row
  })
}

function sampleResponse(task: ScheduleTask) {
  return {
    task,
    drift: driftReached(task) ? { id: driftItemId(task.taskId), continues: true } : null,
    continues: true,
    stopped: false,
  }
}

export function createAccountHandler(options: AccountRouteOptions = {}): AccountHandler {
  const now = options.now ?? (() => Date.now())

  return async function handleAccount(req, res): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path !== '/api/v6/account' && !path.startsWith('/api/v6/account/')) return false
    const method = req.method ?? 'GET'

    try {
      if (path === '/api/v6/account/board') return await board(req, res, url, method)
      if (path === '/api/v6/account/schedule/sample') return await sample(req, res, url, method)
      const completion = path.match(/^\/api\/v6\/account\/epics\/([^/]+)\/completion$/)
      if (completion?.[1]) return await setCompletion(req, res, url, method, completion[1])
      const acknowledge = path.match(/^\/api\/v6\/account\/schedule\/([^/]+)\/acknowledge$/)
      if (acknowledge?.[1]) return await acknowledgeSchedule(req, res, url, method, acknowledge[1])
      const rebudget = path.match(/^\/api\/v6\/account\/schedule\/([^/]+)\/rebudget$/)
      if (rebudget?.[1]) return await rebudgetSchedule(req, res, url, method, rebudget[1])
      const epic = path.match(/^\/api\/v6\/account\/epics\/([^/]+)$/)
      if (epic?.[1]) return await readEpic(req, res, url, method, epic[1])
      const schedule = path.match(/^\/api\/v6\/account\/schedule\/([^/]+)$/)
      if (schedule?.[1]) return await readOneSchedule(res, url, method, schedule[1])
      fail(res, 'FORBIDDEN', 'operation is not allowlisted')
      return true
    } catch (err) {
      fail(res, 'INTERNAL', err instanceof Error ? err.message : 'account route failed')
      return true
    }
  }

  async function guard(req: IncomingMessage, res: ServerResponse, url: URL, route: AccountRoute, read: boolean): Promise<GuardResult> {
    const query = queryRefusal(url.searchParams.entries(), route)
    if (query) {
      rejectPayload(res, query)
      return { ok: false }
    }
    if (!read) return { ok: true, body: null }
    const body = await readJson(req, res)
    if (!body) return { ok: false }
    const reason = payloadRefusal(body, route)
    if (reason) {
      rejectPayload(res, reason)
      return { ok: false }
    }
    return { ok: true, body }
  }

  async function board(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<true> {
    const checked = await guard(req, res, url, 'board', false)
    if (!checked.ok) return true
    if (method !== 'GET') {
      fail(res, 'BAD_REQUEST', 'method is not allowed', { status: 405 })
      return true
    }
    const file = portfolioFile(res)
    if (!file) return true
    ok(res, activeBoard(loadPortfolio(file), now()))
    return true
  }

  async function readEpic(req: IncomingMessage, res: ServerResponse, url: URL, method: string, rawId: string): Promise<true> {
    const checked = await guard(req, res, url, 'epic-read', false)
    if (!checked.ok) return true
    if (method !== 'GET') {
      fail(res, 'BAD_REQUEST', 'method is not allowed', { status: 405 })
      return true
    }
    const id = decodeId(rawId, res)
    if (!id) return true
    const file = portfolioFile(res)
    if (!file) return true
    const epicRow = loadPortfolio(file).epics.find(item => item.id === id) ?? null
    if (!epicRow) {
      fail(res, 'NOT_FOUND', `epic ${id} not found`)
      return true
    }
    ok(res, {
      epic: epicRow,
      hidden: epicHiddenFromActiveBoard(epicRow, now()),
      completedAt: epicRow.completedAt,
      threads: threadsFor(id),
      needsYouIds: openNeedsYouIds(id),
    })
    return true
  }

  async function setCompletion(req: IncomingMessage, res: ServerResponse, url: URL, method: string, rawId: string): Promise<true> {
    if (method !== 'POST') {
      fail(res, 'BAD_REQUEST', 'method is not allowed', { status: 405 })
      return true
    }
    const checked = await guard(req, res, url, 'epic-completion', true)
    if (!checked.ok || !checked.body) return true
    const body = checked.body
    const id = decodeId(rawId, res)
    if (!id) return true
    if (!('completedAt' in body)) {
      fail(res, 'INVALID_PARAMS', 'completedAt is required')
      return true
    }
    const rawCompleted = body.completedAt
    let completedAt: string | null
    if (rawCompleted === null) completedAt = null
    else if (typeof rawCompleted === 'string' && Number.isFinite(Date.parse(rawCompleted))) completedAt = rawCompleted
    else {
      fail(res, 'INVALID_PARAMS', 'completedAt must be a timestamp or null')
      return true
    }
    const file = portfolioFile(res)
    if (!file) return true
    const saved = await updatePortfolio(file, doc => {
      const index = doc.epics.findIndex(item => item.id === id)
      const current = index < 0 ? undefined : doc.epics[index]
      if (!current) return { doc, result: null }
      const next: Epic = { ...current, completedAt, revision: bumpRevision(current.revision) }
      const epics = doc.epics.slice()
      epics[index] = next
      return { doc: { ...doc, epics }, result: next }
    })
    if (!saved) {
      fail(res, 'NOT_FOUND', `epic ${id} not found`)
      return true
    }
    ok(res, { epic: saved, hidden: epicHiddenFromActiveBoard(saved, now()) })
    return true
  }

  async function sample(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<true> {
    if (method !== 'POST') {
      fail(res, 'BAD_REQUEST', 'method is not allowed', { status: 405 })
      return true
    }
    const checked = await guard(req, res, url, 'sample', true)
    if (!checked.ok || !checked.body) return true
    const body = checked.body
    if (typeof body.taskId !== 'string' || !safeId(body.taskId)) {
      fail(res, 'INVALID_PARAMS', 'taskId is not valid')
      return true
    }
    const planned = finiteNumber(body.plannedMs, 'plannedMs')
    if (typeof planned === 'string') {
      fail(res, 'INVALID_PARAMS', planned)
      return true
    }
    if (planned <= 0) {
      fail(res, 'INVALID_PARAMS', 'plannedMs must be greater than zero')
      return true
    }
    const elapsed = finiteNumber(body.elapsedMs, 'elapsedMs')
    if (typeof elapsed === 'string') {
      fail(res, 'INVALID_PARAMS', elapsed)
      return true
    }
    if (elapsed < 0) {
      fail(res, 'INVALID_PARAMS', 'elapsedMs must be zero or greater')
      return true
    }
    let retryCount = 0
    if (body.retryCount !== undefined) {
      const retry = finiteNumber(body.retryCount, 'retryCount')
      if (typeof retry === 'string' || !Number.isInteger(retry) || retry < 0) {
        fail(res, 'INVALID_PARAMS', 'retryCount must be a non-negative integer')
        return true
      }
      retryCount = retry
    }
    const progress = lastProgressOf(body.lastProgress)
    if (typeof progress === 'string') {
      fail(res, 'INVALID_PARAMS', progress)
      return true
    }
    const at = stamp(now())
    const input: SampleInput = {
      taskId: body.taskId,
      plannedMs: planned,
      elapsedMs: elapsed,
      retryCount,
      activity: typeof body.activity === 'string' ? body.activity : '',
      lastProgress: progress,
      evidence: typeof body.evidence === 'string' ? body.evidence : '',
      explanation: typeof body.explanation === 'string' ? body.explanation : '',
      at,
    }
    const file = defaultScheduleFile()
    const task = await updateSchedule(file, doc => {
      const next = applySample(doc.tasks[input.taskId], input)
      doc.tasks[input.taskId] = next
      return next
    })
    if (driftReached(task)) await writeDriftItem(task, at)
    ok(res, sampleResponse(task))
    return true
  }

  async function acknowledgeSchedule(req: IncomingMessage, res: ServerResponse, url: URL, method: string, rawId: string): Promise<true> {
    if (method !== 'POST') {
      fail(res, 'BAD_REQUEST', 'method is not allowed', { status: 405 })
      return true
    }
    const checked = await guard(req, res, url, 'acknowledge', true)
    if (!checked.ok || !checked.body) return true
    const body = checked.body
    const id = decodeId(rawId, res)
    if (!id) return true
    const at = stamp(now())
    const requestId = typeof body.requestId === 'string' && body.requestId.length > 0 ? body.requestId : `ack-${id}`
    const file = defaultScheduleFile()
    const task = await updateSchedule(file, doc => {
      const current = doc.tasks[id]
      if (!current) return null
      const next = acknowledgeTask(current, at)
      doc.tasks[id] = next
      return next
    })
    if (!task) {
      fail(res, 'NOT_FOUND', `schedule ${id} not found`)
      return true
    }
    await mutateAttention(defaultAttentionDir(), doc => {
      const row = doc.items.find(item => item.item.id === driftItemId(id))
      if (!row) return null
      row.acknowledgement = { requestId, at, delivery: 'queued' }
      return row
    })
    ok(res, { task, plannedMs: task.plannedMs, continues: true, stopped: false })
    return true
  }

  async function rebudgetSchedule(req: IncomingMessage, res: ServerResponse, url: URL, method: string, rawId: string): Promise<true> {
    if (method !== 'POST') {
      fail(res, 'BAD_REQUEST', 'method is not allowed', { status: 405 })
      return true
    }
    const checked = await guard(req, res, url, 'rebudget', true)
    if (!checked.ok || !checked.body) return true
    const body = checked.body
    const id = decodeId(rawId, res)
    if (!id) return true
    const forecast = finiteNumber(body.forecastMs, 'forecastMs')
    if (typeof forecast === 'string' || forecast <= 0) {
      fail(res, 'INVALID_PARAMS', 'forecastMs must be greater than zero')
      return true
    }
    const at = stamp(now())
    const task = await updateSchedule(defaultScheduleFile(), doc => {
      const current = doc.tasks[id]
      if (!current) return null
      const next = rebudgetTask(current, forecast)
      doc.tasks[id] = next
      return next
    })
    if (!task) {
      fail(res, 'NOT_FOUND', `schedule ${id} not found`)
      return true
    }
    if (driftReached(task)) await writeDriftItem(task, at)
    ok(res, { task, plannedMs: task.plannedMs, forecastMs: task.forecastMs, continues: true, stopped: false })
    return true
  }

  function readOneSchedule(res: ServerResponse, url: URL, method: string, rawId: string): true {
    const query = queryRefusal(url.searchParams.entries(), 'schedule-read')
    if (query) {
      rejectPayload(res, query)
      return true
    }
    if (method !== 'GET') {
      fail(res, 'BAD_REQUEST', 'method is not allowed', { status: 405 })
      return true
    }
    const id = decodeId(rawId, res)
    if (!id) return true
    const task = readSchedule(defaultScheduleFile()).tasks[id] ?? null
    if (!task) {
      fail(res, 'NOT_FOUND', `schedule ${id} not found`)
      return true
    }
    ok(res, { task, continues: true, stopped: false })
    return true
  }
}

export function registerAccountRoutes(options: AccountRouteOptions = {}): AccountHandler {
  return createAccountHandler(options)
}

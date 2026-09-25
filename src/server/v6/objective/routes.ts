import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { fail, ok } from '../../api/envelope'
import type { ErrorCode } from '../../../domain/api'
import { isRecord } from '../../../v6/contract/result'
import {
  emptyWorker,
  requestIdAllowed,
  sessionNameRefusal,
  workerIdAllowed,
  type WorkerObjectiveRecord,
} from '../../../v6/objective/model'
import { submitIntent as defaultSubmitIntent, type IntentSubmission, type ObjectiveInboxOptions } from './inbox'
import { achieveObjective, applyReceipt, requestLaunch, setObjective } from './mutate'
import { defaultObjectiveFile, readDocument, updateDocument } from './store'

export interface ObjectiveRouteDeps extends ObjectiveInboxOptions {
  projectionFile?: string
  now?: () => string
  /** Replaces the built-in inbox note. ts-account can pass the shell client here. */
  submitIntent?: (raw: unknown) => Promise<IntentSubmission>
}

function fileOf(deps: ObjectiveRouteDeps): string {
  return deps.projectionFile ?? defaultObjectiveFile()
}

function nowOf(deps: ObjectiveRouteDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))()
}

function submitOf(deps: ObjectiveRouteDeps): (raw: unknown) => Promise<IntentSubmission> {
  if (deps.submitIntent) return deps.submitIntent
  return raw => defaultSubmitIntent(raw, { home: deps.home, binDir: deps.binDir, runner: deps.runner })
}

function statusCode(status: number): ErrorCode {
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 403) return 'FORBIDDEN'
  return 'BAD_REQUEST'
}

function sendResult(res: ServerResponse, result: { ok: true; data: unknown } | { ok: false; status: number; error: string }): void {
  if (result.ok) ok(res, result.data)
  else fail(res, statusCode(result.status), result.error)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65_536) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const type = req.headers['content-type']
  if (typeof type !== 'string' || !type.includes('application/json')) {
    await readBody(req).catch(() => '')
    fail(res, 'BAD_REQUEST', 'Content-Type must be application/json')
    return null
  }
  let text = ''
  try {
    text = await readBody(req)
  } catch {
    fail(res, 'BAD_REQUEST', 'body could not be read')
    return null
  }
  try {
    const raw = JSON.parse(text) as unknown
    if (!isRecord(raw)) {
      fail(res, 'BAD_REQUEST', 'body must be an object')
      return null
    }
    return raw
  } catch {
    fail(res, 'BAD_REQUEST', 'body is not JSON')
    return null
  }
}

function takeRequestId(raw: unknown, res: ServerResponse): string | null {
  if (raw === undefined) return randomUUID()
  if (typeof raw !== 'string' || !requestIdAllowed(raw)) {
    fail(res, 'BAD_REQUEST', 'requestId is not a valid inbox request id')
    return null
  }
  return raw
}

function takeText(raw: unknown, field: string, res: ServerResponse, max = 4000): string | null {
  if (typeof raw !== 'string') {
    fail(res, 'BAD_REQUEST', `${field} must be a string`)
    return null
  }
  const text = raw.trim()
  if (text.length === 0 || text.length > max) {
    fail(res, 'BAD_REQUEST', `${field} must be a non-empty string`)
    return null
  }
  if (text.includes('\u0000')) {
    fail(res, 'BAD_REQUEST', `${field} has a forbidden character`)
    return null
  }
  return text
}

function workerFromPath(segment: string, res: ServerResponse): string | null {
  let workerId = segment
  try {
    workerId = decodeURIComponent(segment)
  } catch {
    fail(res, 'BAD_REQUEST', 'worker id is not valid')
    return null
  }
  if (!workerIdAllowed(workerId)) {
    fail(res, 'BAD_REQUEST', 'worker id is not valid')
    return null
  }
  return workerId
}

/**
 * Mount objective and launch routes. Returns true when the request was handled.
 * Tests attach this with `registerObjectiveRoutes` on a throwaway server.
 */
export async function handleObjectiveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObjectiveRouteDeps = {},
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  if (!path.startsWith('/api/v6/objectives') && !path.startsWith('/api/v6/launches')) return false

  try {
    await dispatch(req, res, deps, path)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'objective store failed'
    fail(res, 'CONFIG_UNAVAILABLE', message)
  }
  return true
}

async function dispatch(req: IncomingMessage, res: ServerResponse, deps: ObjectiveRouteDeps, path: string): Promise<void> {
  const method = req.method ?? 'GET'
  const file = fileOf(deps)
  const submit = submitOf(deps)

  if (method === 'POST' && path === '/api/v6/objectives/receipts') {
    const body = await readJson(req, res)
    if (!body) return
    const result = await updateDocument(file, doc => applyReceipt(doc, body, nowOf(deps)))
    sendResult(res, result)
    return
  }

  if (path === '/api/v6/launches') {
    if (method === 'GET') {
      const launches = Object.values(readDocument(file).launches)
      ok(res, { launches })
      return
    }
    if (method !== 'POST') {
      fail(res, 'BAD_REQUEST', 'method is not allowed')
      return
    }
    const body = await readJson(req, res)
    if (!body) return
    const requestId = takeRequestId(body.requestId, res)
    if (!requestId) return
    const project = takeText(body.project, 'project', res, 200)
    if (!project) return
    const objective = takeText(body.objective, 'objective', res)
    if (!objective) return
    let sessionName: string | null = null
    if (body.sessionName !== undefined && body.sessionName !== null && body.sessionName !== '') {
      if (typeof body.sessionName !== 'string') {
        fail(res, 'BAD_REQUEST', 'sessionName must be a string')
        return
      }
      sessionName = body.sessionName.trim()
      const refusal = sessionNameRefusal(sessionName)
      if (refusal) {
        fail(res, 'FORBIDDEN', refusal)
        return
      }
    }
    if (body.fixture !== undefined && typeof body.fixture !== 'boolean') {
      fail(res, 'BAD_REQUEST', 'fixture must be a boolean')
      return
    }
    const result = await updateDocument(file, doc => requestLaunch(doc, {
      requestId,
      project,
      objective,
      sessionName,
      fixture: body.fixture === true,
    }, submit, nowOf(deps)))
    sendResult(res, result)
    return
  }

  if (path.startsWith('/api/v6/launches/')) {
    if (method !== 'GET') {
      fail(res, 'BAD_REQUEST', 'method is not allowed')
      return
    }
    const requestId = path.slice('/api/v6/launches/'.length)
    if (!requestIdAllowed(requestId)) {
      fail(res, 'BAD_REQUEST', 'requestId is not a valid inbox request id')
      return
    }
    const launch = readDocument(file).launches[requestId]
    if (!launch) fail(res, 'NOT_FOUND', 'no launch matches this request id')
    else ok(res, launch)
    return
  }

  if (method === 'GET' && path === '/api/v6/objectives') {
    const workers = Object.values(readDocument(file).workers).sort((a, b) => a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0)
    ok(res, { workers })
    return
  }

  const prefix = '/api/v6/objectives/'
  if (!path.startsWith(prefix)) {
    fail(res, 'NOT_FOUND', 'no objective route')
    return
  }
  const rest = path.slice(prefix.length)
  const slash = rest.indexOf('/')
  const segment = slash === -1 ? rest : rest.slice(0, slash)
  const tail = slash === -1 ? '' : rest.slice(slash + 1)
  const workerId = workerFromPath(segment, res)
  if (!workerId) return

  if (tail === '' && method === 'GET') {
    ok(res, readDocument(file).workers[workerId] ?? emptyWorker(workerId))
    return
  }

  if (tail === '' && method === 'POST') {
    const body = await readJson(req, res)
    if (!body) return
    const parsed = parseSetBody(body, workerId, res)
    if (!parsed) return
    const result = await updateDocument(file, doc => setObjective(doc, parsed, submit, nowOf(deps)))
    sendResult(res, result)
    return
  }

  if (tail === 'achieve' && method === 'POST') {
    const body = await readJson(req, res)
    if (!body) return
    const requestId = takeRequestId(body.requestId, res)
    if (!requestId) return
    let revision: string | null = null
    if (body.revision !== undefined && body.revision !== null) {
      if (typeof body.revision !== 'string' || body.revision.length === 0) {
        fail(res, 'BAD_REQUEST', 'revision must be a string or null')
        return
      }
      revision = body.revision
    }
    const result = await updateDocument(file, doc => achieveObjective(doc, { workerId, requestId, revision }, submit, nowOf(deps)))
    sendResult(res, result)
    return
  }

  fail(res, 'NOT_FOUND', 'no objective route')
}

function parseSetBody(body: Record<string, unknown>, workerId: string, res: ServerResponse): {
  workerId: string
  requestId: string
  revision: string | null
  text: string
  narrower: boolean
  parentTaskId: string | null
  planTaskLabel: string | null
  planTaskSource: 'plan-task' | null
  fixture: boolean
} | null {
  if (body.workerId !== undefined && body.workerId !== workerId) {
    fail(res, 'BAD_REQUEST', 'workerId does not match the path')
    return null
  }
  const requestId = takeRequestId(body.requestId, res)
  if (!requestId) return null
  const text = takeText(body.text, 'text', res)
  if (!text) return null
  let revision: string | null = null
  if (body.revision !== undefined && body.revision !== null) {
    if (typeof body.revision !== 'string' || body.revision.length === 0) {
      fail(res, 'BAD_REQUEST', 'revision must be a string or null')
      return null
    }
    revision = body.revision
  }
  if (body.narrower !== undefined && typeof body.narrower !== 'boolean') {
    fail(res, 'BAD_REQUEST', 'narrower must be a boolean')
    return null
  }
  if (body.fixture !== undefined && typeof body.fixture !== 'boolean') {
    fail(res, 'BAD_REQUEST', 'fixture must be a boolean')
    return null
  }
  const narrower = body.narrower === true
  let parentTaskId: string | null = null
  if (body.parentTaskId !== undefined && body.parentTaskId !== null) {
    if (typeof body.parentTaskId !== 'string' || body.parentTaskId.trim().length === 0) {
      fail(res, 'BAD_REQUEST', 'parentTaskId must be a string')
      return null
    }
    parentTaskId = body.parentTaskId.trim()
  }
  if (narrower && !parentTaskId) {
    fail(res, 'BAD_REQUEST', 'a narrower objective names its parent task')
    return null
  }
  let planTaskLabel: string | null = null
  let planTaskSource: 'plan-task' | null = null
  if (body.planTaskSource !== undefined && body.planTaskSource !== null) {
    if (body.planTaskSource !== 'plan-task') {
      fail(res, 'BAD_REQUEST', 'planTaskSource is not a known value')
      return null
    }
    planTaskSource = 'plan-task'
  }
  if (body.planTaskLabel !== undefined && body.planTaskLabel !== null) {
    if (typeof body.planTaskLabel !== 'string' || body.planTaskLabel.trim().length === 0) {
      fail(res, 'BAD_REQUEST', 'planTaskLabel must be a string')
      return null
    }
    planTaskLabel = body.planTaskLabel.trim()
  }
  if (planTaskLabel && planTaskSource !== 'plan-task') {
    fail(res, 'BAD_REQUEST', 'a plan task label needs source plan-task')
    return null
  }
  if (planTaskSource === 'plan-task' && !planTaskLabel) {
    fail(res, 'BAD_REQUEST', 'source plan-task needs a label')
    return null
  }
  return { workerId, requestId, revision, text, narrower, parentTaskId, planTaskLabel, planTaskSource, fixture: body.fixture === true }
}

export function registerObjectiveRoutes(server: Server, deps: ObjectiveRouteDeps = {}): void {
  server.on('request', (req, res) => {
    void handleObjectiveRequest(req, res, deps)
  })
}

export type { WorkerObjectiveRecord }

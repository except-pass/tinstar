import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../configRoot'
import { isRecord } from '../../../v6/contract/result'
import {
  OBJECTIVE_DISPOSITIONS,
  OBJECTIVE_SCHEMA,
  T01_PROCESS_UNCLAIMED,
  emptyDocument,
  type AchievementRecord,
  type CurrentObjective,
  type LaunchRecord,
  type ObjectiveDisposition,
  type ObjectiveDocument,
  type ObjectiveRequestPointer,
  type ObjectiveRevision,
  type StoredReceipt,
  type WorkerObjectiveRecord,
} from '../../../v6/objective/model'

export function defaultObjectiveFile(): string {
  return join(getConfigRoot(), 'v6', 'objectives.json')
}

function fail(message: string): never {
  throw new Error(message)
}

function needString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) fail(`${field} must be a non-empty string`)
  return raw
}

function needDisposition(raw: unknown, field: string): ObjectiveDisposition {
  if (typeof raw !== 'string' || !(OBJECTIVE_DISPOSITIONS as readonly string[]).includes(raw)) {
    fail(`${field} is not a known value`)
  }
  return raw as ObjectiveDisposition
}

function readRevision(raw: unknown, field: string): ObjectiveRevision {
  if (!isRecord(raw)) fail(`${field} must be an object`)
  return {
    revision: needString(raw.revision, `${field}.revision`),
    text: needString(raw.text, `${field}.text`),
    setAt: needString(raw.setAt, `${field}.setAt`),
    requestId: needString(raw.requestId, `${field}.requestId`),
  }
}

function optionalString(raw: unknown, field: string): string | null {
  if (raw === null) return null
  if (typeof raw !== 'string') fail(`${field} must be a string or null`)
  return raw
}

function readCurrent(raw: unknown, field: string): CurrentObjective {
  if (!isRecord(raw)) fail(`${field} must be an object`)
  const revision = readRevision(raw, field)
  if (typeof raw.narrower !== 'boolean') fail(`${field}.narrower must be a boolean`)
  if (typeof raw.fixture !== 'boolean') fail(`${field}.fixture must be a boolean`)
  if (typeof raw.pending !== 'boolean') fail(`${field}.pending must be a boolean`)
  if (typeof raw.detail !== 'string') fail(`${field}.detail must be a string`)
  const planTaskSource = raw.planTaskSource
  if (planTaskSource !== null && planTaskSource !== 'plan-task') {
    fail(`${field}.planTaskSource is not a known value`)
  }
  return {
    ...revision,
    disposition: needDisposition(raw.disposition, `${field}.disposition`),
    pending: raw.pending,
    detail: raw.detail,
    noteId: optionalString(raw.noteId, `${field}.noteId`),
    narrower: raw.narrower,
    parentTaskId: optionalString(raw.parentTaskId, `${field}.parentTaskId`),
    parentTaskCompletedAt: null,
    planProgress: null,
    planTaskLabel: optionalString(raw.planTaskLabel, `${field}.planTaskLabel`),
    planTaskSource,
    fixture: raw.fixture,
  }
}

function readWorker(raw: unknown, workerId: string): WorkerObjectiveRecord {
  if (!isRecord(raw)) fail(`workers.${workerId} must be an object`)
  if (raw.workerId !== workerId) fail(`workers.${workerId}.workerId does not match`)
  if (!Array.isArray(raw.history)) fail(`workers.${workerId}.history must be an array`)
  return {
    workerId,
    current: raw.current === null ? null : readCurrent(raw.current, `workers.${workerId}.current`),
    history: raw.history.map((entry, index) => readRevision(entry, `workers.${workerId}.history.${index}`)),
  }
}

function readLaunch(raw: unknown, requestId: string): LaunchRecord {
  if (!isRecord(raw)) fail(`launches.${requestId} must be an object`)
  if (raw.requestId !== requestId) fail(`launches.${requestId}.requestId does not match`)
  if (typeof raw.fixture !== 'boolean') fail(`launches.${requestId}.fixture must be a boolean`)
  if (typeof raw.detail !== 'string') fail(`launches.${requestId}.detail must be a string`)
  return {
    requestId,
    project: needString(raw.project, `launches.${requestId}.project`),
    objective: needString(raw.objective, `launches.${requestId}.objective`),
    sessionName: optionalString(raw.sessionName, `launches.${requestId}.sessionName`),
    status: 'pending',
    processCreated: false,
    disposition: needDisposition(raw.disposition, `launches.${requestId}.disposition`),
    pending: true,
    detail: raw.detail,
    noteId: optionalString(raw.noteId, `launches.${requestId}.noteId`),
    createdAt: needString(raw.createdAt, `launches.${requestId}.createdAt`),
    fixture: raw.fixture,
    processClaim: T01_PROCESS_UNCLAIMED,
  }
}

function readAchievement(raw: unknown, requestId: string): AchievementRecord {
  if (!isRecord(raw)) fail(`achievements.${requestId} must be an object`)
  if (typeof raw.pending !== 'boolean') fail(`achievements.${requestId}.pending must be a boolean`)
  if (typeof raw.detail !== 'string') fail(`achievements.${requestId}.detail must be a string`)
  return {
    requestId,
    workerId: needString(raw.workerId, `achievements.${requestId}.workerId`),
    text: needString(raw.text, `achievements.${requestId}.text`),
    revision: needString(raw.revision, `achievements.${requestId}.revision`),
    disposition: needDisposition(raw.disposition, `achievements.${requestId}.disposition`),
    pending: raw.pending,
    detail: raw.detail,
    noteId: optionalString(raw.noteId, `achievements.${requestId}.noteId`),
    at: needString(raw.at, `achievements.${requestId}.at`),
  }
}

function readReceipt(raw: unknown, requestId: string): StoredReceipt {
  if (!isRecord(raw)) fail(`receipts.${requestId} must be an object`)
  if (raw.outcome !== 'applied' && raw.outcome !== 'rejected') fail(`receipts.${requestId}.outcome is not a known value`)
  if (typeof raw.detail !== 'string') fail(`receipts.${requestId}.detail must be a string`)
  return {
    requestId,
    outcome: raw.outcome,
    detail: raw.detail,
    at: needString(raw.at, `receipts.${requestId}.at`),
  }
}

function readPointer(raw: unknown, requestId: string): ObjectiveRequestPointer {
  if (!isRecord(raw)) fail(`requests.${requestId} must be an object`)
  const kind = raw.kind
  if (kind !== 'objective.set' && kind !== 'launch.request' && kind !== 'thread.message') {
    fail(`requests.${requestId}.kind is not a known value`)
  }
  return { kind, workerId: optionalString(raw.workerId, `requests.${requestId}.workerId`) }
}

function readMap<T>(raw: unknown, field: string, read: (value: unknown, key: string) => T): Record<string, T> {
  if (!isRecord(raw)) fail(`${field} must be an object`)
  const out: Record<string, T> = {}
  for (const key of Object.keys(raw)) out[key] = read(raw[key], key)
  return out
}

export function readDocument(file: string): ObjectiveDocument {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return emptyDocument()
    throw err
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    fail('objective store is not JSON')
  }
  if (!isRecord(raw)) fail('objective store must be an object')
  if (raw.schema !== OBJECTIVE_SCHEMA) fail(`schema must be ${OBJECTIVE_SCHEMA}`)
  return {
    schema: OBJECTIVE_SCHEMA,
    workers: readMap(raw.workers, 'workers', readWorker),
    launches: readMap(raw.launches, 'launches', readLaunch),
    achievements: readMap(raw.achievements, 'achievements', readAchievement),
    receipts: readMap(raw.receipts, 'receipts', readReceipt),
    requests: readMap(raw.requests, 'requests', readPointer),
  }
}

export function writeDocument(file: string, doc: ObjectiveDocument): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

const chains = new Map<string, Promise<unknown>>()

export function updateDocument<T>(file: string, mutate: (doc: ObjectiveDocument) => Promise<T> | T): Promise<T> {
  const prev = chains.get(file) ?? Promise.resolve()
  const run = prev.then(async () => {
    const doc = readDocument(file)
    const result = await mutate(doc)
    writeDocument(file, doc)
    return result
  })
  const settled = run.then(() => undefined, () => undefined)
  chains.set(file, settled)
  return run
}

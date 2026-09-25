import { lstatSync, readFileSync } from 'node:fs'

/**
 * Fold of a fixture or configured-home fleet ledger.
 * The ledger is not the worker list: this result never authorizes a worker,
 * a completion, or a healthy status. Callers keep the snapshot descriptors.
 */
export interface LedgerObservation {
  status: 'absent' | 'read' | 'failed'
  /** Ledger text and a failed read are not liveness. This is never `healthy`. */
  health: 'unknown'
  /** `done`, `merged`, and `cleaned_up` are not completion. This is never `complete`. */
  completion: 'unknown'
  duplicateRecords: number
  outOfOrder: boolean
  /** Tasks with no `task.dispatched`, plus known workers the file never mentions. */
  missingHistory: string[]
  /** Task ids that appear only in the ledger. They are not workers. */
  notWorkers: string[]
  diagnostic: string | null
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const EVENTS = new Set(['task.dispatched', 'task.status', 'task.pr_ready', 'task.merged', 'task.cleaned_up'])
const KEY_FIELDS = ['kind', 'project', 'harness', 'model', 'state', 'key', 'text', 'pr', 'via'] as const

export function absentObservation(knownIds: readonly string[] = []): LedgerObservation {
  return {
    status: 'absent',
    health: 'unknown',
    completion: 'unknown',
    duplicateRecords: 0,
    outOfOrder: false,
    missingHistory: [...knownIds].sort(byId),
    notWorkers: [],
    diagnostic: null,
  }
}

function failedObservation(diagnostic: string): LedgerObservation {
  return {
    status: 'failed',
    health: 'unknown',
    completion: 'unknown',
    duplicateRecords: 0,
    outOfOrder: false,
    missingHistory: [],
    notWorkers: [],
    diagnostic,
  }
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID.test(value) && !value.includes('..')
}

/** A record ends in a newline. A trailing partial line is not a record. */
function completeLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  lines.pop()
  return lines
}

function parseRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function canonical(record: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {
    event: record.event,
    task: record.task,
    ts: record.ts,
  }
  for (const key of KEY_FIELDS) {
    if (key in record) picked[key] = record[key]
  }
  return JSON.stringify(picked)
}

function terminalRecord(record: Record<string, unknown>): boolean {
  if (record.event === 'task.cleaned_up' || record.event === 'task.merged') return true
  return record.event === 'task.status' && record.state === 'done'
}

interface TaskFold {
  maxTs: number
  dispatched: boolean
  terminalAt: number | null
  keys: Set<string>
}

/** Fold ledger text. Duplicate and out-of-order lines are counted, not applied as status. */
export function foldLedger(text: string, knownIds: readonly string[]): LedgerObservation {
  const tasks = new Map<string, TaskFold>()
  let duplicateRecords = 0
  let outOfOrder = false

  for (const line of completeLines(text)) {
    const record = parseRecord(line)
    if (!record) continue
    if (typeof record.event !== 'string' || !EVENTS.has(record.event)) continue
    if (!isTaskId(record.task)) continue
    if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) continue

    let slot = tasks.get(record.task)
    if (!slot) {
      slot = { maxTs: Number.NEGATIVE_INFINITY, dispatched: false, terminalAt: null, keys: new Set() }
      tasks.set(record.task, slot)
    }
    const key = canonical(record)
    if (slot.keys.has(key)) {
      duplicateRecords += 1
      continue
    }
    slot.keys.add(key)
    const terminal = terminalRecord(record)
    if (record.ts < slot.maxTs) outOfOrder = true
    if (terminal && !slot.dispatched) outOfOrder = true
    if (slot.terminalAt !== null && record.ts > slot.terminalAt && !terminal) outOfOrder = true
    if (terminal) slot.terminalAt = slot.terminalAt === null ? record.ts : Math.max(slot.terminalAt, record.ts)
    if (record.ts > slot.maxTs) slot.maxTs = record.ts
    if (record.event === 'task.dispatched') slot.dispatched = true
  }

  const missing = new Set<string>()
  for (const [task, slot] of tasks) {
    if (!slot.dispatched) missing.add(task)
  }
  for (const id of knownIds) {
    if (!tasks.has(id)) missing.add(id)
  }
  const known = new Set(knownIds)
  const notWorkers = [...tasks.keys()].filter(task => !known.has(task)).sort(byId)

  return {
    status: 'read',
    health: 'unknown',
    completion: 'unknown',
    duplicateRecords,
    outOfOrder,
    missingHistory: [...missing].sort(byId),
    notWorkers,
    diagnostic: null,
  }
}

/**
 * Read one ledger file. Symlinks are not followed. A missing file is absent
 * history, not a healthy or complete fleet. Any other read problem is a failed
 * observation and still not healthy or complete.
 */
export function observeLedgerFile(file: string, knownIds: readonly string[]): LedgerObservation {
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return absentObservation(knownIds)
    return failedObservation('ledger could not be read')
  }
  if (info.isSymbolicLink()) return failedObservation('ledger path is a symlink')
  if (!info.isFile()) return failedObservation('ledger path is not a file')
  try {
    return foldLedger(readFileSync(file, 'utf8'), knownIds)
  } catch {
    return failedObservation('ledger could not be read')
  }
}

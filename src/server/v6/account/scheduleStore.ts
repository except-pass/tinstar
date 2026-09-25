import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../configRoot'
import type { ScheduleTask } from '../../../v6/account/drift'
import { isRecord } from '../../../v6/contract/result'

export const SCHEDULE_SCHEMA = 'tinstar.v6.account.schedule/1' as const

export interface ScheduleDoc {
  schema: typeof SCHEDULE_SCHEMA
  tasks: Record<string, ScheduleTask>
}

export function defaultScheduleFile(): string {
  return join(getConfigRoot(), 'v6', 'account', 'schedule.json')
}

export function emptySchedule(): ScheduleDoc {
  return { schema: SCHEDULE_SCHEMA, tasks: {} }
}

function taskFrom(raw: unknown): ScheduleTask | null {
  if (!isRecord(raw)) return null
  if (typeof raw.taskId !== 'string' || typeof raw.plannedMs !== 'number' || typeof raw.elapsedMs !== 'number') return null
  if (typeof raw.startedAt !== 'string' || typeof raw.retryCount !== 'number') return null
  if (typeof raw.activity !== 'string' || typeof raw.evidence !== 'string' || typeof raw.explanation !== 'string') return null
  const lastProgress = raw.lastProgress
  const progressOk = typeof lastProgress === 'string'
    || (isRecord(lastProgress) && lastProgress.unknown === true)
  if (!progressOk) return null
  return {
    taskId: raw.taskId,
    plannedMs: raw.plannedMs,
    forecastMs: typeof raw.forecastMs === 'number' ? raw.forecastMs : null,
    startedAt: raw.startedAt,
    elapsedMs: raw.elapsedMs,
    retryCount: raw.retryCount,
    activity: raw.activity,
    lastProgress: lastProgress as ScheduleTask['lastProgress'],
    evidence: raw.evidence,
    explanation: raw.explanation,
    acknowledgedAt: typeof raw.acknowledgedAt === 'string' ? raw.acknowledgedAt : null,
  }
}

export function readSchedule(file: string): ScheduleDoc {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!isRecord(raw) || raw.schema !== SCHEDULE_SCHEMA || !isRecord(raw.tasks)) return emptySchedule()
    const tasks: Record<string, ScheduleTask> = {}
    for (const [id, value] of Object.entries(raw.tasks)) {
      const task = taskFrom(value)
      if (task) tasks[id] = task
    }
    return { schema: SCHEDULE_SCHEMA, tasks }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
    if (code === 'ENOENT') return emptySchedule()
    throw err
  }
}

function writeSchedule(file: string, doc: ScheduleDoc): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

const chains = new Map<string, Promise<unknown>>()

export function updateSchedule<T>(file: string, mutate: (doc: ScheduleDoc) => T): Promise<T> {
  const previous = chains.get(file) ?? Promise.resolve()
  const run = previous.then(() => {
    const doc = readSchedule(file)
    const result = mutate(doc)
    writeSchedule(file, doc)
    return result
  })
  chains.set(file, run.then(() => undefined, () => undefined))
  return run
}

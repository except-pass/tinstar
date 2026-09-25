import { INTENT_SCHEMA, parseAppliedReceipt, type IntentEnvelope } from '../../../v6/contract/intent'
import {
  T01_PROCESS_UNCLAIMED,
  emptyWorker,
  pendingDisposition,
  type AchievementRecord,
  type CurrentObjective,
  type LaunchRecord,
  type ObjectiveDocument,
  type StoredReceipt,
  type WorkerObjectiveRecord,
} from '../../../v6/objective/model'
import type { IntentSubmission } from './inbox'

export interface SetObjectiveInput {
  workerId: string
  requestId: string
  /** Revision the user saw. Null when the worker has no current objective. */
  revision: string | null
  text: string
  narrower: boolean
  parentTaskId: string | null
  planTaskLabel: string | null
  planTaskSource: 'plan-task' | null
  fixture: boolean
}

export interface AchieveInput {
  workerId: string
  requestId: string
  revision: string | null
}

export interface LaunchInput {
  requestId: string
  project: string
  objective: string
  sessionName: string | null
  fixture: boolean
}

export type MutateResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

type Submit = (raw: IntentEnvelope) => Promise<IntentSubmission>

function nextRevision(current: string | null): string {
  if (current && /^[0-9]+$/.test(current)) {
    const n = Number(current)
    if (Number.isSafeInteger(n)) return String(n + 1)
  }
  return '1'
}

async function safely(submit: Submit, envelope: IntentEnvelope): Promise<IntentSubmission> {
  try {
    return await submit(envelope)
  } catch (err) {
    return {
      requestId: envelope.requestId,
      noteId: null,
      disposition: 'failed',
      applied: false,
      announced: null,
      canReceive: null,
      exitCode: null,
      detail: err instanceof Error ? err.message : 'inbox failed',
      noteOutcome: null,
    }
  }
}

function transport(submission: IntentSubmission): Pick<CurrentObjective, 'disposition' | 'pending' | 'detail' | 'noteId'> {
  return {
    disposition: submission.disposition,
    pending: pendingDisposition(submission.disposition),
    detail: submission.detail,
    noteId: submission.noteId,
  }
}

export async function setObjective(
  doc: ObjectiveDocument,
  input: SetObjectiveInput,
  submit: Submit,
  now: string,
): Promise<MutateResult<WorkerObjectiveRecord>> {
  const known = doc.requests[input.requestId]
  if (known) {
    if (known.kind !== 'objective.set' || known.workerId !== input.workerId) {
      return { ok: false, status: 409, error: 'request id is already used' }
    }
    const existing = doc.workers[input.workerId]
    if (!existing?.current) return { ok: false, status: 409, error: 'request id is already used' }
    return { ok: true, data: existing }
  }

  const worker = doc.workers[input.workerId] ?? emptyWorker(input.workerId)
  const seen = worker.current?.revision ?? null
  if (input.revision !== seen) {
    return { ok: false, status: 409, error: 'revision does not match the objective on screen' }
  }

  const envelope: IntentEnvelope = {
    schema: INTENT_SCHEMA,
    kind: 'objective.set',
    requestId: input.requestId,
    revision: input.revision,
    anchor: { type: 'worker', ids: [input.workerId] },
    body: {
      workerId: input.workerId,
      text: input.text,
      narrower: input.narrower,
      parentTaskId: input.parentTaskId,
      planTaskLabel: input.planTaskLabel,
      planTaskSource: input.planTaskSource,
      fixture: input.fixture,
    },
  }
  const moved = transport(await safely(submit, envelope))
  const previous = worker.current
  const current: CurrentObjective = {
    revision: nextRevision(seen),
    text: input.text,
    setAt: now,
    requestId: input.requestId,
    ...moved,
    narrower: input.narrower,
    parentTaskId: input.parentTaskId,
    parentTaskCompletedAt: null,
    planProgress: null,
    planTaskLabel: input.planTaskLabel,
    planTaskSource: input.planTaskSource,
    fixture: input.fixture,
  }
  const record: WorkerObjectiveRecord = {
    workerId: input.workerId,
    current,
    history: previous
      ? [...worker.history, {
        revision: previous.revision,
        text: previous.text,
        setAt: previous.setAt,
        requestId: previous.requestId,
      }]
      : [...worker.history],
  }
  doc.workers[input.workerId] = record
  doc.requests[input.requestId] = { kind: 'objective.set', workerId: input.workerId }
  return { ok: true, data: record }
}

export interface AchievementResult {
  achievement: AchievementRecord
  objective: WorkerObjectiveRecord
}

export async function achieveObjective(
  doc: ObjectiveDocument,
  input: AchieveInput,
  submit: Submit,
  now: string,
): Promise<MutateResult<AchievementResult>> {
  const known = doc.requests[input.requestId]
  if (known) {
    if (known.kind !== 'thread.message' || known.workerId !== input.workerId) {
      return { ok: false, status: 409, error: 'request id is already used' }
    }
    const achievement = doc.achievements[input.requestId]
    const objective = doc.workers[input.workerId]
    if (!achievement || !objective) return { ok: false, status: 409, error: 'request id is already used' }
    return { ok: true, data: { achievement, objective } }
  }

  const objective = doc.workers[input.workerId] ?? emptyWorker(input.workerId)
  const current = objective.current
  if (!current) return { ok: false, status: 409, error: 'this worker has no current objective' }
  if (input.revision !== null && input.revision !== current.revision) {
    return { ok: false, status: 409, error: 'revision does not match the objective on screen' }
  }

  const envelope: IntentEnvelope = {
    schema: INTENT_SCHEMA,
    kind: 'thread.message',
    requestId: input.requestId,
    revision: current.revision,
    anchor: { type: 'worker', ids: [input.workerId] },
    body: {
      workerId: input.workerId,
      text: current.text,
      instruction: 'Achieve your objective',
      fixture: current.fixture,
    },
  }
  const moved = transport(await safely(submit, envelope))
  const achievement: AchievementRecord = {
    requestId: input.requestId,
    workerId: input.workerId,
    text: current.text,
    revision: current.revision,
    ...moved,
    at: now,
  }
  doc.achievements[input.requestId] = achievement
  doc.requests[input.requestId] = { kind: 'thread.message', workerId: input.workerId }
  return { ok: true, data: { achievement, objective } }
}

export async function requestLaunch(
  doc: ObjectiveDocument,
  input: LaunchInput,
  submit: Submit,
  now: string,
): Promise<MutateResult<LaunchRecord>> {
  const known = doc.requests[input.requestId]
  if (known) {
    if (known.kind !== 'launch.request') {
      return { ok: false, status: 409, error: 'request id is already used' }
    }
    const existing = doc.launches[input.requestId]
    if (!existing) return { ok: false, status: 409, error: 'request id is already used' }
    return { ok: true, data: existing }
  }

  const envelope: IntentEnvelope = {
    schema: INTENT_SCHEMA,
    kind: 'launch.request',
    requestId: input.requestId,
    revision: null,
    anchor: { type: 'selection', ids: [input.project] },
    body: {
      project: input.project,
      objective: input.objective,
      sessionName: input.sessionName,
      fixture: input.fixture,
    },
  }
  const moved = transport(await safely(submit, envelope))
  const row: LaunchRecord = {
    requestId: input.requestId,
    project: input.project,
    objective: input.objective,
    sessionName: input.sessionName,
    status: 'pending',
    processCreated: false,
    disposition: moved.disposition,
    pending: true,
    detail: moved.detail,
    noteId: moved.noteId,
    createdAt: now,
    fixture: input.fixture,
    processClaim: T01_PROCESS_UNCLAIMED,
  }
  doc.launches[input.requestId] = row
  doc.requests[input.requestId] = { kind: 'launch.request', workerId: null }
  return { ok: true, data: row }
}

/** A receipt moves transport state. It does not complete a parent task or write plan progress. */
export function applyReceipt(doc: ObjectiveDocument, raw: unknown, now: string): MutateResult<StoredReceipt> {
  const parsed = parseAppliedReceipt(raw)
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.diagnostic }
  const receipt = parsed.value
  const existing = doc.receipts[receipt.requestId]
  if (existing) {
    if (existing.outcome !== receipt.outcome) {
      return { ok: false, status: 409, error: 'this request already has a receipt' }
    }
    return { ok: true, data: existing }
  }
  const pointer = doc.requests[receipt.requestId]
  if (!pointer) return { ok: false, status: 404, error: 'no intent matches this request id' }

  const stored: StoredReceipt = {
    requestId: receipt.requestId,
    outcome: receipt.outcome,
    detail: receipt.detail,
    at: now,
  }
  doc.receipts[receipt.requestId] = stored

  if (pointer.kind === 'objective.set' && pointer.workerId) {
    const worker = doc.workers[pointer.workerId]
    if (worker?.current?.requestId === receipt.requestId) {
      worker.current = {
        ...worker.current,
        disposition: receipt.outcome,
        pending: false,
        detail: receipt.detail,
        parentTaskCompletedAt: null,
        planProgress: null,
      }
    }
  }
  if (pointer.kind === 'thread.message') {
    const achievement = doc.achievements[receipt.requestId]
    if (achievement) {
      doc.achievements[receipt.requestId] = {
        ...achievement,
        disposition: receipt.outcome,
        pending: false,
        detail: receipt.detail,
      }
    }
  }
  if (pointer.kind === 'launch.request') {
    const launch = doc.launches[receipt.requestId]
    if (launch) {
      doc.launches[receipt.requestId] = {
        ...launch,
        disposition: receipt.outcome,
        pending: true,
        status: 'pending',
        processCreated: false,
        processClaim: T01_PROCESS_UNCLAIMED,
        detail: receipt.detail,
      }
    }
  }
  return { ok: true, data: stored }
}

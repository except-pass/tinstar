import { INTENT_SCHEMA, type IntentEnvelope, type IntentKind } from '../contract/intent'
import { isRecord, parsed, rejected, type ParseResult } from '../contract/result'
import type {
  Column,
  Dependency,
  Epic,
  Initiative,
  LaunchAssociation,
  PendingIntent,
  PortfolioDoc,
  Proposal,
  TaskRecord,
} from './types'
import { PORTFOLIO_SCHEMA } from './types'

const REFUSED_KEYS = new Set(['command', 'shell', 'argv', 'tmux'])

export function emptyPortfolio(): PortfolioDoc {
  return {
    schema: PORTFOLIO_SCHEMA,
    fixture: false,
    columns: seedColumns(),
    epics: [],
    initiatives: [],
    tasks: [],
    dependencies: [],
    launches: [],
    pending: [],
  }
}

/** Editable example columns. Nothing here treats a name as completion. */
export function seedColumns(): Column[] {
  return [
    { id: 'col-inbox', name: 'Inbox', description: 'Captured, not started', order: 0, revision: '1' },
    { id: 'col-shaping', name: 'Shaping', description: 'Scope is still moving', order: 1, revision: '1' },
    { id: 'col-building', name: 'Building', description: 'Implementation is underway', order: 2, revision: '1' },
    { id: 'col-review', name: 'Review', description: 'Waiting on a look', order: 3, revision: '1' },
  ]
}

export function bumpRevision(revision: string): string {
  const value = Number(revision)
  if (Number.isInteger(value) && value >= 0 && String(value) === revision) return String(value + 1)
  return `${revision}+1`
}

export function requestIdAllowed(id: string): boolean {
  if (id.length === 0 || id.length > 128 || id.startsWith('.')) return false
  return /^[A-Za-z0-9._:-]+$/.test(id)
}

export function containsRefusedKey(value: unknown, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(item => containsRefusedKey(item, depth + 1))
  return Object.entries(value as Record<string, unknown>).some(([key, inner]) => (
    REFUSED_KEYS.has(key) || containsRefusedKey(inner, depth + 1)
  ))
}

function text(raw: unknown, field: string): ParseResult<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return rejected(`${field} must be a non-empty string`)
  return parsed(raw.trim())
}

function oneProject(raw: unknown): ParseResult<string> {
  if (Array.isArray(raw)) return rejected('a task has exactly one project')
  return text(raw, 'project')
}

function idList(raw: unknown, field: string): ParseResult<string[]> {
  if (!Array.isArray(raw)) return rejected(`${field} must be a list of ids`)
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) return rejected(`${field} must be non-empty strings`)
    ids.push(item)
  }
  return parsed(ids)
}

/** Missing, blank, and null all mean the ancestor was not supplied. */
function suppliedId(body: Record<string, unknown>, key: string): ParseResult<string | null> {
  if (!(key in body) || body[key] === null || body[key] === '') return parsed(null)
  if (typeof body[key] !== 'string') return rejected(`${key} must be a string or null`)
  return parsed(body[key])
}

function anchored(envelope: IntentEnvelope, id: string): ParseResult<true> {
  if (!envelope.anchor.ids.includes(id)) return rejected('anchor does not include the target')
  return parsed(true)
}

function columnOps(op: string): boolean {
  return op === 'rename' || op === 'reorder' || op === 'create'
}

function portfolioOps(op: string): boolean {
  return op === 'move' || op === 'set-completed' || op === 'create-epic' || op === 'upsert-initiative'
    || op === 'set-epic-initiative' || op === 'upsert-task' || op === 'add-dependency'
}

export function proposalFromIntent(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  if (containsRefusedKey(envelope) || containsRefusedKey(envelope.body)) {
    return rejected('command, shell, and tmux fields are not accepted')
  }
  if (envelope.kind === 'launch.request') return launchProposal(doc, envelope)
  const op = envelope.body.op
  if (typeof op !== 'string') return rejected('body.op must be a string')
  if (envelope.kind === 'column.mutate' && !columnOps(op)) return rejected('column.mutate does not do that')
  if (envelope.kind === 'portfolio.mutate' && !portfolioOps(op)) return rejected('portfolio.mutate does not do that')
  if (envelope.kind !== 'column.mutate' && envelope.kind !== 'portfolio.mutate') {
    return rejected('kind is not a portfolio intent')
  }
  switch (op) {
    case 'rename': return renameProposal(doc, envelope)
    case 'reorder': return reorderProposal(doc, envelope)
    case 'create': return createColumnProposal(doc, envelope)
    case 'move': return moveProposal(doc, envelope)
    case 'set-completed': return completeProposal(doc, envelope)
    case 'create-epic': return createEpicProposal(doc, envelope)
    case 'upsert-initiative': return initiativeProposal(doc, envelope)
    case 'set-epic-initiative': return setEpicInitiativeProposal(doc, envelope)
    case 'upsert-task': return taskProposal(doc, envelope)
    case 'add-dependency': return dependencyProposal(envelope)
    default: return rejected('unknown portfolio operation')
  }
}

function renameProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  const columnId = text(envelope.body.columnId, 'columnId')
  if (!columnId.ok) return columnId
  const column = doc.columns.find(item => item.id === columnId.value)
  if (!column) return rejected('column not found')
  const anchor = anchored(envelope, column.id)
  if (!anchor.ok) return anchor
  const name = text(envelope.body.name, 'name')
  if (!name.ok) return name
  const description = 'description' in envelope.body && envelope.body.description !== undefined
    ? envelope.body.description
    : column.description
  if (typeof description !== 'string') return rejected('description must be a string')
  return parsed({ op: 'rename-column', columnId: column.id, name: name.value, description })
}

function reorderProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  const columnId = text(envelope.body.columnId, 'columnId')
  if (!columnId.ok) return columnId
  const column = doc.columns.find(item => item.id === columnId.value)
  if (!column) return rejected('column not found')
  const anchor = anchored(envelope, column.id)
  if (!anchor.ok) return anchor
  if (typeof envelope.body.order !== 'number' || !Number.isFinite(envelope.body.order)) {
    return rejected('order must be a number')
  }
  return parsed({ op: 'reorder-column', columnId: column.id, order: envelope.body.order })
}

function createColumnProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  const id = text(envelope.body.id, 'id')
  if (!id.ok) return id
  if (doc.columns.some(item => item.id === id.value)) return rejected('column already exists')
  const anchor = anchored(envelope, id.value)
  if (!anchor.ok) return anchor
  const name = text(envelope.body.name, 'name')
  if (!name.ok) return name
  if (typeof envelope.body.description !== 'string') return rejected('description must be a string')
  if (typeof envelope.body.order !== 'number' || !Number.isFinite(envelope.body.order)) {
    return rejected('order must be a number')
  }
  return parsed({
    op: 'create-column',
    column: {
      id: id.value,
      name: name.value,
      description: envelope.body.description,
      order: envelope.body.order,
      revision: '1',
    },
  })
}

function moveProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  const epicId = text(envelope.body.epicId, 'epicId')
  if (!epicId.ok) return epicId
  const epic = doc.epics.find(item => item.id === epicId.value)
  if (!epic) return rejected('epic not found')
  const anchor = anchored(envelope, epic.id)
  if (!anchor.ok) return anchor
  const toColumnId = text(envelope.body.toColumnId, 'toColumnId')
  if (!toColumnId.ok) return toColumnId
  if (!doc.columns.some(item => item.id === toColumnId.value)) return rejected('column not found')
  const order = typeof envelope.body.order === 'number' && Number.isFinite(envelope.body.order)
    ? envelope.body.order
    : nextOrder(doc, toColumnId.value)
  return parsed({ op: 'move', epicId: epic.id, toColumnId: toColumnId.value, order })
}

function completeProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  const epicId = text(envelope.body.epicId, 'epicId')
  if (!epicId.ok) return epicId
  const epic = doc.epics.find(item => item.id === epicId.value)
  if (!epic) return rejected('epic not found')
  const anchor = anchored(envelope, epic.id)
  if (!anchor.ok) return anchor
  if (!('completedAt' in envelope.body)) return rejected('completedAt is required')
  const completedAt = envelope.body.completedAt
  if (completedAt !== null && (typeof completedAt !== 'string' || completedAt.length === 0)) {
    return rejected('completedAt must be a timestamp or null')
  }
  return parsed({ op: 'set-completed', epicId: epic.id, completedAt })
}

function createEpicProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  const id = text(envelope.body.id, 'id')
  if (!id.ok) return id
  if (doc.epics.some(item => item.id === id.value)) return rejected('epic already exists')
  const anchor = anchored(envelope, id.value)
  if (!anchor.ok) return anchor
  const title = text(envelope.body.title, 'title')
  if (!title.ok) return title
  const columnId = text(envelope.body.columnId, 'columnId')
  if (!columnId.ok) return columnId
  if (!doc.columns.some(item => item.id === columnId.value)) return rejected('column not found')
  const initiativeId = suppliedId(envelope.body, 'initiativeId')
  if (!initiativeId.ok) return initiativeId
  if (initiativeId.value && !doc.initiatives.some(item => item.id === initiativeId.value)) {
    return rejected('initiative not found')
  }
  const planSlug = suppliedId(envelope.body, 'planSlug')
  if (!planSlug.ok) return planSlug
  const order = typeof envelope.body.order === 'number' && Number.isFinite(envelope.body.order)
    ? envelope.body.order
    : nextOrder(doc, columnId.value)
  return parsed({
    op: 'create-epic',
    epic: {
      id: id.value,
      title: title.value,
      columnId: columnId.value,
      initiativeId: initiativeId.value,
      planSlug: planSlug.value,
      completedAt: null,
      order,
      revision: '1',
    },
  })
}

function initiativeProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  const id = text(envelope.body.id, 'id')
  if (!id.ok) return id
  const anchor = anchored(envelope, id.value)
  if (!anchor.ok) return anchor
  const name = text(envelope.body.name, 'name')
  if (!name.ok) return name
  const epicIds = idList(envelope.body.epicIds, 'epicIds')
  if (!epicIds.ok) return epicIds
  const projectIds = idList(envelope.body.projectIds, 'projectIds')
  if (!projectIds.ok) return projectIds
  for (const epicId of epicIds.value) {
    if (!doc.epics.some(item => item.id === epicId)) return rejected('epic not found')
  }
  const existing = doc.initiatives.find(item => item.id === id.value)
  return parsed({
    op: 'upsert-initiative',
    initiative: {
      id: id.value,
      name: name.value,
      epicIds: epicIds.value,
      projectIds: projectIds.value,
      revision: existing?.revision ?? '1',
    },
  })
}

function setEpicInitiativeProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  const epicId = text(envelope.body.epicId, 'epicId')
  if (!epicId.ok) return epicId
  if (!doc.epics.some(item => item.id === epicId.value)) return rejected('epic not found')
  const anchor = anchored(envelope, epicId.value)
  if (!anchor.ok) return anchor
  const initiativeId = suppliedId(envelope.body, 'initiativeId')
  if (!initiativeId.ok) return initiativeId
  if (initiativeId.value && !doc.initiatives.some(item => item.id === initiativeId.value)) {
    return rejected('initiative not found')
  }
  return parsed({ op: 'set-epic-initiative', epicId: epicId.value, initiativeId: initiativeId.value })
}

function taskProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  if ('projects' in envelope.body || 'dependencyIds' in envelope.body || 'dependencies' in envelope.body) {
    return rejected('a task has exactly one project and dependencies are separate ids')
  }
  const id = text(envelope.body.id, 'id')
  if (!id.ok) return id
  const anchor = anchored(envelope, id.value)
  if (!anchor.ok) return anchor
  const project = oneProject(envelope.body.project)
  if (!project.ok) return project
  const epicId = suppliedId(envelope.body, 'epicId')
  if (!epicId.ok) return epicId
  const planId = suppliedId(envelope.body, 'planId')
  if (!planId.ok) return planId
  const initiativeId = suppliedId(envelope.body, 'initiativeId')
  if (!initiativeId.ok) return initiativeId
  if (epicId.value && !doc.epics.some(item => item.id === epicId.value)) return rejected('epic not found')
  const existing = doc.tasks.find(item => item.id === id.value)
  return parsed({
    op: 'upsert-task',
    task: {
      id: id.value,
      project: project.value,
      epicId: epicId.value,
      planId: planId.value,
      initiativeId: initiativeId.value,
      revision: existing?.revision ?? '1',
    },
  })
}

function dependencyProposal(envelope: IntentEnvelope): ParseResult<Proposal> {
  const id = text(envelope.body.id, 'id')
  if (!id.ok) return id
  const anchor = anchored(envelope, id.value)
  if (!anchor.ok) return anchor
  const fromId = text(envelope.body.fromId, 'fromId')
  if (!fromId.ok) return fromId
  const toId = text(envelope.body.toId, 'toId')
  if (!toId.ok) return toId
  if (fromId.value === toId.value) return rejected('dependency needs two ids')
  return parsed({ op: 'add-dependency', dependency: { id: id.value, fromId: fromId.value, toId: toId.value } })
}

/**
 * Persist only ancestors the launch body supplied.
 * The project is the task's single project when that task already exists.
 * An epic's initiative is never copied in.
 */
function launchProposal(doc: PortfolioDoc, envelope: IntentEnvelope): ParseResult<Proposal> {
  if ('projects' in envelope.body) return rejected('a task has exactly one project')
  if ('op' in envelope.body && envelope.body.op !== 'launch') return rejected('launch.request does not do that')
  const taskId = text(envelope.body.taskId, 'taskId')
  if (!taskId.ok) return taskId
  const anchor = anchored(envelope, taskId.value)
  if (!anchor.ok) return anchor
  const task = doc.tasks.find(item => item.id === taskId.value)
  let project: string
  if (task) {
    if ('project' in envelope.body && envelope.body.project !== undefined && envelope.body.project !== task.project) {
      return rejected('launch uses the task project')
    }
    project = task.project
  } else {
    const parsedProject = oneProject(envelope.body.project)
    if (!parsedProject.ok) return parsedProject
    project = parsedProject.value
  }
  const planId = suppliedId(envelope.body, 'planId')
  if (!planId.ok) return planId
  const epicId = suppliedId(envelope.body, 'epicId')
  if (!epicId.ok) return epicId
  const initiativeId = suppliedId(envelope.body, 'initiativeId')
  if (!initiativeId.ok) return initiativeId
  return parsed({
    op: 'launch',
    launch: {
      requestId: envelope.requestId,
      taskId: taskId.value,
      project,
      planId: planId.value,
      epicId: epicId.value,
      initiativeId: initiativeId.value,
    },
  })
}

function nextOrder(doc: PortfolioDoc, columnId: string): number {
  const orders = doc.epics.filter(epic => epic.columnId === columnId).map(epic => epic.order)
  if (orders.length === 0) return 0
  return Math.max(...orders) + 1
}

export function currentRevision(doc: PortfolioDoc, proposal: Proposal): string | null {
  switch (proposal.op) {
    case 'move':
    case 'set-completed':
    case 'set-epic-initiative':
      return doc.epics.find(epic => epic.id === proposal.epicId)?.revision ?? null
    case 'rename-column':
    case 'reorder-column':
      return doc.columns.find(column => column.id === proposal.columnId)?.revision ?? null
    case 'upsert-initiative':
      return doc.initiatives.find(item => item.id === proposal.initiative.id)?.revision ?? null
    case 'upsert-task':
      return doc.tasks.find(task => task.id === proposal.task.id)?.revision ?? null
    case 'launch':
      return doc.tasks.find(task => task.id === proposal.launch.taskId)?.revision ?? null
    case 'create-epic':
    case 'create-column':
    case 'add-dependency':
      return null
  }
}

export function isStale(doc: PortfolioDoc, revision: string | null, proposal: Proposal): boolean {
  if (revision === null) return false
  const current = currentRevision(doc, proposal)
  if (current === null) return false
  return current !== revision
}

export interface SubmissionInput {
  requestId: string
  noteId: string | null
  disposition: string
  applied: boolean
  detail: string
  exitCode: number | null
  canReceive: boolean | 'unknown' | null
  noteOutcome: string | null
}

function classify(submission: SubmissionInput): { disposition: PendingIntent['disposition']; detail: string } {
  if (submission.exitCode === 1 || submission.disposition === 'failed') {
    return { disposition: 'failed', detail: 'Nothing saved' }
  }
  if (submission.canReceive !== true) return { disposition: 'not-receivable', detail: 'Not receivable' }
  if (submission.exitCode === 3 || submission.disposition === 'saved-unannounced') {
    return { disposition: 'saved-unannounced', detail: 'Saved, not announced' }
  }
  if (submission.disposition === 'queued') return { disposition: 'queued', detail: 'Pending' }
  return { disposition: 'failed', detail: submission.detail || 'Not applied' }
}

function isPortfolioKind(kind: IntentKind): kind is PendingIntent['kind'] {
  return kind === 'portfolio.mutate' || kind === 'column.mutate' || kind === 'launch.request'
}

/** One projection row per request id. A retry updates that row and does not apply. */
export function recordSubmission(
  doc: PortfolioDoc,
  envelope: IntentEnvelope,
  proposal: Proposal,
  submission: SubmissionInput,
): PortfolioDoc {
  if (!isPortfolioKind(envelope.kind)) return doc
  const transport = classify(submission)
  const existing = doc.pending.find(item => item.requestId === envelope.requestId)
  if (existing) {
    return {
      ...doc,
      pending: doc.pending.map(item => {
        if (item.requestId !== envelope.requestId) return item
        if (item.applied) {
          return { ...item, noteId: submission.noteId ?? item.noteId, noteOutcome: submission.noteOutcome }
        }
        return {
          ...item,
          noteId: submission.noteId ?? item.noteId,
          disposition: transport.disposition,
          detail: transport.detail,
          exitCode: submission.exitCode,
          canReceive: submission.canReceive,
          noteOutcome: submission.noteOutcome,
          applied: false,
        }
      }),
    }
  }
  const row: PendingIntent = {
    requestId: envelope.requestId,
    noteId: submission.noteId,
    kind: envelope.kind,
    revision: envelope.revision,
    disposition: transport.disposition,
    detail: transport.detail,
    exitCode: submission.exitCode,
    canReceive: submission.canReceive,
    noteOutcome: submission.noteOutcome,
    proposal,
    applied: false,
  }
  return { ...doc, pending: [...doc.pending, row] }
}

function replaceEpic(doc: PortfolioDoc, epicId: string, next: (epic: Epic) => Epic): Epic[] | null {
  if (!doc.epics.some(epic => epic.id === epicId)) return null
  return doc.epics.map(epic => epic.id === epicId ? next(epic) : epic)
}

export function applyProposal(doc: PortfolioDoc, proposal: Proposal): { doc: PortfolioDoc; ok: boolean; detail: string } {
  switch (proposal.op) {
    case 'move': {
      if (!doc.columns.some(column => column.id === proposal.toColumnId)) {
        return { doc, ok: false, detail: 'column not found' }
      }
      const epics = replaceEpic(doc, proposal.epicId, epic => ({
        ...epic,
        columnId: proposal.toColumnId,
        order: proposal.order,
        revision: bumpRevision(epic.revision),
        completedAt: epic.completedAt,
      }))
      if (!epics) return { doc, ok: false, detail: 'epic not found' }
      return { doc: { ...doc, epics }, ok: true, detail: 'moved' }
    }
    case 'set-completed': {
      const epics = replaceEpic(doc, proposal.epicId, epic => ({
        ...epic,
        completedAt: proposal.completedAt,
        revision: bumpRevision(epic.revision),
      }))
      if (!epics) return { doc, ok: false, detail: 'epic not found' }
      return { doc: { ...doc, epics }, ok: true, detail: proposal.completedAt ? 'completed' : 'reopened' }
    }
    case 'create-epic': {
      if (doc.epics.some(epic => epic.id === proposal.epic.id)) return { doc, ok: false, detail: 'epic already exists' }
      return { doc: { ...doc, epics: [...doc.epics, { ...proposal.epic, completedAt: null }] }, ok: true, detail: 'created' }
    }
    case 'rename-column': {
      if (!doc.columns.some(column => column.id === proposal.columnId)) return { doc, ok: false, detail: 'column not found' }
      return {
        doc: {
          ...doc,
          columns: doc.columns.map(column => column.id === proposal.columnId
            ? { ...column, name: proposal.name, description: proposal.description, revision: bumpRevision(column.revision) }
            : column),
        },
        ok: true,
        detail: 'renamed',
      }
    }
    case 'reorder-column': {
      if (!doc.columns.some(column => column.id === proposal.columnId)) return { doc, ok: false, detail: 'column not found' }
      return {
        doc: {
          ...doc,
          columns: doc.columns.map(column => column.id === proposal.columnId
            ? { ...column, order: proposal.order, revision: bumpRevision(column.revision) }
            : column),
        },
        ok: true,
        detail: 'reordered',
      }
    }
    case 'create-column': {
      if (doc.columns.some(column => column.id === proposal.column.id)) return { doc, ok: false, detail: 'column already exists' }
      return { doc: { ...doc, columns: [...doc.columns, proposal.column] }, ok: true, detail: 'created' }
    }
    case 'upsert-initiative': {
      const existing = doc.initiatives.find(item => item.id === proposal.initiative.id)
      const initiative: Initiative = {
        ...proposal.initiative,
        revision: existing ? bumpRevision(existing.revision) : '1',
      }
      const listed = new Set(initiative.epicIds)
      const initiatives = existing
        ? doc.initiatives.map(item => item.id === initiative.id ? initiative : item)
        : [...doc.initiatives, initiative]
      const epics = doc.epics.map(epic => {
        if (listed.has(epic.id)) {
          return epic.initiativeId === initiative.id ? epic : { ...epic, initiativeId: initiative.id, revision: bumpRevision(epic.revision) }
        }
        if (epic.initiativeId === initiative.id) return { ...epic, initiativeId: null, revision: bumpRevision(epic.revision) }
        return epic
      })
      return { doc: { ...doc, initiatives, epics, dependencies: doc.dependencies }, ok: true, detail: 'initiative saved' }
    }
    case 'set-epic-initiative': {
      const epics = replaceEpic(doc, proposal.epicId, epic => ({
        ...epic,
        initiativeId: proposal.initiativeId,
        revision: bumpRevision(epic.revision),
      }))
      if (!epics) return { doc, ok: false, detail: 'epic not found' }
      const initiatives = doc.initiatives.map(item => {
        const has = item.epicIds.includes(proposal.epicId)
        if (item.id === proposal.initiativeId && !has) return { ...item, epicIds: [...item.epicIds, proposal.epicId] }
        if (has && item.id !== proposal.initiativeId) return { ...item, epicIds: item.epicIds.filter(id => id !== proposal.epicId) }
        return item
      })
      return { doc: { ...doc, epics, initiatives, dependencies: doc.dependencies }, ok: true, detail: 'initiative set' }
    }
    case 'upsert-task': {
      const existing = doc.tasks.find(task => task.id === proposal.task.id)
      const task: TaskRecord = { ...proposal.task, revision: existing ? bumpRevision(existing.revision) : '1' }
      const tasks = existing
        ? doc.tasks.map(item => item.id === task.id ? task : item)
        : [...doc.tasks, task]
      return { doc: { ...doc, tasks, dependencies: doc.dependencies }, ok: true, detail: 'task saved' }
    }
    case 'add-dependency': {
      if (doc.dependencies.some(item => item.id === proposal.dependency.id)) {
        return { doc, ok: true, detail: 'dependency already recorded' }
      }
      return { doc: { ...doc, dependencies: [...doc.dependencies, proposal.dependency] }, ok: true, detail: 'dependency added' }
    }
    case 'launch': {
      if (doc.launches.some(item => item.requestId === proposal.launch.requestId)) {
        return { doc, ok: true, detail: 'launch already recorded' }
      }
      const launch: LaunchAssociation = { ...proposal.launch }
      return { doc: { ...doc, launches: [...doc.launches, launch] }, ok: true, detail: 'launch recorded' }
    }
  }
}

function patchPending(doc: PortfolioDoc, requestId: string, patch: Partial<PendingIntent>): PortfolioDoc {
  return {
    ...doc,
    pending: doc.pending.map(item => item.requestId === requestId ? { ...item, ...patch } : item),
  }
}

export function reconcileReceipt(
  doc: PortfolioDoc,
  requestId: string,
  receipt: { requestId: string; outcome: 'applied' | 'rejected'; detail: string } | null,
): { doc: PortfolioDoc; status: 'pending' | 'applied' | 'rejected' | 'stale' | 'missing' | 'mismatch'; detail: string } {
  const pending = doc.pending.find(item => item.requestId === requestId)
  if (!pending) return { doc, status: 'missing', detail: 'No pending intent' }
  if (pending.applied) return { doc, status: 'applied', detail: pending.detail }
  if (!receipt) return { doc, status: 'pending', detail: pending.detail }
  if (receipt.requestId !== requestId) return { doc, status: 'mismatch', detail: 'Receipt does not match the request' }
  if (receipt.outcome === 'rejected') {
    const detail = receipt.detail || 'Rejected'
    return { doc: patchPending(doc, requestId, { disposition: 'rejected', detail, applied: false }), status: 'rejected', detail }
  }
  if (isStale(doc, pending.revision, pending.proposal)) {
    return {
      doc: patchPending(doc, requestId, { disposition: 'stale', detail: 'Stale edit', applied: false }),
      status: 'stale',
      detail: 'Stale edit',
    }
  }
  const applied = applyProposal(doc, pending.proposal)
  if (!applied.ok) {
    return {
      doc: patchPending(doc, requestId, { disposition: 'rejected', detail: applied.detail, applied: false }),
      status: 'rejected',
      detail: applied.detail,
    }
  }
  return {
    doc: patchPending(applied.doc, requestId, { disposition: 'applied', detail: receipt.detail, applied: true }),
    status: 'applied',
    detail: receipt.detail,
  }
}

export function pendingLabel(pending: PendingIntent): string {
  if (pending.applied) return 'Applied'
  switch (pending.disposition) {
    case 'queued': return 'Pending'
    case 'saved-unannounced': return 'Saved, not announced'
    case 'not-receivable': return 'Not receivable'
    case 'stale': return 'Stale edit'
    case 'rejected': return pending.detail || 'Rejected'
    case 'failed': return pending.detail || 'Nothing saved'
    default: return pending.detail || 'Not applied'
  }
}

export function displayColumnId(doc: PortfolioDoc, epicId: string): string {
  const epic = doc.epics.find(item => item.id === epicId)
  if (!epic) return ''
  for (let index = doc.pending.length - 1; index >= 0; index -= 1) {
    const pending = doc.pending[index]
    if (!pending || pending.applied || pending.disposition !== 'queued') continue
    if (pending.proposal.op === 'move' && pending.proposal.epicId === epicId) return pending.proposal.toColumnId
  }
  return epic.columnId
}

export function sortedColumns(doc: PortfolioDoc): Column[] {
  return [...doc.columns].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

function baseEnvelope(
  kind: PendingIntent['kind'],
  requestId: string,
  revision: string | null,
  anchorType: IntentEnvelope['anchor']['type'],
  id: string,
  body: Record<string, unknown>,
): IntentEnvelope {
  return {
    schema: INTENT_SCHEMA,
    kind,
    requestId,
    revision,
    anchor: { type: anchorType, ids: [id] },
    body,
  }
}

export function moveEnvelope(epic: Epic, toColumnId: string, requestId: string, order: number): IntentEnvelope {
  return baseEnvelope('portfolio.mutate', requestId, epic.revision, 'epic', epic.id, {
    op: 'move',
    epicId: epic.id,
    toColumnId,
    order,
  })
}

export function renameEnvelope(column: Column, name: string, description: string, requestId: string): IntentEnvelope {
  return baseEnvelope('column.mutate', requestId, column.revision, 'selection', column.id, {
    op: 'rename',
    columnId: column.id,
    name,
    description,
  })
}

export function completeEnvelope(epic: Epic, completedAt: string | null, requestId: string): IntentEnvelope {
  return baseEnvelope('portfolio.mutate', requestId, epic.revision, 'epic', epic.id, {
    op: 'set-completed',
    epicId: epic.id,
    completedAt,
  })
}

export function launchEnvelope(input: {
  taskId: string
  project: string
  requestId: string
  revision: string | null
  planId?: string | null
  epicId?: string | null
  initiativeId?: string | null
}): IntentEnvelope {
  const body: Record<string, unknown> = { taskId: input.taskId, project: input.project }
  if (input.planId) body.planId = input.planId
  if (input.epicId) body.epicId = input.epicId
  if (input.initiativeId) body.initiativeId = input.initiativeId
  return baseEnvelope('launch.request', input.requestId, input.revision, 'task', input.taskId, body)
}

export function taskEnvelope(input: {
  id: string
  project: string
  requestId: string
  revision: string | null
  epicId?: string | null
  planId?: string | null
  initiativeId?: string | null
}): IntentEnvelope {
  const body: Record<string, unknown> = { op: 'upsert-task', id: input.id, project: input.project }
  if (input.epicId) body.epicId = input.epicId
  if (input.planId) body.planId = input.planId
  if (input.initiativeId) body.initiativeId = input.initiativeId
  return baseEnvelope('portfolio.mutate', input.requestId, input.revision, 'task', input.id, body)
}

export function dependencyEnvelope(dependency: Dependency, requestId: string): IntentEnvelope {
  return baseEnvelope('portfolio.mutate', requestId, null, 'selection', dependency.id, {
    op: 'add-dependency',
    id: dependency.id,
    fromId: dependency.fromId,
    toId: dependency.toId,
  })
}

export function initiativeEnvelope(initiative: Omit<Initiative, 'revision'>, requestId: string, revision: string | null): IntentEnvelope {
  return baseEnvelope('portfolio.mutate', requestId, revision, 'selection', initiative.id, {
    op: 'upsert-initiative',
    id: initiative.id,
    name: initiative.name,
    epicIds: initiative.epicIds,
    projectIds: initiative.projectIds,
  })
}

export function createEpicEnvelope(input: {
  id: string
  title: string
  columnId: string
  requestId: string
  initiativeId?: string | null
  planSlug?: string | null
}): IntentEnvelope {
  const body: Record<string, unknown> = {
    op: 'create-epic',
    id: input.id,
    title: input.title,
    columnId: input.columnId,
  }
  if (input.initiativeId) body.initiativeId = input.initiativeId
  if (input.planSlug) body.planSlug = input.planSlug
  return baseEnvelope('portfolio.mutate', input.requestId, null, 'epic', input.id, body)
}

function stringOrNull(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function readColumn(raw: unknown): Column | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.description !== 'string') return null
  if (typeof raw.order !== 'number') return null
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    order: raw.order,
    revision: typeof raw.revision === 'string' && raw.revision.length > 0 ? raw.revision : '1',
  }
}

function readEpic(raw: unknown): Epic | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.columnId !== 'string') return null
  if (typeof raw.order !== 'number') return null
  return {
    id: raw.id,
    title: raw.title,
    columnId: raw.columnId,
    initiativeId: stringOrNull(raw.initiativeId),
    planSlug: stringOrNull(raw.planSlug),
    completedAt: stringOrNull(raw.completedAt),
    order: raw.order,
    revision: typeof raw.revision === 'string' && raw.revision.length > 0 ? raw.revision : '1',
  }
}

function readInitiative(raw: unknown): Initiative | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  const epicIds = idList(raw.epicIds, 'epicIds')
  const projectIds = idList(raw.projectIds, 'projectIds')
  if (!epicIds.ok || !projectIds.ok) return null
  return {
    id: raw.id,
    name: raw.name,
    epicIds: epicIds.value,
    projectIds: projectIds.value,
    revision: typeof raw.revision === 'string' && raw.revision.length > 0 ? raw.revision : '1',
  }
}

function readTask(raw: unknown): TaskRecord | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.project !== 'string' || Array.isArray(raw.project)) return null
  if (raw.project.length === 0) return null
  return {
    id: raw.id,
    project: raw.project,
    epicId: stringOrNull(raw.epicId),
    planId: stringOrNull(raw.planId),
    initiativeId: stringOrNull(raw.initiativeId),
    revision: typeof raw.revision === 'string' && raw.revision.length > 0 ? raw.revision : '1',
  }
}

function readDependency(raw: unknown): Dependency | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.fromId !== 'string' || typeof raw.toId !== 'string') return null
  return { id: raw.id, fromId: raw.fromId, toId: raw.toId }
}

function readLaunch(raw: unknown): LaunchAssociation | null {
  if (!isRecord(raw) || typeof raw.requestId !== 'string' || typeof raw.taskId !== 'string' || typeof raw.project !== 'string') return null
  return {
    requestId: raw.requestId,
    taskId: raw.taskId,
    project: raw.project,
    planId: stringOrNull(raw.planId),
    epicId: stringOrNull(raw.epicId),
    initiativeId: stringOrNull(raw.initiativeId),
  }
}

export function portfolioFromUnknown(raw: unknown): ParseResult<PortfolioDoc> {
  if (!isRecord(raw)) return rejected('portfolio must be an object')
  if (raw.schema !== PORTFOLIO_SCHEMA) return rejected(`schema must be ${PORTFOLIO_SCHEMA}`)
  if (!Array.isArray(raw.columns) || !Array.isArray(raw.epics)) return rejected('portfolio lists are missing')
  const columns: Column[] = []
  for (const item of raw.columns) {
    const column = readColumn(item)
    if (!column) return rejected('column is invalid')
    columns.push(column)
  }
  const epics: Epic[] = []
  for (const item of raw.epics) {
    const epic = readEpic(item)
    if (!epic) return rejected('epic is invalid')
    epics.push(epic)
  }
  const initiatives: Initiative[] = []
  for (const item of Array.isArray(raw.initiatives) ? raw.initiatives : []) {
    const initiative = readInitiative(item)
    if (!initiative) return rejected('initiative is invalid')
    initiatives.push(initiative)
  }
  const tasks: TaskRecord[] = []
  for (const item of Array.isArray(raw.tasks) ? raw.tasks : []) {
    const task = readTask(item)
    if (!task) return rejected('task is invalid')
    tasks.push(task)
  }
  const dependencies: Dependency[] = []
  for (const item of Array.isArray(raw.dependencies) ? raw.dependencies : []) {
    const dependency = readDependency(item)
    if (!dependency) return rejected('dependency is invalid')
    dependencies.push(dependency)
  }
  const launches: LaunchAssociation[] = []
  for (const item of Array.isArray(raw.launches) ? raw.launches : []) {
    const launch = readLaunch(item)
    if (!launch) return rejected('launch is invalid')
    launches.push(launch)
  }
  const pending: PendingIntent[] = []
  for (const item of Array.isArray(raw.pending) ? raw.pending : []) {
    if (!isRecord(item) || typeof item.requestId !== 'string' || !isRecord(item.proposal)) return rejected('pending intent is invalid')
    if (item.kind !== 'portfolio.mutate' && item.kind !== 'column.mutate' && item.kind !== 'launch.request') {
      return rejected('pending kind is invalid')
    }
    const kind = item.kind as PendingIntent['kind']
    pending.push({
      requestId: item.requestId,
      noteId: stringOrNull(item.noteId),
      kind,
      revision: typeof item.revision === 'string' ? item.revision : null,
      disposition: typeof item.disposition === 'string' ? item.disposition as PendingIntent['disposition'] : 'failed',
      detail: typeof item.detail === 'string' ? item.detail : '',
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
      canReceive: item.canReceive === true || item.canReceive === false || item.canReceive === 'unknown' ? item.canReceive : null,
      noteOutcome: stringOrNull(item.noteOutcome),
      proposal: item.proposal as Proposal,
      applied: item.applied === true,
    })
  }
  return parsed({
    schema: PORTFOLIO_SCHEMA,
    fixture: raw.fixture === true,
    columns,
    epics,
    initiatives,
    tasks,
    dependencies,
    launches,
    pending,
  })
}

/** Projection document for worker objectives and launch intents. */

export const OBJECTIVE_SCHEMA = 'tinstar.v6.objectives/1' as const

/** Inbox transport plus a later receipt. `applied` is never inferred from a saved note. */
export type ObjectiveDisposition =
  | 'queued'
  | 'saved-unannounced'
  | 'not-receivable'
  | 'failed'
  | 'applied'
  | 'rejected'

export const OBJECTIVE_DISPOSITIONS: readonly ObjectiveDisposition[] = [
  'queued',
  'saved-unannounced',
  'not-receivable',
  'failed',
  'applied',
  'rejected',
]

/**
 * T01's process half is unfinished on purpose. Launch stores an intent only.
 * This sentence is the claim the API, the panel, and the task report share.
 */
export const T01_PROCESS_UNCLAIMED =
  'T01\'s "a process was created" half is not claimed. The worker-process half is unfinished. No process was created.'

export interface ObjectiveRevision {
  revision: string
  text: string
  setAt: string
  requestId: string
}

export interface CurrentObjective extends ObjectiveRevision {
  disposition: ObjectiveDisposition
  /** Visible while the inbox intent has no receipt yet. */
  pending: boolean
  detail: string
  noteId: string | null
  narrower: boolean
  parentTaskId: string | null
  /** Always null. A worker objective never completes the parent task. */
  parentTaskCompletedAt: null
  /** Always null. This record never writes Stretch Plan progress. */
  planProgress: null
  planTaskLabel: string | null
  planTaskSource: 'plan-task' | null
  fixture: boolean
}

export interface WorkerObjectiveRecord {
  workerId: string
  current: CurrentObjective | null
  /** Older currents, oldest first. The last entry is the previous revision. */
  history: ObjectiveRevision[]
}

export interface LaunchRecord {
  requestId: string
  project: string
  objective: string
  sessionName: string | null
  status: 'pending'
  processCreated: false
  disposition: ObjectiveDisposition
  /** Stays pending: a receipt does not prove a worker process exists. */
  pending: true
  detail: string
  noteId: string | null
  createdAt: string
  fixture: boolean
  processClaim: typeof T01_PROCESS_UNCLAIMED
}

export interface AchievementRecord {
  requestId: string
  workerId: string
  text: string
  revision: string
  disposition: ObjectiveDisposition
  pending: boolean
  detail: string
  noteId: string | null
  at: string
}

export interface StoredReceipt {
  requestId: string
  outcome: 'applied' | 'rejected'
  detail: string
  at: string
}

export interface ObjectiveRequestPointer {
  kind: 'objective.set' | 'launch.request' | 'thread.message'
  workerId: string | null
}

export interface ObjectiveDocument {
  schema: typeof OBJECTIVE_SCHEMA
  workers: Record<string, WorkerObjectiveRecord>
  launches: Record<string, LaunchRecord>
  achievements: Record<string, AchievementRecord>
  receipts: Record<string, StoredReceipt>
  requests: Record<string, ObjectiveRequestPointer>
}

export function emptyDocument(): ObjectiveDocument {
  return {
    schema: OBJECTIVE_SCHEMA,
    workers: {},
    launches: {},
    achievements: {},
    receipts: {},
    requests: {},
  }
}

export function emptyWorker(workerId: string): WorkerObjectiveRecord {
  return { workerId, current: null, history: [] }
}

const DENIED_SESSIONS = new Set(['firstmate', 'serena-view', 'kd-live'])

/** Session label stored on a launch intent. Not passed to tmux. */
export function sessionNameRefusal(name: string): string | null {
  if (name.length === 0 || name.length > 80) return 'session name length is not allowed'
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'session name has control characters'
  if (/[\\/;&|$`<>]/.test(name)) return 'session name has a forbidden character'
  if (DENIED_SESSIONS.has(name)) return 'refused session'
  if (name.startsWith('v6view-') || name.startsWith('tsview-')) return 'refused session prefix'
  if ('v6view-'.startsWith(name) || 'tsview-'.startsWith(name)) {
    return 'session name would prefix-match view names'
  }
  return null
}

export function suggestSessionName(project: string): string {
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const base = slug || 'worker'
  let name = base.endsWith('-worker') ? base : `${base}-worker`
  if (name.length > 64) name = name.slice(0, 64).replace(/-+$/g, '')
  if (sessionNameRefusal(name)) name = `work-${base}`.slice(0, 64)
  return name
}

export function workerIdAllowed(id: string): boolean {
  if (id.length === 0 || id.length > 200) return false
  if (/[\u0000-\u001f\u007f]/.test(id)) return false
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false
  return true
}

export function requestIdAllowed(id: string): boolean {
  if (id.length === 0 || id.length > 128 || id.startsWith('.')) return false
  return /^[A-Za-z0-9._:-]+$/.test(id)
}

export function pendingDisposition(disposition: ObjectiveDisposition): boolean {
  return disposition === 'queued' || disposition === 'saved-unannounced' || disposition === 'not-receivable'
}

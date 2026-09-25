import { isRecord, parsed, rejected, type ParseResult } from './result'

export const WORKER_SOURCE = 'fm-fleet-snapshot' as const

/** Crew state from `current_state.state`. Not busy/idle. */
export const CREW_STATES = ['working', 'parked', 'done', 'blocked', 'paused', 'failed', 'unknown'] as const

export type CrewState = (typeof CREW_STATES)[number]

export interface WorkerDescriptor {
  source: typeof WORKER_SOURCE
  fixture: boolean
  id: string
  spawnGen: string | null
  project: string
  worktree: { path: string | null; present: boolean }
  backend: string
  endpoint: {
    target: string | null
    exists: boolean | null
    agentAlive: string
    status: string
  }
  crewState: CrewState
  observedAt: string
}

function asNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'string') return null
  return raw
}

/**
 * Build the browser descriptor from one snapshot task object.
 * `actions`, steer strings, and raw status text are never copied onto the result.
 * `fixture` is true only when the payload says so. A missing flag is not a fixture.
 */
export function parseWorkerDescriptor(raw: unknown): ParseResult<WorkerDescriptor> {
  if (!isRecord(raw)) return rejected('descriptor must be an object')
  if (typeof raw.id !== 'string' || raw.id.length === 0) return rejected('id must be a non-empty string')
  if (raw.spawn_gen !== undefined && raw.spawn_gen !== null && typeof raw.spawn_gen !== 'string') {
    return rejected('spawn_gen must be a string or null')
  }
  const project = typeof raw.project === 'string' ? raw.project : ''
  const paths = isRecord(raw.paths) ? raw.paths : {}
  const worktree = isRecord(paths.worktree) ? paths.worktree : {}
  const worktreePath = worktree.path === null || typeof worktree.path === 'string' ? (worktree.path ?? null) : null
  if (worktree.path !== undefined && worktree.path !== null && typeof worktree.path !== 'string') {
    return rejected('paths.worktree.path must be a string or null')
  }
  const present = worktree.present === true
  const backend = typeof raw.backend === 'string' && raw.backend.length > 0 ? raw.backend : ''
  if (!backend) return rejected('backend must be a non-empty string')
  const endpoint = isRecord(raw.endpoint) ? raw.endpoint : null
  if (!endpoint) return rejected('endpoint must be an object')
  const target = endpoint.target === null || typeof endpoint.target === 'string'
    ? (endpoint.target ?? null)
    : null
  if (endpoint.target !== undefined && endpoint.target !== null && typeof endpoint.target !== 'string') {
    return rejected('endpoint.target must be a string or null')
  }
  const exists = endpoint.exists === null || typeof endpoint.exists === 'boolean'
    ? endpoint.exists
    : null
  if (endpoint.exists !== undefined && endpoint.exists !== null && typeof endpoint.exists !== 'boolean') {
    return rejected('endpoint.exists must be a boolean or null')
  }
  const agentAlive = typeof endpoint.agent_alive === 'string' ? endpoint.agent_alive : 'unknown'
  const status = typeof endpoint.status === 'string' ? endpoint.status : 'unknown'
  const current = isRecord(raw.current_state) ? raw.current_state : null
  const crewRaw = current && typeof current.state === 'string' ? current.state : ''
  if (!(CREW_STATES as readonly string[]).includes(crewRaw)) {
    return rejected(`crew state '${crewRaw || '(missing)'}' is not a known crew state`)
  }
  const observedAt = current && typeof current.observed_at === 'string'
    ? current.observed_at
    : (typeof raw.observed_at === 'string' ? raw.observed_at : '')
  if (!observedAt) return rejected('observed_at is missing')
  return parsed({
    source: WORKER_SOURCE,
    fixture: raw.fixture === true,
    id: raw.id,
    spawnGen: asNullableString(raw.spawn_gen),
    project,
    worktree: { path: typeof worktreePath === 'string' ? worktreePath : null, present },
    backend,
    endpoint: { target, exists, agentAlive, status },
    crewState: crewRaw as CrewState,
    observedAt,
  })
}

/** Pull task objects out of a fleet document or a single `--task` object. */
export function snapshotTaskObjects(raw: unknown): unknown[] {
  if (!isRecord(raw)) return []
  if (Array.isArray(raw.tasks)) return raw.tasks
  if (typeof raw.id === 'string') return [raw]
  return []
}

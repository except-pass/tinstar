import { z } from 'zod'
import type { ParentAsks, ParentResolutions } from '../../shared/waitingOnMain'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readFleetSnapshot } from '../fleet/snapshot'
import { CachedObservation, retainMissing } from './observation'
import type { FleetSource } from './config'
import { record, text } from './values'
import { cardReferences } from './references'
import { queueSignals } from './queueInputs'
import { collectedDispatch } from './dispatchProvenance'
import type { CodexActivity } from '../../shared/codexActivity'

const fields = <K extends string>(value: unknown, keys: K[]): Record<K, string | number | boolean | null> => Object.fromEntries(keys.map(key => {
  const item = record(value)[key]
  return [key, typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? item : null]
})) as Record<K, string | number | boolean | null>

// Missing or malformed lists are unknown. Only an explicit [] proves no blockers.
const readinessFields = (value: unknown): {
  unresolved_blocker_ids?: string[]; blocked_by_ids?: string[]
  current_role?: string | null; hold_bucket?: string | null
} => {
  const row = record(value)
  const lists = Object.fromEntries(['unresolved_blocker_ids', 'blocked_by_ids'].flatMap(key => {
    const items = row[key]
    return Array.isArray(items) && items.every(item => typeof item === 'string' && !!item.trim()) ? [[key, items]] : []
  }))
  return { ...lists, current_role: text(row.current_role), hold_bucket: text(row.hold_bucket) }
}

// Persistent second mates are not spawned tasks and have no spawn generation.
// Kind, role, or a secondmate_current record id identifies the row.
const secondMateIds = (snapshot: Record<string, unknown>) => {
  const records = record(snapshot.secondmate_current).records
  const ids = new Set<string>()
  if (!Array.isArray(records)) return ids
  for (const row of records) {
    const id = text(record(row).id)
    if (id) ids.add(id)
  }
  return ids
}

const secondMateRow = (task: unknown, mates: ReadonlySet<string>) => {
  const row = record(task)
  const id = text(row.id)
  return text(row.kind) === 'secondmate' || text(row.role) === 'secondmate' || (id !== null && mates.has(id))
}

const codexFields = (task: Record<string, unknown>): { codex?: CodexActivity | null; codex_reason?: string | null } => {
  if (!('codex' in task)) return {}
  const value = record(task.codex)
  return { codex: task.codex ? {
    last_activity_at: text(value.last_activity_at), observed_at: text(value.observed_at),
    session_file: text(value.session_file), turn_open: typeof value.turn_open === 'boolean' ? value.turn_open : null,
  } : null, codex_reason: text(task.codex_reason) }
}

const parentAsksSchema = z.object({
  status: z.enum(['known', 'unknown']), observed_at: z.string().datetime({ offset: true }),
  items: z.array(z.object({ key: z.string().min(1), corr: z.string().nullable(), state: z.enum(['blocked', 'needs-decision']), at: z.number().int().nonnegative().nullable(), text: z.string() })),
})
function parentAsksField(value: unknown): { parent_asks?: ParentAsks } {
  const parsed = parentAsksSchema.safeParse(value)
  return parsed.success ? { parent_asks: parsed.data } : {}
}

const parentResolutionsSchema = z.object({
  status: z.enum(['known', 'unknown']), observed_at: z.string().datetime({ offset: true }),
  mates: z.record(z.string().min(1), z.object({
    status: z.enum(['known', 'unknown']),
    keys: z.array(z.object({ key: z.string().min(1), at: z.number().int().nonnegative() })),
  })),
})
function parentResolutionsField(value: unknown): { parent_resolutions?: ParentResolutions } {
  const parsed = parentResolutionsSchema.safeParse(value)
  return parsed.success ? { parent_resolutions: parsed.data } : {}
}

export function fleetObservation(source: FleetSource) {
  // File publication includes snapshot generation and transport between homes.
  const maxAgeMs = source.snapshotFile ? 300_000 : 60_000
  return new CachedObservation(async () => {
    const snapshot = await readFleetSnapshot(source.home, source.snapshotFile)
    // A wrong publisher/path must not silently move work between homes.
    if (snapshot.fm_home !== source.home || typeof snapshot.generated !== 'string') throw new Error('snapshot identity/timestamp missing or mismatched')
    let ledger: { bytes: number; modifiedAt: string } | null = null
    if (!source.snapshotFile) {
      try {
        const info = await stat(join(source.home, 'state', 'fleet-ledger.jsonl'))
        ledger = { bytes: info.size, modifiedAt: info.mtime.toISOString() }
      } catch { /* optional change signal; not execution history */ }
    }
    const mates = secondMateIds(snapshot)
    const tasks = snapshot.tasks.map(task => ({
      ...queueSignals(task),
      ...codexFields(task),
      ...collectedDispatch(record(task.backlog), 'task.backlog.body_lines'),
      ...fields(task, ['id', 'kind', 'harness', 'model', 'branch', 'project', 'spawn_gen', 'backend']),
      kind: secondMateRow(task, mates) ? 'secondmate' : fields(task, ['kind']).kind,
      remote: task.remote ? fields(task.remote, ['host', 'root']) : null,
      // Identity uses a tuple, never delimiter concatenation or array position.
      identity: { fm_home: source.home, task_id: text(task.id), spawn_gen: text(task.spawn_gen) },
      cardReferences: [...cardReferences(task, 'task'), ...cardReferences(record(task.backlog), 'task.backlog')],
      current_state: fields(task.current_state, ['state', 'source', 'detail', 'observed_at', 'freshness']),
      endpoint: fields(task.endpoint, ['exists', 'agent_alive', 'status', 'observed_at', 'freshness']),
      paths: { home: text(record(record(task.paths).home).path), worktree: text(record(record(task.paths).worktree).path) },
      last_event: fields(record(record(task.paths).status_log).last_event, ['state', 'note', 'raw', 'age_seconds']),
      lastEventText: text(record(task.hints).last_event_text),
      pr: fields(task.pr, ['url', 'source', 'head']),
      backlog: { ...fields(task.backlog, ['id', 'title', 'state', 'hold_reason', 'blocked_by', 'hold_until']), ...readinessFields(task.backlog) },
    }))
    const backlog = snapshot.backlog?.records
    const spawned = tasks.filter(task => task.kind !== 'secondmate')
    // Duplicate backlog IDs can hide contradictory dispatch notes behind a first-match join.
    // Second-mate rows stay in the snapshot and do not count against task-link completeness.
    const complete = Array.isArray(backlog) && snapshot.backlog?.present === true &&
      record(snapshot.main_inventory).valid === true && backlog.every(row => !!text(record(row).id)) &&
      new Set(backlog.map(row => text(record(row).id))).size === backlog.length &&
      tasks.every(task => !!task.identity.task_id) &&
      spawned.every(task => !!task.identity.spawn_gen) &&
      new Set(tasks.map(task => task.identity.task_id)).size === tasks.length
    return {
      observedAt: snapshot.generated, coverage: complete ? 'complete' as const : 'partial' as const,
      data: {
        ...parentAsksField(snapshot.parent_asks),
        ...parentResolutionsField(snapshot.parent_resolutions),
        schema: snapshot.schema, fm_home: source.home, generated: snapshot.generated,
        coverageScope: 'home-task-metadata-and-backlog; child homes and runtime liveness are independent',
        main_inventory: fields(snapshot.main_inventory, ['valid', 'reason', 'unstructured_current_count']),
        backlogPresent: typeof snapshot.backlog?.present === 'boolean' ? snapshot.backlog.present : null,
        ledger: { role: 'change-signal-only', cursor: ledger, scope: source.snapshotFile ? 'not-collected' : 'local-file-stat' },
        tasks, backlog: Array.isArray(backlog) ? backlog.map(row => ({ ...queueSignals(row), ...readinessFields(row), ...collectedDispatch(row, 'backlog.body_lines'), ...fields(row, [
          'id', 'title', 'state', 'kind', 'repo', 'hold_reason', 'hold_until', 'blocked_by', 'captain_actionable', 'pr_url',
        ]), cardReferences: cardReferences(row, 'backlog') })) : null,
      },
    }
  }, 20_000, maxAgeMs, 'Fleet snapshot unavailable, invalid, or from a different home; check the configured source', Date.now, (previous, current) => ({ ...current,
    tasks: retainMissing(previous.tasks, current.tasks, task => JSON.stringify(task.identity)),
    backlog: previous.backlog || current.backlog ? retainMissing(previous.backlog ?? [], current.backlog ?? [], entry => String(entry.id)) : null,
  }))
}

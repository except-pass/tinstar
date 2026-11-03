import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readFleetSnapshot } from '../fleet/snapshot'
import { CachedObservation } from './observation'
import type { FleetSource } from './config'
import { record, text } from './values'
import { cardReferences } from './references'
import { queueSignals } from './queueInputs'

const fields = <K extends string>(value: unknown, keys: K[]): Record<K, string | number | boolean | null> => Object.fromEntries(keys.map(key => {
  const item = record(value)[key]
  return [key, typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? item : null]
})) as Record<K, string | number | boolean | null>

export function fleetObservation(source: FleetSource) {
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
    const tasks = snapshot.tasks.map(task => ({
      ...queueSignals(task),
      ...fields(task, ['id', 'kind', 'harness', 'model', 'branch', 'project', 'spawn_gen', 'backend']),
      remote: task.remote ? fields(task.remote, ['host', 'root']) : null,
      // Identity uses a tuple, never delimiter concatenation or array position.
      identity: { fm_home: source.home, task_id: text(task.id), spawn_gen: text(task.spawn_gen) },
      cardReferences: [...cardReferences(task, 'task'), ...cardReferences(record(task.backlog), 'task.backlog')],
      current_state: fields(task.current_state, ['state', 'source', 'detail', 'observed_at', 'freshness']),
      endpoint: fields(task.endpoint, ['exists', 'agent_alive', 'status', 'observed_at', 'freshness']),
      paths: { home: text(record(record(task.paths).home).path), worktree: text(record(record(task.paths).worktree).path) },
      last_event: fields(record(record(task.paths).status_log).last_event, ['state', 'note', 'age_seconds']),
      lastEventText: text(record(task.hints).last_event_text),
      pr: fields(task.pr, ['url', 'source', 'head']),
      backlog: fields(task.backlog, ['id', 'title', 'state', 'hold_reason', 'blocked_by', 'hold_until']),
    }))
    const backlog = snapshot.backlog?.records
    const complete = Array.isArray(backlog) && snapshot.backlog?.present !== false &&
      record(snapshot.main_inventory).valid !== false && backlog.every(row => !!text(record(row).id)) &&
      tasks.every(task => !!task.identity.task_id && !!task.identity.spawn_gen) &&
      new Set(tasks.map(task => task.identity.task_id)).size === tasks.length
    return {
      observedAt: snapshot.generated, coverage: complete ? 'complete' as const : 'partial' as const,
      data: {
        schema: snapshot.schema, fm_home: source.home, generated: snapshot.generated,
        coverageScope: 'home-task-metadata-and-backlog; child homes and runtime liveness are independent',
        main_inventory: fields(snapshot.main_inventory, ['valid', 'reason', 'unstructured_current_count']),
        backlogPresent: typeof snapshot.backlog?.present === 'boolean' ? snapshot.backlog.present : null,
        ledger: { role: 'change-signal-only', cursor: ledger, scope: source.snapshotFile ? 'not-collected' : 'local-file-stat' },
        tasks, backlog: Array.isArray(backlog) ? backlog.map(row => ({ ...queueSignals(row), ...fields(row, [
          'id', 'title', 'state', 'kind', 'repo', 'hold_reason', 'hold_until', 'blocked_by', 'captain_actionable', 'pr_url',
        ]), cardReferences: cardReferences(row, 'backlog') })) : null,
      },
    }
  }, 20_000, 60_000, 'Fleet snapshot unavailable, invalid, or from a different home; check the configured source')
}

import type { Execution } from '../server/reconciliation/scene'
import type { FloorScene } from './reconciliationPresentation'

type Observation = Execution['observation']
type Backlog = FloorScene['backlog'][number]
const key = (home: string, task: string | null) => JSON.stringify([home, task])
const fresh = (observation: Observation, now: number) => observation.status === 'fresh' && observation.coverage === 'complete' &&
  (!observation.expiresAt || Date.parse(observation.expiresAt) > now)

/** Crew-state is current authority. Endpoint existence and historical status verbs
 * cannot establish either working or its absence. */
export function currentActivity(worker: Execution, now: number): 'working' | 'waiting' | 'terminal' | 'unknown' {
  const state = worker.source.current_state
  if (!fresh(worker.observation, now) || state.freshness !== 'fresh' || !['run-step', 'pane'].includes(String(state.source))) return 'unknown'
  if (state.state === 'working') return 'working'
  if (['parked', 'paused', 'blocked'].includes(String(state.state))) return 'waiting'
  if (['done', 'failed'].includes(String(state.state))) return 'terminal'
  return 'unknown'
}

/** Index the existing home observations once per scene health query. All joins
 * retain home/task identity. */
export function readinessContext(scene: FloorScene, now: number) {
  const rows = new Map<string, Backlog>()
  const executions = new Map<string, Execution[]>()
  for (const row of scene.backlog) {
    rows.set(key(row.home, String(row.source.id)), row)
  }
  for (const worker of scene.executions) {
    const id = key(worker.home, worker.identity.task_id)
    const entries = executions.get(id) ?? []; entries.push(worker); executions.set(id, entries)
  }
  const homes = new Map(scene.coverage.homes.map(home => [home.source.home, home.observation]))
  return { rows, executions, homes, allHomesFresh: homes.size > 0 && [...homes.values()].every(home => fresh(home, now)),
    blocker: (home: string, id: string) => rows.get(key(home, id)) }
}

/** A projection, not a scheduler: queued unheld rows and explicitly named
 * blocker/Origin paths only. Null preserves every unobserved census or state. */
export function workReadiness(scene: FloorScene, workers: Execution[], linksKnown: boolean, now: number,
  context = readinessContext(scene, now)) {
  const reasons = new Set<string>()
  const accountable = new Map<string, { home: string; task: string }>()
  for (const worker of workers) if (worker.identity.task_id) accountable.set(key(worker.home, worker.identity.task_id), { home: worker.home, task: worker.identity.task_id })
  let runnableKnown = linksKnown && accountable.size > 0 && context.allHomesFresh
  let resolversKnown = runnableKnown
  const runnablePaths = new Set<string>(), resolverPaths = new Set<string>(), blockers = new Set<string>()
  const candidates = new Map<string, Backlog>()
  for (const [home, observation] of context.homes) if (!fresh(observation, now)) {
    reasons.add(`Home snapshot stale or unreadable: ${home}`)
    reasons.add(`Runnable coverage incomplete for ${home}`)
    reasons.add(`Active resolver coverage incomplete for ${home}`)
  }
  if (!context.homes.size) reasons.add('Home snapshot unavailable: no configured home')
  if (!linksKnown || !accountable.size) reasons.add('Runnable and active resolver accountability unavailable: no complete verified task links')

  const inspectRunnable = (row: Backlog) => {
    if (!fresh(row.observation, now) || !context.homes.has(row.home) || !fresh(context.homes.get(row.home)!, now) || !Array.isArray(row.source.unresolved_blocker_ids) || !['queued', 'in_flight', 'done'].includes(String(row.source.state))) {
      runnableKnown = false; reasons.add(`Runnable coverage incomplete for ${row.home}`); return
    }
    const source = row.source
    const activities = (context.executions.get(key(row.home, String(source.id))) ?? []).map(worker => currentActivity(worker, now))
    if (activities.includes('unknown')) {
      runnableKnown = false; reasons.add(`Runnable state unknown for ${row.home}: ${source.id}`); return
    }
    const working = activities.includes('working')
    if (!working && source.state === 'queued' && source.hold_reason === null && source.hold_until === null &&
      (source.queue?.holdKind ?? null) === null && !source.hold_bucket && source.captain_actionable !== true && source.unresolved_blocker_ids!.length === 0) runnablePaths.add(row.id)
  }
  for (const { home, task } of accountable.values()) {
    const row = context.rows.get(key(home, task))
    if (!row || !fresh(row.observation, now) || !context.homes.has(home) || !fresh(context.homes.get(home)!, now) || !Array.isArray(row.source.unresolved_blocker_ids)) {
      runnableKnown = false; resolversKnown = false
      reasons.add(`Runnable coverage incomplete for ${home}: ${task} backlog/blocker census unavailable`)
      reasons.add(`Active resolver coverage incomplete for ${home}: ${task} blocker census unavailable`)
      continue
    }
    inspectRunnable(row)
    if (row.source.blocked_by) blockers.add(String(row.source.blocked_by))
    for (const blocker of row.source.unresolved_blocker_ids) {
      blockers.add(blocker)
      const candidate = context.blocker(home, blocker)
      if (!candidate) {
        runnableKnown = false; resolversKnown = false
        reasons.add(`Runnable and active resolver unknown for ${home}: blocker ${blocker} missing or ambiguous`)
      } else candidates.set(key(candidate.home, String(candidate.source.id)), candidate)
    }
  }
  // Origin is an explicit continuation edge, never inferred from prose or names.
  for (const row of scene.backlog) if (row.source.queue?.originTaskId && accountable.has(key(row.home, row.source.queue.originTaskId))) candidates.set(key(row.home, String(row.source.id)), row)
  for (const worker of scene.executions) if (worker.source.queue?.originTaskId && accountable.has(key(worker.home, worker.source.queue.originTaskId))) {
    const id = key(worker.home, worker.identity.task_id), row = context.rows.get(id)
    if (row) candidates.set(id, row)
    else { runnableKnown = false; resolversKnown = false; reasons.add(`Runnable and active resolver coverage incomplete for ${worker.home}: continuation backlog unavailable`) }
  }
  for (const [id, row] of candidates) {
    if (accountable.has(id)) continue // own running path is not an extra resolver
    inspectRunnable(row)
    if (!Array.isArray(row.source.unresolved_blocker_ids) || row.source.unresolved_blocker_ids.length > 0) {
      runnableKnown = false; resolversKnown = false
      reasons.add(`Runnable and active resolver coverage incomplete for ${row.home}: ${row.source.id} dependencies outside inspected scope`)
    }
    if (!fresh(row.observation, now) || !context.homes.has(row.home) || !fresh(context.homes.get(row.home)!, now)) {
      resolversKnown = false; reasons.add(`Active resolver coverage incomplete for ${row.home}`); continue
    }
    const executions = context.executions.get(id) ?? []
    if (!executions.length && ['queued', 'done'].includes(String(row.source.state))) continue
    if (executions.length !== 1 || currentActivity(executions[0]!, now) === 'unknown') {
      resolversKnown = false; reasons.add(`Active resolver unknown for ${row.home}: ${row.source.id}`)
    } else if (currentActivity(executions[0]!, now) === 'working') resolverPaths.add(id)
  }
  for (const path of [...scene.backlog.map(row => ({ home: row.home, task: String(row.source.id), origin: row.source.queue?.originTaskId })),
    ...scene.executions.map(worker => ({ home: worker.home, task: worker.identity.task_id, origin: worker.source.queue?.originTaskId }))]) {
    if (path.origin && candidates.has(key(path.home, path.origin)) && !accountable.has(key(path.home, path.task)) && !candidates.has(key(path.home, path.task))) {
      runnableKnown = false; resolversKnown = false
      reasons.add(`Runnable and active resolver coverage incomplete for ${path.home}: continuation of ${path.origin} outside inspected scope`)
    }
  }
  return { runnable: runnableKnown ? runnablePaths.size : null, activeResolverCount: resolversKnown ? resolverPaths.size : null,
    hasRunnable: runnablePaths.size > 0, hasResolver: resolverPaths.size > 0, blockers: [...blockers], reasons: [...reasons],
    evidence: [...accountable.values()].map(({ home, task }) => {
      const observation = context.homes.get(home)
      return `Readiness ${home}/${task}: observed ${observation?.observedAt ?? 'unknown'} (${observation?.status ?? 'unknown'}/${observation?.coverage ?? 'unknown'}); source backlog and current_state`
    }) }
}

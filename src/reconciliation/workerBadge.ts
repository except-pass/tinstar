import type { Worker } from '../cockpit/shell/types'
import type { Execution } from '../server/reconciliation/scene'
import type { FinishedPullStatus } from '../server/fleet/attention'
import { releasePull } from '../shared/pullIdentity'
import { ageLabel } from '../shared/workerTimestamps'
import { hasCurrentExecution } from '../shared/workerEvidence'
import { homeAuthoritative, stale } from './overviewModel'

const stalledAfterMs = 45 * 60_000

export function overviewPullStatuses(workers: Worker[]): ReadonlyMap<string, FinishedPullStatus> {
  const pulls = new Map<string, FinishedPullStatus>()
  for (const worker of workers) {
    const id = worker.prUrl && releasePull(worker.prUrl)?.id
    if (id && (worker.prStatus === 'merged' || worker.prStatus === 'closed')) pulls.set(id, worker.prStatus)
  }
  return pulls
}

function waitBadge(worker: Execution, state: string, label: string, tone: string, observedAt: number, now: number) {
  const event = worker.source.last_event
  const age = event.age_seconds
  // Event age is relative to the snapshot that observed this task.
  const began = state === event.state && typeof age === 'number' && age >= 0 ? observedAt - age * 1000 : NaN
  const duration = began > 0 && began <= now ? now - began : NaN
  const ageText = Number.isFinite(duration) ? ` · ${ageLabel(began, now).replace(/ ago$/, '')}` : ''
  const backlog = worker.source.backlog
  const ownBacklog = worker.identity.task_id && backlog.id === worker.identity.task_id ? backlog : undefined
  if (ownBacklog?.blocked_by_ids?.length && ownBacklog.unresolved_blocker_ids?.length === 0) {
    return { label: `Stalled${ageText}`, tone: 'stalled' }
  }
  // A linked pull request or the absence of a dependency does not establish
  // whether this worker has a timer, a monitor, or another way to resume.
  if (duration > stalledAfterMs) return { label: `${label}${ageText} · wake unknown`, tone: 'unknown' }
  return { label: `${label}${ageText}`, tone }
}

export function workerBadge(worker: Execution, now: number, pulls: ReadonlyMap<string, FinishedPullStatus> | undefined, readFailed = false) {
  const current = worker.source.current_state
  const observedAt = Date.parse(String(current.observed_at ?? ''))
  const state = !readFailed && !stale(worker.observation, now) && current.freshness === 'fresh' &&
    Number.isFinite(observedAt) && observedAt <= now && current.source && current.source !== 'none' ? current.state : null
  const url = worker.source.pr.url
  const pullId = typeof url === 'string' ? releasePull(url)?.id : null
  const pull = pullId ? pulls?.get(pullId) : null
  const waiting = state === 'parked' || state === 'paused' || state === 'waiting'
  if (pull === 'merged' || (pull === 'closed' && (waiting || state === 'blocked' || state === 'needs-decision'))) {
    return { label: `PR ${pull}`, tone: 'done' }
  }
  if (state === 'blocked') return waitBadge(worker, state, 'Blocked', 'blocked', observedAt, now)
  if (state === 'needs-decision') return waitBadge(worker, state, 'Needs a decision', 'decision', observedAt, now)
  if (waiting) return waitBadge(worker, state, 'Waiting', 'waiting', observedAt, now)
  const executionState = state && (current.source === 'pane' || current.source === 'run-step' || state === 'done' || state === 'failed') ? current : {}
  if (homeAuthoritative(worker.observation, now, readFailed) && hasCurrentExecution(worker.source, now, executionState)) {
    return { label: 'Running', tone: 'running' }
  }
  if (pull === 'closed') return { label: 'PR closed', tone: 'done' }
  if (state === 'done') return { label: 'Done', tone: 'done' }
  if (state === 'failed') return { label: 'Failed', tone: 'blocked' }
  return { label: 'Unknown', tone: 'unknown' }
}

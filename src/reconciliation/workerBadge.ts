import type { Worker } from '../cockpit/shell/types'
import type { Execution } from '../server/reconciliation/scene'
import type { ReviewStatus } from '../server/fleet/attention'
import { releasePull } from '../shared/pullIdentity'
import { ageLabel } from '../shared/workerTimestamps'
import { stale } from './overviewModel'

const stalledAfterMs = 45 * 60_000

export function overviewPullStatuses(workers: Worker[]): ReadonlyMap<string, ReviewStatus> {
  const pulls = new Map<string, ReviewStatus>()
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
  // First Mate only removes a published blocker ID from the unresolved list
  // when that task is Done. Match a single explicit dependency on this worker's own row.
  if (state === 'blocked' && backlog.id === worker.identity.task_id &&
    backlog.blocked_by_ids?.length === 1 && backlog.unresolved_blocker_ids?.length === 0) {
    return { label: `Stalled${ageText}`, tone: 'stalled' }
  }
  // A linked pull request or the absence of a dependency does not establish
  // whether this worker has a timer, a monitor, or another way to resume.
  if (duration > stalledAfterMs) return { label: `${label}${ageText} · wake unknown`, tone: 'unknown' }
  return { label: `${label}${ageText}`, tone }
}

export function workerBadge(worker: Execution, now: number, pulls: ReadonlyMap<string, ReviewStatus> | undefined, readFailed = false) {
  const current = worker.source.current_state
  const observedAt = Date.parse(String(current.observed_at ?? ''))
  const state = !readFailed && !stale(worker.observation, now) && current.freshness === 'fresh' &&
    Number.isFinite(observedAt) && observedAt <= now && current.source && current.source !== 'none' ? current.state : null
  if (state === 'blocked') return waitBadge(worker, 'blocked', 'Blocked', 'blocked', observedAt, now)
  if (state === 'parked' || state === 'needs-decision') {
    // The producer emits this exact delimited component for a human pipeline gate.
    const decision = state === 'needs-decision' || current.source === 'status-log' ||
      current.source === 'run-step' && String(current.detail).split(' · ').includes('ask-user: authority decision')
    return decision ? waitBadge(worker, 'needs-decision', 'Needs a decision', 'decision', observedAt, now)
      : waitBadge(worker, 'parked', 'Waiting', 'waiting', observedAt, now)
  }
  if (state === 'paused' || state === 'waiting') return waitBadge(worker, state, 'Waiting', 'waiting', observedAt, now)
  const url = worker.source.pr.url
  const pullId = typeof url === 'string' ? releasePull(url)?.id : null
  const pull = pullId ? pulls?.get(pullId) : null
  if (pull === 'merged') return { label: 'PR merged', tone: 'done' }
  if (state === 'working' || state === 'running') return { label: 'Running', tone: 'running' }
  if (pull === 'closed') return { label: 'PR closed', tone: 'done' }
  if (state === 'done') return { label: 'Done', tone: 'done' }
  if (state === 'failed') return { label: 'Failed', tone: 'blocked' }
  return { label: 'Unknown', tone: 'unknown' }
}

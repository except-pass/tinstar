import type { Execution } from '../server/reconciliation/scene'

export function reportTimestamp(worker: Execution): number {
  const time = Date.parse(worker.observation.observedAt ?? '')
  const age = worker.source.last_event.age_seconds
  return typeof age === 'number' && Number.isFinite(age) && Number.isFinite(time) ? time - age * 1000 : NaN
}

export function activityTimestamp(worker: Execution): number {
  const activity = Date.parse(worker.source.codex?.last_activity_at ?? '')
  return Number.isFinite(activity) ? activity : reportTimestamp(worker)
}

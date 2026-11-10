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

export function ageLabel(time: number, now: number): string {
  if (!Number.isFinite(time) || time <= 0) return 'Unknown'
  const seconds = Math.max(0, Math.floor((now - time) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

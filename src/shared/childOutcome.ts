import type { MateSnapshot } from '../server/fleet/workerState'

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const CHILD_OUTCOME = /^(done|failed) \[key=(?:child-outcome-[^\]]+\](?: \[[^\]]*\])*: child \S+ \1:|inactive-outcome-[^\]]+\](?: \[[^\]]*\])*: inactive terminal child=\S+)/

export function childOutcomeVerb(task: MateSnapshot): string | null {
  if (text(task.kind) !== 'secondmate') return null
  return CHILD_OUTCOME.exec(text(task.paths?.status_log?.last_event?.raw))?.[1] ?? null
}


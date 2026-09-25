/** Material drift is elapsed ≥ 1.5 × the task's planned baseline. */
export const DRIFT_RATIO = 1.5

export interface ScheduleTask {
  taskId: string
  /** Original baseline. Samples, retries, and acknowledge do not rewrite it. */
  plannedMs: number
  /** Later forecast. Null until a rebudget. The baseline stays beside it. */
  forecastMs: number | null
  startedAt: string
  elapsedMs: number
  retryCount: number
  activity: string
  lastProgress: string | { unknown: true }
  evidence: string
  explanation: string
  acknowledgedAt: string | null
}

export interface SampleInput {
  taskId: string
  plannedMs: number
  elapsedMs: number
  retryCount: number
  activity: string
  lastProgress: string | { unknown: true }
  evidence: string
  explanation: string
  at: string
}

export function driftItemId(taskId: string): string {
  return `schedule-drift:${taskId}`
}

export function driftReached(task: Pick<ScheduleTask, 'elapsedMs' | 'plannedMs'>): boolean {
  return task.plannedMs > 0 && task.elapsedMs >= task.plannedMs * DRIFT_RATIO
}

function saysContinues(text: string): boolean {
  return /work continues/i.test(text)
}

/**
 * Fold one observation into the schedule row.
 * Elapsed and the retry counter only move forward, so a retry that reports
 * a fresh zero does not erase time already counted.
 */
export function applySample(prev: ScheduleTask | undefined, sample: SampleInput): ScheduleTask {
  const plannedMs = prev?.plannedMs ?? sample.plannedMs
  const elapsedMs = prev ? Math.max(prev.elapsedMs, sample.elapsedMs) : sample.elapsedMs
  const retryCount = prev ? Math.max(prev.retryCount, sample.retryCount) : sample.retryCount
  const explanation = saysContinues(sample.explanation)
    ? sample.explanation
    : sample.explanation
      ? `Work continues. ${sample.explanation}`
      : 'Work continues.'
  const evidence = sample.evidence || `elapsed ${elapsedMs} ms against the ${plannedMs} ms baseline`
  return {
    taskId: sample.taskId,
    plannedMs,
    forecastMs: prev?.forecastMs ?? null,
    startedAt: prev?.startedAt ?? sample.at,
    elapsedMs,
    retryCount,
    activity: sample.activity || 'working',
    lastProgress: sample.lastProgress,
    evidence,
    explanation,
    acknowledgedAt: prev?.acknowledgedAt ?? null,
  }
}

export function acknowledgeTask(task: ScheduleTask, at: string): ScheduleTask {
  return { ...task, acknowledgedAt: at }
}

export function rebudgetTask(task: ScheduleTask, forecastMs: number): ScheduleTask {
  return {
    ...task,
    forecastMs,
    explanation: `Work continues. Baseline ${task.plannedMs} ms stays. Forecast ${forecastMs} ms.`,
  }
}

/** Wire object for one continuing schedule-drift Needs You item. */
export function driftWire(task: ScheduleTask, at: string, createdAt: string): Record<string, unknown> {
  return {
    id: driftItemId(task.taskId),
    type: 'schedule-drift',
    headline: `Task ${task.taskId} is past 1.5× its planned budget`,
    state: 'open',
    provenance: { taskId: task.taskId },
    createdAt,
    updatedAt: at,
    revision: `e${task.elapsedMs}-r${task.retryCount}`,
    executionImpact: 'continues',
    payload: {
      plannedMs: task.plannedMs,
      elapsedMs: task.elapsedMs,
      activity: task.activity,
      lastProgress: task.lastProgress,
      evidence: task.evidence,
      explanation: task.explanation,
      continues: true,
    },
    response: null,
  }
}

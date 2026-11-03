export type ExecutionLiveness = 'running' | 'waiting' | 'finished' | 'absent' | 'liveness-not-observed'
export type LivenessCounts = Record<ExecutionLiveness, number>

/** Counts attempts, independently of task-record and relationship totals. */
export function countLiveness(executions: ReadonlyArray<{ liveness: ExecutionLiveness }>): LivenessCounts {
  const counts: LivenessCounts = { running: 0, waiting: 0, finished: 0, absent: 0, 'liveness-not-observed': 0 }
  for (const execution of executions) counts[execution.liveness]++
  return counts
}


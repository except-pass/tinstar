/** Marker for an interruption retained outside native `cause` classification. */
export const TTYD_NON_CAUSAL_INTERRUPTION = Symbol(
  'tinstar.ttyd.non-causal-interruption',
)

interface NonCausalInterruptionError extends Error {
  diagnosticSummary: string
  [TTYD_NON_CAUSAL_INTERRUPTION]: unknown
}

function hasNonCausalInterruption(
  failure: Error,
): failure is NonCausalInterruptionError {
  return TTYD_NON_CAUSAL_INTERRUPTION in failure
    && typeof (failure as Partial<NonCausalInterruptionError>)
      .diagnosticSummary === 'string'
}

export function ttydFailureContains(
  failure: unknown,
  target: unknown,
  seen: Set<unknown> = new Set(),
): boolean {
  if (failure === target) return true
  if (!(failure instanceof Error) || seen.has(failure)) return false
  seen.add(failure)
  if (ttydFailureContains(failure.cause, target, seen)) return true
  return failure instanceof AggregateError
    && failure.errors.some(error => ttydFailureContains(error, target, seen))
}

export function describeTtydFailure(
  failure: unknown,
  path: Set<unknown> = new Set(),
): string {
  if (!(failure instanceof Error)) return String(failure)
  if (path.has(failure)) return `[cycle: ${failure.message}]`
  path.add(failure)
  try {
    const aggregate = failure instanceof AggregateError
      ? '; errors: ['
        + failure.errors.map(error => describeTtydFailure(error, path)).join(' | ')
        + ']'
      : ''
    const cause = failure.cause === undefined
      ? ''
      : `; caused by: ${describeTtydFailure(failure.cause, path)}`
    const interrupted = hasNonCausalInterruption(failure)
      && !ttydFailureContains(
        failure.cause,
        failure[TTYD_NON_CAUSAL_INTERRUPTION],
      )
      ? '; interrupted failure: '
        + describeTtydFailure(
          failure[TTYD_NON_CAUSAL_INTERRUPTION],
          path,
        )
      : ''
    const summary = hasNonCausalInterruption(failure)
      ? failure.diagnosticSummary
      : failure.message
    return summary + aggregate + cause + interrupted
  } finally {
    path.delete(failure)
  }
}

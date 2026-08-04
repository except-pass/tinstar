/** Marker for an interruption retained outside native `cause` classification. */
export const TTYD_NON_CAUSAL_INTERRUPTION = Symbol(
  'tinstar.ttyd.non-causal-interruption',
)

interface NonCausalDiagnosticError extends Error {
  readonly diagnosticSummary: string
  readonly [TTYD_NON_CAUSAL_INTERRUPTION]: true
}

export interface NonCausalInterruptionError
  extends NonCausalDiagnosticError {
  readonly interrupted: unknown
}

function hasNonCausalDiagnosticSummary(
  failure: Error,
): failure is NonCausalDiagnosticError {
  const candidate = failure as Partial<NonCausalDiagnosticError>
  return candidate[TTYD_NON_CAUSAL_INTERRUPTION] === true
    && typeof candidate.diagnosticSummary === 'string'
}

function hasNonCausalInterruption(
  failure: Error,
): failure is NonCausalInterruptionError {
  return hasNonCausalDiagnosticSummary(failure)
    && 'interrupted' in failure
}

function ttydFailureContains(
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
  try {
    return describeTtydFailureUnsafe(failure, path)
  } catch {
    return '[diagnostic unavailable]'
  }
}

function describeTtydFailureUnsafe(
  failure: unknown,
  path: Set<unknown>,
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
        failure.interrupted,
      )
      ? '; interrupted failure: '
        + describeTtydFailure(
          failure.interrupted,
          path,
        )
      : ''
    const summary = hasNonCausalDiagnosticSummary(failure)
      ? failure.diagnosticSummary
      : failure.message
    return summary + aggregate + cause + interrupted
  } finally {
    path.delete(failure)
  }
}

// Sessions that are part of Tinstar's UI plumbing rather than user work.
// They have their own dedicated UI (e.g. MarshalTerminal in the canvas
// sidebar) and must not appear in the canvas, hierarchy, sessions list,
// or any other run-derived listing. Filtered at the SSE ingress so every
// downstream consumer sees them as nonexistent.

import type { Run } from './types'

export const SYSTEM_SESSION_NAMES = new Set<string>(['marshal'])

export function isSystemSession(run: Pick<Run, 'sessionId'>): boolean {
  return SYSTEM_SESSION_NAMES.has(run.sessionId)
}

/** Split a run list into the marshal run (if any) and everything else. The
 * snapshot reducer in useServerEvents uses this so the marshal is exposed on
 * its own field while still being filtered out of the canvas-facing runs[]. */
export function extractMarshal(runs: Run[]): { marshal: Run | null; rest: Run[] } {
  let marshal: Run | null = null
  const rest: Run[] = []
  for (const run of runs) {
    if (isSystemSession(run)) {
      // Last write wins — there's only ever one marshal session, but be defensive.
      marshal = run
    } else {
      rest.push(run)
    }
  }
  return { marshal, rest }
}

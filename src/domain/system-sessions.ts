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

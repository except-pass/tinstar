/** Collector facts contain no prompts, outputs or terminal contents. */
export interface CodexActivity {
  last_activity_at: string | null
  turn_open: boolean | null
  session_file: string | null
  observed_at: string | null
}
export interface CodexTask {
  harness: unknown
  current_state: { state?: unknown }
  codex?: CodexActivity | null
}
export const CODEX_ACTIVITY_FRESH_MS = 300_000

export const codexFallback = (task: CodexTask) => task.harness === 'codex' &&
  [null, undefined, '', 'unknown'].includes(task.current_state.state as string | null | undefined)

/** Crew-state wins. Only an unknown crew-state can use a freshly observed turn.
 * Log mtime is deliberately absent from freshness: an open turn never times out. */
export function codexTurn(task: CodexTask, now: number): boolean | null {
  if (!codexFallback(task)) return null
  const observed = Date.parse(task.codex?.observed_at ?? '')
  if (!Number.isFinite(observed) || observed > now || now - observed >= CODEX_ACTIVITY_FRESH_MS) return null
  return typeof task.codex?.turn_open === 'boolean' ? task.codex.turn_open : null
}


import { listSessions, setState, type Session, type SessionState } from './session'

export interface TmuxSessionObservation {
  state: 'exists' | 'missing'
  generation: string
}

export interface ReconcileOpts {
  getTmuxSessionState: (
    sessionName: string,
  ) => Promise<TmuxSessionObservation>
  /** Called only when a backend probe completed with a definite answer. */
  onTmuxSessionStateObserved?: (
    name: string,
    observation: TmuxSessionObservation,
  ) => void
  /**
   * Compare-and-swap guard before committing a corrected state. Return false
   * when ownership changed after the probe so reconciliation drops its stale
   * result instead of overwriting the new lifecycle.
   */
  beforeStateChanged?: (
    name: string,
    state: SessionState,
    observation: TmuxSessionObservation,
  ) => boolean
  onStateChanged?: (name: string, state: SessionState) => void
}

/**
 * Reconcile session states with container/tmux liveness.
 *
 * This only handles the "process died" case (running/idle → stopped).
 * The running ↔ idle transitions are handled by the StatusWatcher which
 * polls JSONL transcript files directly — no hooks needed.
 */
export async function reconcileSessionStates(
  sessionsDir: string,
  opts: ReconcileOpts,
): Promise<Session[]> {
  const sessions = await listSessions(sessionsDir)
  const updated: Session[] = []

  for (const session of sessions) {
    // Skip states that don't need reconciliation
    if (session.state === 'creating' || session.state === 'stopped') {
      updated.push(session)
      continue
    }

    let newState: SessionState | null = null
    let observation: TmuxSessionObservation | null = null
    try {
      observation = await opts.getTmuxSessionState(session.name)
      opts.onTmuxSessionStateObserved?.(session.name, observation)
      if (observation.state === 'exists') {
        // Tmux alive
      } else if (session.state === 'running' || session.state === 'idle' || session.state === 'needs_attention') {
        newState = 'stopped'
      }
    } catch {
      // If we can't check, assume current state is fine
    }

    if (newState && observation) {
      if (
        opts.beforeStateChanged
        && !opts.beforeStateChanged(session.name, newState, observation)
      ) {
        updated.push(session)
        continue
      }
      setState(sessionsDir, session.name, newState)
      session.state = newState
      if (opts.onStateChanged) opts.onStateChanged(session.name, newState)
    }

    updated.push(session)
  }

  return updated
}

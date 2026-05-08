
import { listSessions, setState, type Session, type SessionState } from './session'

export interface ReconcileOpts {
  getTmuxSessionState: (sessionName: string) => Promise<'exists' | 'missing'>
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
    try {
      const tmuxState = await opts.getTmuxSessionState(session.name)
      if (tmuxState === 'exists') {
        // Tmux alive
      } else if (session.state === 'running' || session.state === 'idle' || session.state === 'needs_attention') {
        newState = 'stopped'
      }
    } catch {
      // If we can't check, assume current state is fine
    }

    if (newState) {
      setState(sessionsDir, session.name, newState)
      session.state = newState
      if (opts.onStateChanged) opts.onStateChanged(session.name, newState)
    }

    updated.push(session)
  }

  return updated
}

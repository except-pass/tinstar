
import { listSessions, setState, claudeStateDir, type Session, type SessionState } from './session'
import { readSessionStatus } from './transcript-parser'

const STALE_RUNNING_THRESHOLD_MS = 120_000

export interface ReconcileOpts {
  getContainerState: (sessionName: string) => Promise<string>
  getTmuxSessionState: (sessionName: string) => Promise<'exists' | 'missing'>
  onStateChanged?: (name: string, state: SessionState) => void
  staleRunningThresholdMs?: number
}

export async function reconcileSessionStates(
  sessionsDir: string,
  opts: ReconcileOpts,
): Promise<Session[]> {
  const sessions = await listSessions(sessionsDir)
  const updated: Session[] = []
  const now = Date.now()

  for (const session of sessions) {
    // Skip states that don't need reconciliation
    if (session.state === 'creating' || session.state === 'stopped') {
      updated.push(session)
      continue
    }

    let newState: SessionState | null = null
    try {
      if (session.backend === 'docker') {
        const actual = await opts.getContainerState(session.name)
        if (actual === 'running') {
          // Container alive — no change
        } else if (actual === 'exited') {
          newState = 'stopped'
        } else {
          // Container missing entirely
          newState = 'stopped'
        }
      } else {
        const tmuxState = await opts.getTmuxSessionState(session.name)
        if (tmuxState === 'exists') {
          // Tmux alive
        } else if (session.state === 'running' || session.state === 'idle' || session.state === 'needs_attention') {
          newState = 'stopped'
        }
      }
    } catch {
      // If we can't check, assume current state is fine
    }

    // Detect stale 'running' sessions — hooks may have been missed.
    // Check the JSONL transcript for ground truth before falling back to needs_attention.
    const threshold = opts.staleRunningThresholdMs ?? STALE_RUNNING_THRESHOLD_MS
    if (!newState && session.state === 'running' && session.lastActive) {
      const staleMs = now - new Date(session.lastActive).getTime()
      if (staleMs > threshold) {
        const workdir = session.workspace?.path
        const convId = session.conversation?.id
        if (workdir && convId) {
          const stateDir = session.backend === 'docker' ? claudeStateDir(sessionsDir, session.name) : undefined
          const jsonlStatus = readSessionStatus(workdir, convId, stateDir)
          if (jsonlStatus === 'idle') {
            newState = 'idle'   // Stop hook was missed — correct it
          } else if (jsonlStatus === 'running') {
            // Long-running tool, genuinely still active — leave as running
          } else {
            newState = 'needs_attention'  // Can't determine from JSONL, use fallback
          }
        } else {
          newState = 'needs_attention'  // No JSONL available, use fallback
        }
      }
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

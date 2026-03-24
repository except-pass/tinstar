import { listSessions, setState, claudeStateDir, type Session, type SessionState } from './session'
import { readSessionStatus, parseNewEntries } from './transcript-parser'
import { log } from '../logger'

export interface StatusWatcherOpts {
  sessionsDir: string
  /** Called when a session's status changes based on JSONL evidence */
  onStatusChanged: (name: string, state: SessionState) => void
  /** Called with new recap entries parsed from the transcript */
  onRecapEntries?: (name: string, entries: Array<{ id: string; type: string; content: string; timestamp: string }>) => void
  /** Poll interval in ms (default 3000) */
  intervalMs?: number
}

/**
 * Polls JSONL transcript files to derive running/idle status.
 * Replaces the hook-based approach (curl from inside containers) with
 * direct observation of Claude Code's own session logs — the single
 * source of truth for whether an agent is active.
 */
export class StatusWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly opts: StatusWatcherOpts
  private readonly interval: number

  constructor(opts: StatusWatcherOpts) {
    this.opts = opts
    this.interval = opts.intervalMs ?? 3000
  }

  start(): void {
    if (this.timer) return
    this.tick() // run immediately
    this.timer = setInterval(() => this.tick(), this.interval)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    try {
      const sessions = await listSessions(this.opts.sessionsDir)
      for (const session of sessions) {
        // Only check sessions that are actually alive (running or idle)
        if (session.state !== 'running' && session.state !== 'idle') continue
        this.checkSession(session)
      }
    } catch (err) {
      log.warn('status-watcher', `tick failed: ${(err as Error).message}`)
    }
  }

  private checkSession(session: Session): void {
    const workdir = session.workspace?.path
    const convId = session.conversation?.id
    if (!workdir || !convId) return

    const stateDir = session.backend === 'docker'
      ? claudeStateDir(this.opts.sessionsDir, session.name)
      : undefined

    const jsonlStatus = readSessionStatus(workdir, convId, stateDir)
    if (!jsonlStatus) return // no transcript yet

    if (jsonlStatus !== session.state) {
      setState(this.opts.sessionsDir, session.name, jsonlStatus)
      this.opts.onStatusChanged(session.name, jsonlStatus)
      log.info('status-watcher', `${session.name}: ${session.state} → ${jsonlStatus}`)

      // Parse transcript for recap entries on idle transitions
      if (jsonlStatus === 'idle' && this.opts.onRecapEntries) {
        try {
          const entries = parseNewEntries(session.name, workdir, convId, stateDir)
          if (entries.length > 0) {
            this.opts.onRecapEntries(session.name, entries)
          }
        } catch (err) {
          log.warn('status-watcher', `transcript parse failed for ${session.name}: ${err}`)
        }
      }
    }
  }
}

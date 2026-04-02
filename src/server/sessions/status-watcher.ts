import { existsSync } from 'node:fs'
import { listSessions, setState, claudeStateDir, type Session, type SessionState } from './session'
import { readSessionStatusDetail, parseNewEntries } from './transcript-parser'
import { discoverTranscript, readCodexStatus, parseCodexRecapEntries } from './codex-transcript'
import { log } from '../logger'
import { execFile } from 'node:child_process'

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
 *
 * For tmux sessions where the JSONL shows a pending tool_use, also checks
 * whether the agent process has active child processes. If it doesn't (on
 * two consecutive polls), the agent is blocked waiting for user input
 * (e.g. a permission prompt) and the session is flipped to "idle".
 */
export class StatusWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly opts: StatusWatcherOpts
  private readonly interval: number
  /** Tracks consecutive "no children" polls per session for debouncing */
  private readonly idleStreak = new Map<string, number>()
  /** Sessions where process-tree check has overridden JSONL to idle */
  private readonly processTreeOverride = new Set<string>()
  /** Cached Codex transcript paths per session */
  private readonly codexTranscripts = new Map<string, string>()

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
    const adapter = (session as Session & { adapter?: string | null }).adapter ?? 'claude'

    // Codex adapter: discover transcript, then parse status from it
    if (adapter === 'codex' && session.backend === 'tmux') {
      this.checkCodexSession(session)
      return
    }

    // Generic/unknown adapters: process-tree only
    if (adapter !== 'claude' && session.backend === 'tmux') {
      if (this.processTreeOverride.has(session.name)) {
        return
      }
      this.checkProcessTree(session)
      return
    }

    const workdir = session.workspace?.path
    const convId = session.conversation?.id
    if (!workdir || !convId) return

    const stateDir = session.backend === 'docker'
      ? claudeStateDir(this.opts.sessionsDir, session.name)
      : undefined

    const detail = readSessionStatusDetail(workdir, convId, stateDir)
    if (!detail) return // no transcript yet

    // When JSONL shows a pending tool_use on a tmux session, use the process
    // tree to determine the real state. This catches both:
    // - session currently "running" that might be blocked on permission
    // - session we already flipped to "idle" that might have resumed
    if (detail.toolPending && session.backend === 'tmux') {
      if (this.processTreeOverride.has(session.name)) {
        return // already determined blocked — skip until JSONL changes
      }
      this.checkProcessTree(session)
      return
    }

    // JSONL no longer shows tool_use pending — clear any process-tree override
    if (this.processTreeOverride.has(session.name)) {
      log.info('status-watcher', `${session.name}: tool_use resolved, clearing process-tree override`)
      this.processTreeOverride.delete(session.name)
      this.idleStreak.delete(session.name)
    }

    if (detail.state !== session.state) {
      // Debounce running → idle: only transition after 2 consecutive idle polls.
      // Claude emits text blocks between tool calls while still working —
      // these briefly look "idle" in the JSONL but the agent isn't waiting for input.
      if (session.state === 'running' && detail.state === 'idle') {
        const streak = (this.idleStreak.get(session.name) ?? 0) + 1
        this.idleStreak.set(session.name, streak)
        if (streak < 2) return // not stable yet
        log.info('status-watcher', `${session.name}: idle confirmed (streak=${streak})`)
      }
      this.idleStreak.delete(session.name)
      this.transitionState(session, detail.state)
    } else {
      // State unchanged — reset idle streak
      this.idleStreak.delete(session.name)
    }
  }

  private async checkCodexSession(session: Session): Promise<void> {
    const workdir = session.workspace?.path
    if (!workdir) return

    // Try cached path first
    let transcriptPath = this.codexTranscripts.get(session.name)

    // Validate cache — clear if file doesn't exist
    if (transcriptPath && !existsSync(transcriptPath)) {
      this.codexTranscripts.delete(session.name)
      transcriptPath = undefined
    }

    // Discover if no cache
    if (!transcriptPath) {
      const tmuxTarget = `tinstar-${session.name}`
      const discovered = await discoverTranscript(
        session.name,
        workdir,
        session.created,
        tmuxTarget,
      )
      if (discovered) {
        this.codexTranscripts.set(session.name, discovered)
        transcriptPath = discovered
        log.info('status-watcher', `${session.name}: codex transcript discovered`)
      }
    }

    if (!transcriptPath) {
      // No transcript found yet — fall back to process-tree
      if (!this.processTreeOverride.has(session.name)) {
        this.checkProcessTree(session)
      }
      return
    }

    // Parse status from Codex JSONL
    const status = readCodexStatus(transcriptPath)
    if (!status) return

    if (status !== session.state) {
      this.transitionState(session, status)
    }

    // Parse recap entries on idle transitions
    if (status === 'idle' && this.opts.onRecapEntries) {
      try {
        const entries = parseCodexRecapEntries(session.name, transcriptPath)
        if (entries.length > 0) {
          this.opts.onRecapEntries(session.name, entries)
        }
      } catch (err) {
        log.warn('status-watcher', `codex recap parse failed for ${session.name}: ${err}`)
      }
    }
  }

  private checkProcessTree(session: Session): void {
    const tmuxTarget = `tinstar-${session.name}`

    // Get the PID of the process running in the tmux pane
    execFile('tmux', ['list-panes', '-t', tmuxTarget, '-F', '#{pane_pid}'], (err, stdout) => {
      if (err) {
        log.debug('status-watcher', `${session.name}: tmux pane lookup failed: ${err.message}`)
        this.idleStreak.delete(session.name)
        // Tmux session is gone — mark as stopped
        if (session.state === 'running' || session.state === 'idle') {
          this.transitionState(session, 'stopped')
        }
        return
      }

      const shellPid = stdout.trim().split('\n')[0]
      if (!shellPid) return

      // Find the agent process (direct child of the shell)
      execFile('pgrep', ['-P', shellPid], (err2, agentOut) => {
        if (err2 || !agentOut.trim()) {
          log.debug('status-watcher', `${session.name}: no agent process under shell pid ${shellPid}`)
          this.idleStreak.delete(session.name)
          return
        }

        const agentPid = agentOut.trim().split('\n')[0]!

        // Check if the agent has any child processes (tool execution)
        execFile('pgrep', ['-P', agentPid], (err3, childOut) => {
          const hasChildren = !err3

          if (hasChildren) {
            const childPids = childOut.trim().split('\n').filter(Boolean)
            // Agent has children — tool is genuinely executing
            if (this.idleStreak.has(session.name) || this.processTreeOverride.has(session.name)) {
              log.info('status-watcher', `${session.name}: children found (pids ${childPids.join(',')}), agent is working`)
            }
            this.idleStreak.delete(session.name)
            this.processTreeOverride.delete(session.name)
            if (session.state !== 'running') {
              this.transitionState(session, 'running')
            }
          } else {
            // No children — agent may be waiting for input
            const streak = (this.idleStreak.get(session.name) ?? 0) + 1
            this.idleStreak.set(session.name, streak)

            if (streak >= 2 && !this.processTreeOverride.has(session.name)) {
              log.info('status-watcher', `${session.name}: tool_use pending but no children (agent pid ${agentPid}), streak=${streak} — blocked on input`)
              this.processTreeOverride.add(session.name)
              if (session.state !== 'idle') {
                this.transitionState(session, 'idle')
              }
            }
          }
        })
      })
    })
  }

  private transitionState(session: Session, newState: SessionState): void {
    setState(this.opts.sessionsDir, session.name, newState)
    this.opts.onStatusChanged(session.name, newState)
    log.info('status-watcher', `${session.name}: ${session.state} → ${newState}`)

    // Parse transcript for recap entries on idle transitions
    if (newState === 'idle' && this.opts.onRecapEntries) {
      const workdir = session.workspace?.path
      const convId = session.conversation?.id
      if (!workdir || !convId) return

      const stateDir = session.backend === 'docker'
        ? claudeStateDir(this.opts.sessionsDir, session.name)
        : undefined

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

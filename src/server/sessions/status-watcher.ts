import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { listSessions, setState, setConversationId, claudeStateDir, type Session, type SessionState } from './session'
import { readSessionStatusDetailAt, parseNewEntriesAt, getProjectDir, getTranscriptPath, resetOffset, findTranscriptByConvId } from './transcript-parser'
import { discoverTranscript, readCodexStatus, parseCodexRecapEntries } from './codex-transcript'
import { log } from '../logger'
import { execFile } from 'node:child_process'
import type { RecapEntry } from '../../types'

export interface StatusWatcherOpts {
  sessionsDir: string
  /** Called when a session's status changes based on JSONL evidence */
  onStatusChanged: (name: string, state: SessionState) => void
  /** Called with new recap entries parsed from the transcript */
  onRecapEntries?: (name: string, entries: RecapEntry[]) => void
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
  /** Cached Claude transcript paths for sessions without a workspace.path */
  private readonly claudeTranscripts = new Map<string, string>()
  /** Snapshot of live sessions for the current tick — used to detect peer claims on shared project dirs */
  private peerSessions: readonly Session[] = []

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
      this.peerSessions = sessions
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
    let convId = session.conversation?.id
    if (!convId) return

    const stateDir = session.backend === 'docker'
      ? claudeStateDir(this.opts.sessionsDir, session.name)
      : undefined

    // /clear (or --resume to a different conversation) starts a new JSONL
    // file. If the project dir holds a newer transcript than the one we're
    // tracking, adopt it — otherwise status reads from a dead file forever.
    //
    // Multi-agent caveat: when N tmux sessions share a workdir, they share
    // `~/.claude/projects/<encoded-workdir>/`. We must NOT adopt a transcript
    // already claimed by another live session — that would cross-pollinate
    // (session A picks up B's convId whenever B writes more recently).
    if (workdir) {
      const adopted = this.maybeAdoptNewerConversation(session, workdir, convId, stateDir)
      if (adopted) convId = adopted
    }

    const transcriptPath = this.resolveClaudeTranscriptPath(session, workdir, convId, stateDir)
    if (!transcriptPath) {
      // No transcript discoverable yet (typical for a freshly-spawned session
      // before its first turn, or a session with no workspace whose JSONL
      // hasn't appeared anywhere on disk yet). On tmux we still get a usable
      // running/idle signal from the process tree.
      if (!workdir && session.backend === 'tmux') {
        this.checkProcessTree(session)
      }
      return
    }

    const detail = readSessionStatusDetailAt(transcriptPath)
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

  /**
   * Resolve the on-disk transcript path for a Claude session. Prefers
   * computing from `workspace.path` + convId. When workspace.path is null
   * (legacy session, or one spawned without a project), scans
   * `~/.claude/projects/*\/<convId>.jsonl` and caches the result.
   */
  private resolveClaudeTranscriptPath(
    session: Session,
    workdir: string | null | undefined,
    convId: string,
    stateDir: string | undefined,
  ): string | null {
    if (workdir) return getTranscriptPath(workdir, convId, stateDir)

    const cached = this.claudeTranscripts.get(session.name)
    if (cached && existsSync(cached)) return cached
    if (cached) this.claudeTranscripts.delete(session.name)

    const found = findTranscriptByConvId(convId)
    if (found) {
      this.claudeTranscripts.set(session.name, found)
      log.info('status-watcher', `${session.name}: discovered transcript ${found} (no workspace.path on session)`)
    }
    return found
  }

  /**
   * Collect convIds currently claimed by *other* live sessions sharing the
   * given project dir. Used to keep a session from adopting a peer's
   * transcript when N agents share a workdir.
   *
   * The shared-workdir case: every agent's transcript lives in the same
   * `~/.claude/projects/<encoded-workdir>/` directory. Without this filter,
   * `findNewestByMtime` would return whichever peer is most recently active.
   */
  private collectClaimedByPeers(self: Session, projectDir: string): Set<string> {
    const claimed = new Set<string>()
    const sessions = this.peerSessions ?? []
    for (const s of sessions) {
      if (s.name === self.name) continue
      if (s.state !== 'running' && s.state !== 'idle') continue
      const otherWorkdir = s.workspace?.path
      if (!otherWorkdir) continue
      const otherStateDir = s.backend === 'docker'
        ? claudeStateDir(this.opts.sessionsDir, s.name)
        : undefined
      // Only peers whose project dir resolves to the same path as ours can
      // collide. This naturally excludes docker peers (their state dir is
      // separate) and tmux peers in different workdirs.
      if (getProjectDir(otherWorkdir, otherStateDir) !== projectDir) continue
      const otherConvId = s.conversation?.id
      if (otherConvId) claimed.add(otherConvId)
    }
    return claimed
  }

  /**
   * If the project dir contains a .jsonl with a newer mtime than the tracked
   * conversation AND that .jsonl isn't claimed by another live session,
   * swap to it. Returns the new conversation id when adopted.
   *
   * This is the multi-agent-safe replacement for the old "adopt newest by
   * mtime" heuristic. The exclusion filter is what prevents session A from
   * picking up session B's convId when both run in the same workdir.
   */
  private maybeAdoptNewerConversation(
    session: Session,
    workdir: string,
    convId: string,
    stateDir: string | undefined,
  ): string | null {
    const projectDir = getProjectDir(workdir, stateDir)
    const claimedByPeers = this.collectClaimedByPeers(session, projectDir)

    // If our tracked convId is also claimed by a peer, we've already
    // cross-pollinated. Symmetry-break by `session.created`: each session
    // looks for an unclaimed file born during its own lifetime, which is
    // the file the agent process has been writing. Different sessions have
    // different `created` times → different candidate sets → different
    // adoption decisions. No global coordination needed.
    if (claimedByPeers.has(convId)) {
      const sessionStartMs = Date.parse(session.created)
      if (Number.isNaN(sessionStartMs)) return null
      const candidate = findNewestUnclaimedJsonl(projectDir, claimedByPeers, sessionStartMs)
      if (!candidate || candidate.convId === convId) return null
      setConversationId(this.opts.sessionsDir, session.name, candidate.convId)
      resetOffset(session.name)
      log.info(
        'status-watcher',
        `${session.name}: repaired contested convId — adopted ${candidate.convId} (was ${convId}, born after session.created)`,
      )
      return candidate.convId
    }

    // Normal /clear (or --resume) path: adopt only if a non-peer transcript
    // is newer than what we're tracking.
    const candidate = findNewestUnclaimedJsonl(projectDir, claimedByPeers)
    if (!candidate || candidate.convId === convId) return null

    const trackedPath = getTranscriptPath(workdir, convId, stateDir)
    const trackedMtime = existsSync(trackedPath) ? statSync(trackedPath).mtimeMs : 0
    if (candidate.mtime <= trackedMtime) return null

    setConversationId(this.opts.sessionsDir, session.name, candidate.convId)
    resetOffset(session.name) // recap parser starts fresh on the new file
    log.info('status-watcher', `${session.name}: adopted newer conversation ${candidate.convId} (was ${convId})`)
    return candidate.convId
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
      const convId = session.conversation?.id
      if (!convId) return

      const workdir = session.workspace?.path
      const stateDir = session.backend === 'docker'
        ? claudeStateDir(this.opts.sessionsDir, session.name)
        : undefined

      // Resolve the path the same way the main poll loop does — handles
      // the marshal/no-workspace case via findTranscriptByConvId.
      const transcriptPath = this.resolveClaudeTranscriptPath(session, workdir, convId, stateDir)
      if (!transcriptPath) return

      try {
        const entries = parseNewEntriesAt(session.name, transcriptPath)
        if (entries.length > 0) {
          this.opts.onRecapEntries(session.name, entries)
        }
      } catch (err) {
        log.warn('status-watcher', `transcript parse failed for ${session.name}: ${err}`)
      }
    }
  }
}

/**
 * Pick the newest .jsonl in `projectDir` whose convId (filename stem) is not
 * in `claimed`. When `minBirthtimeMs` is provided, only files whose
 * filesystem birthtime is at or after that timestamp are considered — used
 * to filter to "files born during this session's lifetime" when repairing
 * a cross-pollinated convId. Returns `{ convId, mtime }` or null.
 *
 * Exported for tests.
 */
export function findNewestUnclaimedJsonl(
  projectDir: string,
  claimed: Set<string>,
  minBirthtimeMs?: number,
): { convId: string; mtime: number } | null {
  let entries: string[]
  try {
    entries = readdirSync(projectDir)
  } catch {
    return null
  }
  let best: { convId: string; mtime: number } | null = null
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const convId = name.slice(0, -'.jsonl'.length)
    if (claimed.has(convId)) continue
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(join(projectDir, name))
    } catch {
      continue
    }
    if (minBirthtimeMs !== undefined && stat.birthtimeMs < minBirthtimeMs) continue
    if (!best || stat.mtimeMs > best.mtime) best = { convId, mtime: stat.mtimeMs }
  }
  return best
}

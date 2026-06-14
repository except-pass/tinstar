import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { listSessions, setState, setConversationId, type Session, type SessionState } from './session'
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
  /** Called once per tick with the set of session names currently on disk */
  onSessionsListed?: (names: Set<string>) => void
  /** Poll interval in ms (default 3000) */
  intervalMs?: number
  /**
   * Resolve a session name to its tmux target. Injected so callers can route
   * through the configured `sessions.prefix` (see backends/tmux.ts
   * `tmuxSessionName`). Defaults to `tinstar-${name}` to preserve behavior for
   * callers that don't supply one.
   */
  resolveTmuxName?: (sessionName: string) => string
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
      this.opts.onSessionsListed?.(new Set(sessions.map(s => s.name)))
      this.resolveTickConversations(sessions)
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
    if (!convId) return

    const stateDir = undefined

    // convId resolution (adopt-newer for /clear, repair for shared-workdir
    // cross-pollination) happens once per tick in resolveTickConversations,
    // which has already updated session.conversation.id in place. Here we just
    // read the resolved value.
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
   * Resolve, once per tick, which convId each Claude session should track.
   *
   * Sessions are grouped by their shared project dir (`~/.claude/projects/
   * <encoded-workdir>/`), then `planSharedDirAssignments` assigns each a
   * distinct transcript with claims threaded live across the group. This is
   * the multi-agent-safe replacement for the old per-session adopt/repair
   * pass, whose stale per-tick snapshot let two sessions adopt the same orphan
   * transcript and then repair away from it forever (a 3s flip-flop loop).
   *
   * Mutates `session.conversation.id` in place (so the rest of the tick reads
   * the resolved value) and persists changes to disk.
   */
  private resolveTickConversations(sessions: readonly Session[]): void {
    // Group eligible sessions by project dir.
    const groups = new Map<string, Session[]>()
    for (const s of sessions) {
      const adapter = (s as Session & { adapter?: string | null }).adapter ?? 'claude'
      if (adapter !== 'claude' || s.backend !== 'tmux') continue
      if (s.state !== 'running' && s.state !== 'idle') continue
      const workdir = s.workspace?.path
      if (!workdir || !s.conversation?.id) continue
      const projectDir = getProjectDir(workdir, undefined)
      const arr = groups.get(projectDir)
      if (arr) arr.push(s)
      else groups.set(projectDir, [s])
    }

    for (const [projectDir, group] of groups) {
      const transcripts = listTranscripts(projectDir)
      if (transcripts.length === 0) continue
      const assignment = planSharedDirAssignments(
        group.map((s) => ({
          name: s.name,
          convId: s.conversation!.id!,
          createdMs: Date.parse(s.created),
        })),
        transcripts,
      )
      for (const s of group) {
        const current = s.conversation!.id
        const next = assignment.get(s.name)
        if (!next || next === current) continue
        setConversationId(this.opts.sessionsDir, s.name, next)
        resetOffset(s.name) // recap parser starts fresh on the new file
        if (s.conversation) s.conversation.id = next // reflect in-tick for checkSession
        const shared = group.length > 1 ? ' (shared workdir)' : ''
        log.info('status-watcher', `${s.name}: convId ${current} → ${next}${shared}`)
      }
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
    const tmuxTarget = this.opts.resolveTmuxName
      ? this.opts.resolveTmuxName(session.name)
      : `tinstar-${session.name}`

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

      // Resolve the path the same way the main poll loop does — handles
      // the marshal/no-workspace case via findTranscriptByConvId.
      const transcriptPath = this.resolveClaudeTranscriptPath(session, workdir, convId, undefined)
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
  const picked = pickNewestUnclaimed(listTranscripts(projectDir), claimed, minBirthtimeMs)
  return picked ? { convId: picked.convId, mtime: picked.mtimeMs } : null
}

/** A conversation transcript file's identity and timestamps. */
export interface TranscriptInfo {
  convId: string
  mtimeMs: number
  birthtimeMs: number
}

/** List every .jsonl transcript in a project dir with its timestamps. */
export function listTranscripts(projectDir: string): TranscriptInfo[] {
  let entries: string[]
  try {
    entries = readdirSync(projectDir)
  } catch {
    return []
  }
  const out: TranscriptInfo[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(join(projectDir, name))
    } catch {
      continue
    }
    out.push({
      convId: name.slice(0, -'.jsonl'.length),
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
    })
  }
  return out
}

/**
 * Pure core of findNewestUnclaimedJsonl: pick the newest transcript whose
 * convId isn't claimed and (optionally) was born at/after `minBirthtimeMs`.
 */
export function pickNewestUnclaimed(
  transcripts: TranscriptInfo[],
  claimed: Set<string>,
  minBirthtimeMs?: number,
): TranscriptInfo | null {
  let best: TranscriptInfo | null = null
  for (const t of transcripts) {
    if (claimed.has(t.convId)) continue
    if (minBirthtimeMs !== undefined && t.birthtimeMs < minBirthtimeMs) continue
    if (!best || t.mtimeMs > best.mtimeMs) best = t
  }
  return best
}

/**
 * Decide the convId a single session should track, given the transcripts in
 * its shared project dir and the convIds claimed by live peers. Pure: this is
 * the per-session core, mirroring the two cases the watcher must handle.
 *
 *  - Normal (uncontested): track our own launch transcript and nothing else.
 *    We deliberately do NOT adopt a "newer unclaimed" transcript here. A
 *    session's convId equals the unique `--session-id` it was launched with
 *    (see createSession), so its own file is authoritative. In a shared
 *    workdir the project dir fills with orphan transcripts — dead peers,
 *    `/clear` leftovers, and especially headless `claude -p` runs (code
 *    reviewers, subagents) — and a newer orphan is filesystem-indistinguishable
 *    from a legitimate in-place `/clear` successor. The old "adopt newest
 *    unclaimed" rule made live sessions hop onto strangers' transcripts,
 *    producing wrong status lights and telemetry misattributed between
 *    co-located sessions. We choose correct attribution over live `/clear`
 *    discovery; an in-place `/clear` re-tracks when the session is
 *    relaunched/resumed (which sets conversation.id deliberately).
 *  - Contested: the convId we track is also claimed by a live peer (residual
 *    cross-pollination). Repair to our own file — newest unclaimed born at/after
 *    we started (the birthtime floor breaks symmetry between peers).
 */
export function decideConversationId(args: {
  currentConvId: string
  sessionCreatedMs: number
  transcripts: TranscriptInfo[]
  claimedByPeers: Set<string>
}): string {
  const { currentConvId, sessionCreatedMs, transcripts, claimedByPeers } = args

  // Uncontested: keep our own launch transcript. Never chase a newer orphan.
  if (!claimedByPeers.has(currentConvId)) return currentConvId

  // Contested: repair to our own file, born at/after we started.
  const floor = Number.isNaN(sessionCreatedMs) ? undefined : sessionCreatedMs
  const candidate = pickNewestUnclaimed(transcripts, claimedByPeers, floor)
  if (!candidate || candidate.convId === currentConvId) return currentConvId
  return candidate.convId
}

/**
 * Resolve the convId each session sharing one project dir should track for a
 * single watcher tick. Claims accumulate *live* across sessions (in listing
 * order) so the contested-repair branch never lands two sessions on the same
 * transcript in one tick. Since the uncontested branch no longer adopts newer
 * orphans (see decideConversationId), each session simply keeps its own launch
 * transcript — the old adopt→repair oscillation (and the orphan-chasing
 * misattribution it masked) is gone by construction.
 */
export function planSharedDirAssignments(
  sessions: { name: string; convId: string; createdMs: number }[],
  transcripts: TranscriptInfo[],
): Map<string, string> {
  const live = new Map<string, string>(sessions.map((s) => [s.name, s.convId]))
  for (const s of sessions) {
    const claimedByPeers = new Set<string>()
    for (const other of sessions) {
      if (other.name === s.name) continue
      const claim = live.get(other.name)
      if (claim) claimedByPeers.add(claim)
    }
    const decided = decideConversationId({
      currentConvId: live.get(s.name) ?? s.convId,
      sessionCreatedMs: s.createdMs,
      transcripts,
      claimedByPeers,
    })
    live.set(s.name, decided)
  }
  return live
}

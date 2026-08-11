import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { listSessions, setState, setConversationId, updateSession, type Session, type SessionState } from './session'
import {
  captureScreen,
  exactTmuxPaneTarget,
  isOrdinaryTmuxSessionMiss,
} from './backends/tmux'
import { log } from '../logger'
import { execFile } from 'node:child_process'
import type { RecapEntry } from '../../types'
import {
  defaultProviderRegistry,
  type ProviderAdapterRegistry,
  type ProviderTranscriptAdapter,
} from '../providers/lifecycle'
import type { ProviderTranscriptObservationEvent } from '../providers/observation-ingestor'
import type { ProviderSource } from '../../domain/provider-capabilities'

export interface StatusWatcherOpts {
  sessionsDir: string
  /**
   * Called when a session's status changes based on JSONL evidence, and ALSO
   * when the blocked signal flips while the state string is unchanged (a
   * permission block beginning or resolving on an already-idle session) —
   * attention is derived from `(status, blocked, background)` downstream, so
   * every input change must be observable. `blocked` = the agent is stuck on
   * a pending tool_use with no child processes (the process-tree override).
   */
  onStatusChanged: (name: string, state: SessionState, blocked: boolean) => void
  /** Called with new recap entries parsed from the transcript */
  onRecapEntries?: (name: string, entries: RecapEntry[]) => void
  /** Called once per tick with the set of session names currently on disk */
  onSessionsListed?: (names: Set<string>) => void
  /** Provider-neutral normalized transcript observations. */
  onObservations?: (
    providerId: string,
    sessionId: string,
    accountRef: string,
    source: ProviderSource,
    observations: ProviderTranscriptObservationEvent[],
  ) => void
  /** Clear session-scoped observation state when an incarnation is retired. */
  onSessionObservationsCleared?: (providerId: string, sessionId: string) => void
  /** Poll interval in ms (default 3000) */
  intervalMs?: number
  /** Maximum time for one provider transcript discovery (default 15000ms). */
  providerPollTimeoutMs?: number
  /** Maximum time for one tmux/pgrep liveness probe (default 2000ms). */
  processProbeTimeoutMs?: number
  /**
   * Resolve a session name to its tmux target. Injected so callers can route
   * through the configured `sessions.prefix` (see backends/tmux.ts
   * `tmuxSessionName`). Defaults to `tinstar-${name}` to preserve behavior for
   * callers that don't supply one.
   */
  resolveTmuxName?: (sessionName: string) => string
  /** Optional lifecycle-generation fence for async process-tree probes. */
  captureBackendGeneration?: (sessionName: string) => string | null
  isBackendGenerationCurrent?: (
    sessionName: string,
    generation: string,
  ) => boolean
  /** Injectable for tests and third-party providers; defaults to built-ins. */
  providerRegistry?: ProviderAdapterRegistry
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
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private readonly opts: StatusWatcherOpts
  private readonly interval: number
  private readonly providerPollTimeoutMs: number
  private readonly processProbeTimeoutMs: number
  private readonly providerRegistry: ProviderAdapterRegistry
  /** Tracks consecutive "no children" polls per session for debouncing */
  private readonly idleStreak = new Map<string, number>()
  /** Sessions where process-tree check has overridden JSONL to idle */
  private readonly processTreeOverride = new Set<string>()
  /** Provider-neutral discovered transcript paths per managed session. */
  private readonly transcriptPaths = new Map<string, string>()
  /** One discovery per session at a time, retained across timeout boundaries. */
  private readonly transcriptDiscoveries = new Map<string, Promise<string | null>>()
  /** Retained only so deleted sessions can release provider-owned recap offsets. */
  private readonly transcriptAdapters = new Map<string, ProviderTranscriptAdapter>()
  /** Guards all name-keyed caches against session-name reuse. */
  private readonly sessionIncarnations = new Map<string, string>()
  /** Provider owning the current session incarnation, retained for cleanup. */
  private readonly observationProviders = new Map<string, string>()
  /** Rate-limit diagnostics while lifecycle ownership is intentionally fenced. */
  private readonly backendOwnershipWarnings = new Set<string>()

  constructor(opts: StatusWatcherOpts) {
    this.opts = opts
    this.interval = opts.intervalMs ?? 3000
    this.providerPollTimeoutMs = opts.providerPollTimeoutMs ?? 15_000
    this.processProbeTimeoutMs = opts.processProbeTimeoutMs ?? 2_000
    this.providerRegistry = opts.providerRegistry ?? defaultProviderRegistry
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.runLoop()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Self-scheduling so a slow provider poll can never overlap the next tick. */
  private async runLoop(): Promise<void> {
    await this.tick()
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runLoop()
    }, this.interval)
  }

  private async tick(): Promise<void> {
    try {
      const sessions = await listSessions(this.opts.sessionsDir)
      const names = new Set(sessions.map(s => s.name))
      this.opts.onSessionsListed?.(names)
      this.resolveTickConversations(sessions)
      const liveSessions = sessions.filter(
        session => session.state === 'running' || session.state === 'idle',
      )
      this.pruneInactiveSessions(
        new Set(liveSessions.map(session => session.name)),
        names,
      )
      const results = await Promise.allSettled(
        liveSessions.map(session => this.checkSession(session)),
      )
      results.forEach((result, index) => {
        if (result.status !== 'rejected') return
        log.warn(
          'status-watcher',
          `${liveSessions[index]!.name}: provider poll failed: ${String(result.reason)}`,
        )
      })
    } catch (err) {
      log.warn('status-watcher', `tick failed: ${(err as Error).message}`)
    }
  }

  private async checkSession(session: Session): Promise<void> {
    this.reconcileSessionIncarnation(session)

    // Rehydrate the in-memory override after a server restart. Without this,
    // a persisted blocked:true can survive forever even after evidence clears.
    if (session.blocked) this.processTreeOverride.add(session.name)

    let transcript: ProviderTranscriptAdapter | null
    try {
      const provider = this.providerRegistry.resolveSession(session)
      this.observationProviders.set(session.name, provider.provider.id)
      transcript = provider.terminal.transcript
    } catch (err) {
      log.warn(
        'status-watcher',
        `${session.name}: ${(err as Error).message}; using process-tree liveness`,
      )
      await this.checkProcessTree(session)
      return
    }

    // Capability-light providers intentionally have no transcript parser.
    if (!transcript) {
      this.transcriptAdapters.delete(session.name)
      // Transcript-less providers rely exclusively on the process tree. Keep
      // polling even while blocked so returning child processes clear it.
      await this.checkProcessTree(session)
      return
    }
    this.transcriptAdapters.set(session.name, transcript)

    let transcriptPath = this.transcriptPaths.get(session.name)
    if (transcriptPath && !existsSync(transcriptPath)) {
      this.transcriptPaths.delete(session.name)
      transcriptPath = undefined
    }
    if (!transcriptPath) {
      const tmuxName = this.resolveTmuxName(session.name)
      let discovery = this.transcriptDiscoveries.get(session.name)
      if (!discovery) {
        const discoveryIncarnation = this.sessionIncarnations.get(session.name)
        try {
          discovery = Promise.resolve(transcript.discover({
            session,
            tmuxName,
            captureScreen: (name, scrollback) =>
              captureScreen(name, scrollback, this.providerPollTimeoutMs),
          }))
        } catch (err) {
          discovery = Promise.reject(err)
        }
        this.transcriptDiscoveries.set(session.name, discovery)

        // Discovery is intentionally detached from the tick. A provider can
        // keep looking for its transcript without delaying healthy sessions,
        // while the map guarantees only one live request per session.
        void discovery.then(
          (discovered) => {
            if (
              this.transcriptDiscoveries.get(session.name) !== discovery
              || this.sessionIncarnations.get(session.name) !== discoveryIncarnation
            ) return
            if (!discovered) return
            this.transcriptPaths.set(session.name, discovered)
            log.info('status-watcher', `${session.name}: provider transcript discovered`)
          },
          (err) => {
            if (
              this.transcriptDiscoveries.get(session.name) !== discovery
              || this.sessionIncarnations.get(session.name) !== discoveryIncarnation
            ) return
            log.warn(
              'status-watcher',
              `${session.name}: transcript discovery failed: ${(err as Error).message}`,
            )
          },
        ).finally(() => {
          if (this.transcriptDiscoveries.get(session.name) === discovery) {
            this.transcriptDiscoveries.delete(session.name)
          }
        })

        // The provider timeout is observability, not tick backpressure. The
        // underlying request remains single-flight and may still complete.
        void this.withProviderTimeout(
          discovery,
          `${session.name}: transcript discovery`,
        ).catch((err) => {
          if (
            this.transcriptDiscoveries.get(session.name) === discovery
            && this.sessionIncarnations.get(session.name) === discoveryIncarnation
            && (err as Error).message.includes('timed out')
          ) {
            log.warn(
              'status-watcher',
              `${session.name}: transcript discovery failed: ${(err as Error).message}`,
            )
          }
        })
      }

      // Give already-settled discovery promises one microtask to populate the
      // cache. This preserves same-tick parsing for cheap providers without
      // waiting for an I/O-bound provider.
      await Promise.resolve()
      transcriptPath = this.transcriptPaths.get(session.name)
    }
    if (!transcriptPath) {
      await this.checkProcessTree(session)
      return
    }

    if (transcript.observations) {
      try {
        const observations = transcript.observations.read(session.name, transcriptPath)
        if (observations.length > 0) {
          this.opts.onObservations?.(
            this.observationProviders.get(session.name)!,
            session.name,
            transcript.observations.accountRef,
            transcript.observations.source,
            observations,
          )
        }
      } catch (err) {
        log.warn(
          'status-watcher',
          `${session.name}: provider observations failed: ${(err as Error).message}`,
        )
      }
    }

    const detail = transcript.readStatus(transcriptPath)
    if (!detail) return

    // When JSONL shows a pending tool_use on a tmux session, use the process
    // tree to determine the real state. This catches both:
    // - session currently "running" that might be blocked on permission
    // - session we already flipped to "idle" that might have resumed
    if (detail.toolPending && session.backend === 'tmux') {
      this.parseRecapEntries(session, transcript, transcriptPath, 'running')
      if (this.processTreeOverride.has(session.name)) {
        return // already determined blocked — skip until JSONL changes
      }
      await this.checkProcessTree(session)
      return
    }

    // JSONL no longer shows tool_use pending — clear any process-tree override
    if (this.processTreeOverride.has(session.name)) {
      log.info('status-watcher', `${session.name}: tool_use resolved, clearing process-tree override`)
      this.processTreeOverride.delete(session.name)
      this.idleStreak.delete(session.name)
      this.persistBlocked(session, false)
      if (detail.state === session.state) {
        // No state-string change coming below — notify explicitly so stale
        // "Waiting on permission" attention re-derives away. (When the state
        // did change, the transition below carries blocked: false itself.)
        this.opts.onStatusChanged(session.name, session.state, false)
      }
    }

    if (detail.state !== session.state) {
      // Providers choose their idle debounce. Claude needs two observations
      // because text blocks between tool calls briefly look idle; Codex lifecycle
      // events are stable and transition immediately.
      if (session.state === 'running' && detail.state === 'idle') {
        const streak = (this.idleStreak.get(session.name) ?? 0) + 1
        this.idleStreak.set(session.name, streak)
        if (streak < (transcript.idleDebouncePolls ?? 2)) {
          this.parseRecapEntries(session, transcript, transcriptPath, 'running')
          return
        }
        log.info('status-watcher', `${session.name}: idle confirmed (streak=${streak})`)
      }
      this.idleStreak.delete(session.name)
      this.transitionState(session, detail.state)
    } else {
      // State unchanged — reset idle streak
      this.idleStreak.delete(session.name)
    }
    this.parseRecapEntries(session, transcript, transcriptPath, detail.state)
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
    const groups = new Map<
      string,
      {
        projectDir: string
        sessions: Session[]
        transcript: ProviderTranscriptAdapter
      }
    >()
    for (const s of sessions) {
      let provider
      try {
        provider = this.providerRegistry.resolveSession(s)
      } catch {
        continue
      }
      const transcript = provider.terminal.transcript
      if (!transcript?.conversationProjectDir || s.backend !== 'tmux') continue
      if (s.state !== 'running' && s.state !== 'idle') continue
      const workdir = s.workspace?.path
      if (!workdir || !s.conversation?.id) continue
      let projectDir: string
      try {
        projectDir = transcript.conversationProjectDir(workdir)
      } catch (err) {
        log.warn(
          'status-watcher',
          `${s.name}: conversation project resolution failed: ${(err as Error).message}`,
        )
        continue
      }
      const key = JSON.stringify([provider.provider.id, projectDir])
      const group = groups.get(key)
      if (group) group.sessions.push(s)
      else groups.set(key, { projectDir, sessions: [s], transcript })
    }

    for (const { projectDir, sessions: group, transcript } of groups.values()) {
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
        this.transcriptPaths.delete(s.name)
        this.transcriptDiscoveries.delete(s.name)
        if (s.conversation) s.conversation.id = next // reflect in-tick for checkSession
        this.sessionIncarnations.set(s.name, this.sessionIncarnationKey(s))
        try {
          transcript.resetOffset(s.name)
        } catch (err) {
          log.warn(
            'status-watcher',
            `${s.name}: provider transcript reset failed: ${(err as Error).message}`,
          )
        }
        const shared = group.length > 1 ? ' (shared workdir)' : ''
        log.info('status-watcher', `${s.name}: convId ${current} → ${next}${shared}`)
      }
    }
  }

  private async checkProcessTree(session: Session): Promise<void> {
    const backendGeneration = this.opts.captureBackendGeneration?.(session.name)
    if (this.opts.captureBackendGeneration && backendGeneration === null) {
      if (!this.backendOwnershipWarnings.has(session.name)) {
        this.backendOwnershipWarnings.add(session.name)
        log.warn(
          'status-watcher',
          `${session.name}: skipping liveness probe while backend ownership is unavailable`,
        )
      }
      return
    }
    this.backendOwnershipWarnings.delete(session.name)
    const generationIsCurrent = (): boolean =>
      backendGeneration === undefined
      || backendGeneration === null
      || !this.opts.isBackendGenerationCurrent
      || this.opts.isBackendGenerationCurrent(session.name, backendGeneration)

    const tmuxTarget = this.resolveTmuxName(session.name)

    // Get the PID of the process running in the tmux pane
    const pane = await this.execProcess(
      'tmux',
      ['list-panes', '-t', exactTmuxPaneTarget(tmuxTarget), '-F', '#{pane_pid}'],
    )
    if (!generationIsCurrent()) return
    if (pane.error) {
      if (this.isProcessProbeTimeout(pane.error)) {
        log.debug(
          'status-watcher',
          `${session.name}: tmux pane lookup timed out; liveness is inconclusive`,
        )
        this.idleStreak.delete(session.name)
        return
      }
      if (!isOrdinaryTmuxSessionMiss(pane.error, pane.stderr)) {
        log.debug(
          'status-watcher',
          `${session.name}: tmux pane lookup failed; liveness is inconclusive: `
          + `${pane.error.message}`,
        )
        this.idleStreak.delete(session.name)
        return
      }
      log.debug('status-watcher', `${session.name}: tmux pane lookup failed: ${pane.error.message}`)
      this.idleStreak.delete(session.name)
      // Tmux session is gone — drop any blocked override with it (a dead
      // session can't be waiting on a permission prompt) and mark stopped.
      this.processTreeOverride.delete(session.name)
      if (session.state === 'running' || session.state === 'idle') {
        this.transitionState(session, 'stopped')
      }
      return
    }

    const shellPid = pane.stdout.trim().split('\n')[0]
    if (!shellPid) return

    // Find the agent process (direct child of the shell)
    const agent = await this.execProcess('pgrep', ['-P', shellPid])
    if (!generationIsCurrent()) return
    if (agent.error && this.isProcessProbeTimeout(agent.error)) {
      log.debug(
        'status-watcher',
        `${session.name}: agent process lookup timed out; liveness is inconclusive`,
      )
      this.idleStreak.delete(session.name)
      return
    }
    if (agent.error && !this.isPgrepNoMatch(agent.error)) {
      log.debug(
        'status-watcher',
        `${session.name}: agent process lookup failed; liveness is inconclusive: ${agent.error.message}`,
      )
      this.idleStreak.delete(session.name)
      return
    }
    if (agent.error || !agent.stdout.trim()) {
      log.debug('status-watcher', `${session.name}: no agent process under shell pid ${shellPid}`)
      this.idleStreak.delete(session.name)
      return
    }

    const agentPid = agent.stdout.trim().split('\n')[0]!

    // Check if the agent has any child processes (tool execution)
    const children = await this.execProcess('pgrep', ['-P', agentPid])
    if (!generationIsCurrent()) return
    if (children.error && this.isProcessProbeTimeout(children.error)) {
      log.debug(
        'status-watcher',
        `${session.name}: child process lookup timed out; liveness is inconclusive`,
      )
      this.idleStreak.delete(session.name)
      return
    }
    if (children.error && !this.isPgrepNoMatch(children.error)) {
      log.debug(
        'status-watcher',
        `${session.name}: child process lookup failed; liveness is inconclusive: ${children.error.message}`,
      )
      this.idleStreak.delete(session.name)
      return
    }
    const hasChildren = !children.error && !!children.stdout.trim()

    if (hasChildren) {
      const childPids = children.stdout.trim().split('\n').filter(Boolean)
      // Agent has children — tool is genuinely executing
      if (this.idleStreak.has(session.name) || this.processTreeOverride.has(session.name)) {
        log.info('status-watcher', `${session.name}: children found (pids ${childPids.join(',')}), agent is working`)
      }
      this.idleStreak.delete(session.name)
      const hadOverride = this.processTreeOverride.delete(session.name)
      if (hadOverride) this.persistBlocked(session, false)
      if (session.state !== 'running') {
        this.transitionState(session, 'running')
      } else if (hadOverride) {
        // State string unchanged but the blocked input flipped —
        // notify so downstream attention re-derives.
        this.opts.onStatusChanged(session.name, 'running', false)
      }
    } else {
      // No children — agent may be waiting for input
      const streak = (this.idleStreak.get(session.name) ?? 0) + 1
      this.idleStreak.set(session.name, streak)

      if (streak >= 2 && !this.processTreeOverride.has(session.name)) {
        log.info('status-watcher', `${session.name}: tool_use pending but no children (agent pid ${agentPid}), streak=${streak} — blocked on input`)
        this.processTreeOverride.add(session.name)
        this.persistBlocked(session, true)
        if (session.state !== 'idle') {
          this.transitionState(session, 'idle')
        } else {
          // Block began while already idle: no state-string change, but
          // blocked flipped — notify so attention derives urgent instead
          // of wedging silently (the verified silent-failure path).
          this.opts.onStatusChanged(session.name, 'idle', true)
        }
      }
    }
  }

  /**
   * Persist a blocked flip to session.json so restarts re-derive attention
   * from disk instead of losing the in-memory override. Mirrors onto the
   * in-memory Session so the rest of this tick reads the new value.
   */
  private persistBlocked(session: Session, blocked: boolean): void {
    if ((session.blocked ?? false) === blocked) return
    updateSession(this.opts.sessionsDir, session.name, { blocked })
    session.blocked = blocked
  }

  private transitionState(
    session: Session,
    newState: SessionState,
  ): void {
    // The blocked signal rides along on every transition: true only while the
    // process-tree override stands (and never for a stopped session — setState
    // clears the persisted flag on stop).
    const blocked = newState !== 'stopped' && this.processTreeOverride.has(session.name)
    setState(this.opts.sessionsDir, session.name, newState)
    this.opts.onStatusChanged(session.name, newState, blocked)
    log.info('status-watcher', `${session.name}: ${session.state} → ${newState}`)

  }

  private parseRecapEntries(
    session: Session,
    transcript: ProviderTranscriptAdapter,
    transcriptPath: string,
    lifecycle: 'running' | 'idle',
  ): void {
    try {
      const entries = transcript.parseRecapEntries(session.name, transcriptPath, lifecycle)
      if (entries.length > 0) this.opts.onRecapEntries?.(session.name, entries)
    } catch (err) {
      log.warn('status-watcher', `transcript parse failed for ${session.name}: ${err}`)
    }
  }

  private pruneInactiveSessions(
    liveNames: ReadonlySet<string>,
    existingNames: ReadonlySet<string>,
  ): void {
    const knownNames = new Set([
      ...this.transcriptAdapters.keys(),
      ...this.transcriptPaths.keys(),
      ...this.transcriptDiscoveries.keys(),
      ...this.idleStreak.keys(),
      ...this.processTreeOverride,
      ...this.sessionIncarnations.keys(),
      ...this.observationProviders.keys(),
      ...this.backendOwnershipWarnings,
    ])
    for (const name of knownNames) {
      if (liveNames.has(name)) continue
      if (existingNames.has(name)) {
        // A stopped session will resume the same conversation/transcript.
        // Rediscover its path on restart, but preserve the provider's byte
        // offset so old recap entries are not appended a second time.
        this.clearTransientSessionCaches(name)
      } else {
        // The record is gone, so this name can later identify a completely new
        // session. Forget both its incarnation and transcript offset.
        this.clearSessionCaches(name)
      }
    }
  }

  private reconcileSessionIncarnation(session: Session): void {
    const next = this.sessionIncarnationKey(session)
    const previous = this.sessionIncarnations.get(session.name)
    if (previous && previous !== next) this.clearSessionCaches(session.name)
    this.sessionIncarnations.set(session.name, next)
  }

  private sessionIncarnationKey(session: Session): string {
    return JSON.stringify([
      session.created,
      session.adapter ?? null,
      session.conversation?.id ?? null,
    ])
  }

  private clearSessionCaches(name: string): void {
    const providerId = this.observationProviders.get(name)
    try {
      this.transcriptAdapters.get(name)?.resetOffset(name)
    } catch (err) {
      log.warn(
        'status-watcher',
        `${name}: provider transcript cleanup failed: ${(err as Error).message}`,
      )
    } finally {
      if (providerId) {
        try {
          this.opts.onSessionObservationsCleared?.(providerId, name)
        } catch (err) {
          log.warn(
            'status-watcher',
            `${name}: provider observation cleanup failed: ${(err as Error).message}`,
          )
        }
      }
      this.observationProviders.delete(name)
      this.transcriptAdapters.delete(name)
      this.clearTransientSessionCaches(name)
      this.sessionIncarnations.delete(name)
    }
  }

  private clearTransientSessionCaches(name: string): void {
    this.transcriptPaths.delete(name)
    this.transcriptDiscoveries.delete(name)
    this.idleStreak.delete(name)
    this.processTreeOverride.delete(name)
    this.backendOwnershipWarnings.delete(name)
  }

  private isPgrepNoMatch(error: Error): boolean {
    const code = (error as Error & { code?: string | number }).code
    return code === 1 || code === '1'
  }

  private resolveTmuxName(sessionName: string): string {
    return this.opts.resolveTmuxName
      ? this.opts.resolveTmuxName(sessionName)
      : `tinstar-${sessionName}`
  }

  private execProcess(
    command: string,
    args: string[],
  ): Promise<{ error: Error | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(command, args, { timeout: this.processProbeTimeoutMs }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr })
      })
    })
  }

  private isProcessProbeTimeout(error: Error): boolean {
    const probeError = error as Error & { killed?: boolean; signal?: string }
    return probeError.killed === true || probeError.signal === 'SIGTERM'
  }

  private async withProviderTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${operation} timed out after ${this.providerPollTimeoutMs}ms`))
      }, this.providerPollTimeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
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

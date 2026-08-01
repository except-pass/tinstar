import type { Plugin } from 'vite'
import { EventBus } from './event-bus'
import { DocumentStore, runNeedsStatusCorrection } from './stores/document-store'
import { bootSurfaces } from './stores/surface-boot'
import { OTelStore } from './stores/otel-store'
import { DocumentProcessor } from './processors/document-processor'
import { OTelProcessor } from './processors/otel-processor'
import { SSEBroadcaster } from './api/sse'
import { handleRequest, ensureMarshalSession, type RouteContext } from './api/routes'
import { MockSensorSimulator } from './simulator/mock-sensors'
import { join } from 'node:path'
import { readdirSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { shortId } from './utils/shortId'
import { getConfigRoot } from './configRoot'
import { acquireBackendSingleton } from './infra/lock'
import {
  loadConfig,
  ensureDirs,
  loadActiveSpaceId,
  saveActiveSpaceId,
  reconcileSessionStates,
  tmuxBackend,
  getSession,
  updateSession,
  interactivePortWindow,
  refreshConfigProblem,
  type TinstarConfig,
} from './sessions'
import type { SessionStatus } from '../types'
import { getGitDiffFiles } from './sessions/git-diff'
import { StatusWatcher } from './sessions/status-watcher'
import { SlateWatcher } from './sessions/slate-watcher'
import { SurfaceService } from './surfaces/surface-service'
import type { SurfaceRefreshCoordinator } from './surfaces/surface-refresh-coordinator'
import { buildRefreshCoordinator, headRevision } from './surfaces/refresh-wiring'
import { slateSourceAdapters } from './surfaces/slate-source'
import { boundSlateRuns, reconcileSlateEpoch } from './surfaces/source-reconciler'
import { deriveRunIncarnation } from './stores/surfaces'
import { deriveLegacyRunRootId, LEGACY_SPACELESS_SPACE_ID } from './stores/surface-migration'
import { ReadyQueue } from './sessions/ReadyQueue'
import { log } from './logger'
import { reconcileGitHistory } from './commits'
import { NatsTrafficBridge } from './nats-traffic'
import { registerSaloonSubs } from './api/saloonBridge'
import { bootstrapHierarchicalTopicMetadata } from './topic-metadata'
import { NatsHealthMonitor } from './nats-health'
import { natsControlSocketPath } from './sessions/backends/tmux'
import { reconnectSessionNats } from './sessions/natsReconnect'
import { NatsManager } from './nats/nats-manager.js'
import { ObservabilityStack } from './observability/index.js'
import { observeFromRecapEntries, reconcileLiveSessions } from './observability/turn-length'
import { createTelemetryRoutes } from './api/telemetry.js'
import { OtlpExporter } from './stores/otlp-exporter'
import { CcQuotaService } from './cc-quota/service'
import { SlashCommandRegistry } from './sessions/slashCommandRegistry'
import { SlashUsage } from './sessions/slashUsage'
import { resolveSlashUsagePath } from './sessions/slashUsage-path'

// Module-level flag: ensures SIGINT/SIGTERM handlers are registered only once.
// If initBackend runs twice (Vite HMR), the second invocation skips registration
// so we avoid a double-signal race. The first instance's shutdown handler is
// accepted as-is — prod only calls initBackend once.
let shutdownRegistered = false

export function initBackend(): RouteContext {
  // Instantiate core components
  const bus = new EventBus()
  const docStore = new DocumentStore()
  const otelStore = new OTelStore()

  // Wire processors
  new DocumentProcessor(bus, docStore)
  const otlpExporter = new OtlpExporter()
  otlpExporter.start()
  const slashRegistry = new SlashCommandRegistry()
  const slashUsage = new SlashUsage(resolveSlashUsagePath())
  // Debounced flush every 5s while dirty
  setInterval(() => { void slashUsage.flush() }, 5_000).unref()
  const ccQuotaService = new CcQuotaService({ sink: otlpExporter })
  new OTelProcessor(bus, otelStore, otlpExporter)

  // Wire SSE
  const sse = new SSEBroadcaster(docStore)
  const readyQueue = new ReadyQueue()
  sse.setReadyQueue(readyQueue.getQueue())
  bus.on('ready_queue.update', (ev) => sse.setReadyQueue(ev.payload.queue))

  // Observability stack — fire-and-forget; errors surface as state='degraded' + lastError via telemetry API
  const observability = new ObservabilityStack()
  void observability.start()

  const telemetryRoutes = createTelemetryRoutes({
    sse,
    get query() { return observability.query },
    getState: () => observability.state,
    getProgress: () => observability.progress,
    getLastError: () => observability.lastError,
    restart: () => observability.restart(),
    getDefaultUserEmail: () => process.env.TINSTAR_USER_EMAIL ?? '',
    getSessionConversationId: (name: string) => {
      if (!sessionConfig) return null
      const sess = getSession(sessionConfig.dirs.sessions, name)
      return sess?.conversation?.id ?? null
    },
    getRunIdsForConversationIds: (conversationIds) => {
      if (!sessionConfig || conversationIds.length === 0) return []
      const wanted = new Set(conversationIds)
      const out: string[] = []
      for (const run of docStore.getAllRuns()) {
        const sess = getSession(sessionConfig.dirs.sessions, run.sessionId)
        const convId = sess?.conversation?.id
        if (convId && wanted.has(convId)) {
          out.push(run.id)
        }
      }
      return out
    },
  })

  let natsManager: NatsManager | undefined
  let natsTraffic: NatsTrafficBridge | undefined
  let natsHealth: NatsHealthMonitor | undefined
  let slateWatcher: SlateWatcher | undefined
  let refreshCoordinator: SurfaceRefreshCoordinator | undefined

  if (!shutdownRegistered) {
    shutdownRegistered = true
    const shutdown = async () => {
      try { slateWatcher?.stop() } catch (e) { log.debug('shutdown', `slateWatcher: ${(e as Error).message}`) }
      try { natsHealth?.stop() } catch (e) { log.debug('shutdown', `natsHealth: ${(e as Error).message}`) }
      try { await natsTraffic?.stop() } catch (e) { log.debug('shutdown', `natsTraffic: ${(e as Error).message}`) }
      try { await natsManager?.stop() } catch (e) { log.debug('shutdown', `natsManager: ${(e as Error).message}`) }
      try { await observability.stop() } catch (e) { log.debug('shutdown', `observability: ${(e as Error).message}`) }
      try { telemetryRoutes.stopPolling() } catch (e) { log.debug('shutdown', `telemetry: ${(e as Error).message}`) }
      try { docStore.flush() } catch (e) { log.debug('shutdown', `docStore: ${(e as Error).message}`) }
      try { await slashUsage.flush() } catch (e) { log.debug('shutdown', `slashUsage: ${(e as Error).message}`) }
      process.exit(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }

  // Clear bun's cached nats-channel-mcp so freshly spawned hands re-resolve from
  // GitHub HEAD. bun caches git specs by commit hash and doesn't re-check the
  // remote on subsequent `bun x` calls — without this, hands can run stale
  // channel-server code (e.g. missing upstream fixes like self-echo suppression).
  // We clear BOTH the install cache AND the bunx tmp resolutions — the latter
  // is what `bun x` actually serves from, and the former alone wasn't enough.
  try {
    const bunCacheDir = join(homedir(), '.bun/install/cache')
    for (const entry of readdirSync(bunCacheDir)) {
      if (entry.includes('nats-channel-mcp')) {
        rmSync(join(bunCacheDir, entry), { recursive: true, force: true })
      }
    }
  } catch (e) { log.debug('init', `bun cache cleanup: ${(e as Error).message}`) }
  try {
    for (const entry of readdirSync('/tmp')) {
      if (entry.startsWith('bunx-') && entry.includes('nats-channel-mcp')) {
        rmSync(join('/tmp', entry), { recursive: true, force: true })
      }
    }
  } catch (e) { log.debug('init', `bunx tmp cleanup: ${(e as Error).message}`) }

  // Start managed NATS server (installs binary if needed, spawns, probes)
  natsManager = new NatsManager()
  void natsManager.start().then(() => {
    // Start NATS traffic bridge — subscribes to widget subjects and broadcasts via SSE
    natsTraffic = new NatsTrafficBridge(sse, natsManager!.url)
    natsTraffic.start()

    // Re-register every persisted session's subs with the bridge. Saloon entries
    // are synthetic (keyed `saloon:<name>`) and not persisted as widget docs.
    if (sessionConfig) {
      const sessEntries = readdirSync(sessionConfig.dirs.sessions, { withFileTypes: true })
      for (const entry of sessEntries) {
        if (!entry.isDirectory()) continue
        const sess = getSession(sessionConfig.dirs.sessions, entry.name)
        if (!sess) continue
        registerSaloonSubs(natsTraffic, sess.name, sess.nats?.subscriptions ?? [])
      }
    }

    // Start the periodic NATS-control-socket health probe. Drives
    // Session.natsControlOrphanedAt for every NATS-enabled session so the
    // Saloon broker-health dot reflects reality even when nobody's tried
    // to subscribe/unsubscribe recently.
    if (sessionConfig) {
      natsHealth = new NatsHealthMonitor({
        sessionsDir: sessionConfig.dirs.sessions,
        docStore,
        getSocketPath: (name) => natsControlSocketPath(name),
        // Auto-recovery is opt-in (config.nats.autoRecoverOrphans) because it
        // interrupts the agent's MCP. When on, a stuck orphan gets its
        // channel-server SIGTERMed so Claude relaunches it with a fresh socket.
        onConfirmedOrphan: sessionConfig.nats.autoRecoverOrphans
          ? (name) => {
              void reconnectSessionNats(name, { socketPath: natsControlSocketPath(name) })
                .then(({ killed }) => log.info('nats-health', `${name}: auto-recover signalled ${killed.length} channel-server process(es)`))
                .catch(err => log.warn('nats-health', `${name}: auto-recover failed: ${(err as Error).message}`))
            }
          : undefined,
      })
      const healthEntries = readdirSync(sessionConfig.dirs.sessions, { withFileTypes: true })
      for (const entry of healthEntries) {
        if (!entry.isDirectory()) continue
        const sess = getSession(sessionConfig.dirs.sessions, entry.name)
        if (sess?.nats?.enabled) natsHealth.trackSession(sess.name)
      }
      natsHealth.start()
    }
  })

  const fastSim = process.env.TINSTAR_FAST_SIM === '1'
  const speedMultiplier = fastSim ? 0 : 1

  let simulator: MockSensorSimulator | null = null

  function startSimulator() {
    if (simulator?.isRunning()) return
    simulator = new MockSensorSimulator(bus, speedMultiplier)
    simulator.start()
  }

  function resetSimulator() {
    simulator?.stop()
    simulator = null
    let simSpace = docStore.getAllSpaces().find(s => s.name === '_simulator')
    if (!simSpace) {
      simSpace = { id: shortId('spc'), name: '_simulator', createdAt: new Date().toISOString() }
      docStore.upsertSpace(simSpace.id, simSpace)
    }
    docStore.activeSpaceId = simSpace.id
    docStore.clear()
    otelStore.clear()
  }

  let sessionConfig: TinstarConfig | null = null

  // --- Session management ---
  if (process.env.TINSTAR_NO_SESSIONS !== '1') {
    try {
      // loadConfig() resolves the config root via getConfigRoot(), which honors
      // TINSTAR_CONFIG_HOME (preferred) and TINSTAR_DATA_DIR (legacy alias).
      sessionConfig = loadConfig()
      ensureDirs(sessionConfig)

      // Port safety (plan U6). Registering the interactive window is what arms
      // `findPort`'s overlap refusal: from here on, any OTHER window that reaches
      // into the range user sessions draw from is rejected at the call rather than
      // quietly competing for the same ports.
      tmuxBackend.setInteractivePortWindow(interactivePortWindow(sessionConfig))
      const portProblem = refreshConfigProblem(sessionConfig)
      if (portProblem) {
        // A user edit, not a code bug — so it degrades the refresh engine rather
        // than stopping the boot. The coordinator reads the same predicate and
        // stays in owner-delivery mode while it holds.
        log.error('refresh', `refresh engine disabled — ${portProblem}`)
      }

      // Enable file-backed persistence so data survives server restarts
      docStore.enablePersistence(join(sessionConfig.dirs.root, 'docstore.json'))

      // Canonical Surfaces (U1) — SAME GATE as docStore.enablePersistence, and
      // deliberately immediately after it: the migration reconciles the legacy
      // `slatePoints` that call just hydrated, and a faulted sidecar has to be
      // refusing writes before session rehydration below could overwrite the
      // evidence. `bootSurfaces` handles all three load outcomes; the only work
      // that finishes later is the migration's durable write.
      try {
        const surfaceBoot = bootSurfaces(docStore, { dir: sessionConfig.dirs.root })
        if (surfaceBoot.outcome.health === 'faulted-read-only') {
          log.error('surfaces', 'canonical Surface store is FAULTED (read-only) — canonical projection is empty and the Run Workspace is showing the frozen legacy snapshot', {
            frozenAt: surfaceBoot.status.frozenAt,
            detail: surfaceBoot.status.detail,
          })
        } else {
          void surfaceBoot.migration
            .then(({ report, commit }) => {
              if (!report) return
              if (commit && !commit.committed) {
                log.warn('surfaces', `migration write refused: ${commit.reason}`, { detail: commit.detail })
                return
              }
              log.info('surfaces', 'legacy Slate migration pass complete', {
                health: surfaceBoot.outcome.health,
                runsSeen: report.runsSeen,
                created: report.surfacesCreated,
                updated: report.surfacesUpdated,
                unchanged: report.surfacesUnchanged,
                quarantined: report.quarantined.length,
              })
            })
            .catch(err => log.warn('surfaces', `migration failed: ${(err as Error).message}`))
        }
      } catch (err) {
        // The sidecar's singleton assertion is the only thing that throws here.
        // It means a boot path opened a store without the guard — a bug worth
        // failing loudly for rather than degrading into a second backend.
        log.error('surfaces', `canonical Surface store could not be opened: ${(err as Error).message}`)
        throw err
      }

      // Initialize spaces — ensure at least one exists
      const savedSpaceId = loadActiveSpaceId(sessionConfig.dirs.root)
      const savedSpace = savedSpaceId ? docStore.getSpace(savedSpaceId) : undefined
      const isSimSaved = savedSpace?.name === '_simulator'
      if (savedSpace && (!isSimSaved || fastSim)) {
        docStore.activeSpaceId = savedSpaceId!
      } else if (docStore.getAllSpaces().length > 0) {
        const userSpace = docStore.getAllSpaces().find(s => s.name !== '_simulator')
        docStore.activeSpaceId = (userSpace ?? docStore.getAllSpaces()[0]!).id
      } else if (process.env.TINSTAR_NO_DEFAULT_SPACE !== '1') {
        const defaultSpace = {
          id: shortId('spc'),
          name: 'Work Space',
          createdAt: new Date().toISOString(),
        }
        docStore.upsertSpace(defaultSpace.id, defaultSpace)
        docStore.activeSpaceId = defaultSpace.id
        saveActiveSpaceId(sessionConfig.dirs.root, defaultSpace.id)
        log.info('server', `created default space "${defaultSpace.name}" (${defaultSpace.id})`)
      }

      // Rehydrate runs for sessions on disk
      const sessEntries = readdirSync(sessionConfig.dirs.sessions, { withFileTypes: true })
      for (const entry of sessEntries) {
        if (!entry.isDirectory()) continue
        const deletingMarker = join(sessionConfig.dirs.sessions, entry.name, '.deleting')
        if (existsSync(deletingMarker)) {
          log.info('rehydrate', `cleaning up partially-deleted session dir: ${entry.name}`)
          rmSync(join(sessionConfig.dirs.sessions, entry.name), { recursive: true, force: true })
          continue
        }
        const sess = getSession(sessionConfig.dirs.sessions, entry.name)
        if (!sess) continue
        // Reclaim any port already bound to this session so a different session's
        // start path can't grab it via findPort() and trigger a ttyd kill war.
        if (sess.backend === 'tmux' && sess.port) {
          tmuxBackend.claimPort(sess.port)
        }
        const existingRun = docStore.getRun(sess.name)
        const tpl = sess.cliTemplate ? sessionConfig.cliTemplates.find(t => t.name === sess.cliTemplate) : null
        if (!existingRun) {
          docStore.upsertRun(sess.name, {
            id: sess.name,
            status: sess.state,
            background: sess.background ?? false,
            blocked: sess.blocked ?? false,
            sessionId: sess.name,
            initiative: '',
            epic: '',
            task: '',
            repo: sess.project ?? '',
            worktree: sess.workspace?.worktree ? sess.name : '',
            touchedFiles: [],
            recapEntries: [],
            rawLogs: '',
            port: sess.port ?? null,
            backend: sess.backend ?? null,
            agentIcon: tpl?.icon,
            natsEnabled: sess.nats?.enabled ?? false,
            // Direct subject is the second subscription (index 1) in two-tier model
            // Format: [broadcast, direct] where direct = broadcast + session name
            natsSubject: sess.nats?.subscriptions?.[1] ?? sess.nats?.subscriptions?.[0],
            natsSubscriptions: sess.nats?.subscriptions,
            natsControlOrphanedAt: sess.natsControlOrphanedAt ?? null,
            taskId: '',
            worktreeId: '',
            createdAt: sess.created ?? new Date().toISOString(),
            spaceId: docStore.activeSpaceId,
          })
          // A session persisted as blocked must re-derive attention right away
          // (AE4) — upsertRun only projects fields, it never derives, and the
          // watcher's in-memory override starts empty after a restart. Guarded
          // on `blocked` so the ordinary boot path derives nothing (unchanged).
          if (sess.blocked) docStore.rederiveRunAttention(sess.name)
          log.info('rehydrate', `created run for session ${sess.name} (${sess.state})`)
        } else {
          // Refresh fields that mirror live session state. NATS fields are SSOT on
          // the session (subscriptions mutate on breakout joins, orphan flag flips
          // on control-socket loss) and the run projection must track them across
          // restarts. agentIcon picks up template-icon changes too.
          // `blocked` is deliberately NOT in this spread: updateRunStatus owns
          // the (status, blocked) pair so a persisted blocked flip re-derives
          // attention (AE4) — mirroring it here first would trip the mutator's
          // equality short-circuit and leave attention stale.
          const refreshed = {
            ...existingRun,
            background: sess.background ?? false,
            natsEnabled: sess.nats?.enabled ?? false,
            natsSubject: sess.nats?.subscriptions?.[1] ?? sess.nats?.subscriptions?.[0],
            natsSubscriptions: sess.nats?.subscriptions,
            natsControlOrphanedAt: sess.natsControlOrphanedAt ?? null,
            agentIcon: tpl?.icon ?? existingRun.agentIcon,
          }
          docStore.upsertRun(sess.name, refreshed)
          const persistedBlocked = sess.blocked ?? false
          if (runNeedsStatusCorrection(existingRun, sess.state, persistedBlocked)) {
            log.info('rehydrate', `${sess.name}: correcting status ${existingRun.status}${existingRun.blocked ? ' (blocked)' : ''} → ${sess.state}${persistedBlocked ? ' (blocked)' : ''}`)
            docStore.updateRunStatus(sess.name, sess.state, persistedBlocked)
          }
        }
        // Backfill TopicMetadata for sessions that pre-existed the topic-metadata
        // feature. The bootstrap helper is idempotent (skips subjects that already
        // have records) so this is safe to run on every boot.
        if (sess.nats?.enabled && sess.nats.subscriptions.length > 0) {
          bootstrapHierarchicalTopicMetadata(sess.nats.subscriptions, sess.name, docStore)
        }
      }

      log.info('server', `session config loaded`, { root: sessionConfig.dirs.root, logFile: log.file })

      // Start simulator AFTER persistence loads
      if (fastSim) {
        let simSpace = docStore.getAllSpaces().find(s => s.name === '_simulator')
        if (!simSpace) {
          simSpace = { id: shortId('spc'), name: '_simulator', createdAt: new Date().toISOString() }
          docStore.upsertSpace(simSpace.id, simSpace)
        }
        docStore.activeSpaceId = simSpace.id
        saveActiveSpaceId(sessionConfig.dirs.root, simSpace.id)
        docStore.clear()
        startSimulator()
      }

      // Run reconciliation immediately
      reconcileGitHistory(docStore, sessionConfig)

      const cfg = sessionConfig
      // `blocked` rides along from the StatusWatcher (which passes it on every
      // callback). Reconcile paths omit it: updateRunStatus keeps the run's
      // current value, and forces it false on `stopped` — the only state
      // reconcile emits — so a dead session can't keep a blocked flag.
      const onStateChanged = (name: string, state: SessionStatus, blocked?: boolean) => {
        docStore.updateRunStatus(name, state, blocked)
        readyQueue.onStatusChange(name, state)
        sse.setReadyQueue(readyQueue.getQueue())
        sse.broadcastReadyQueueUpdate()
        bus.emit({
          type: 'managed_session.state_changed',
          timestamp: new Date().toISOString(),
          payload: { name, state },
        })
      }

      reconcileSessionStates(cfg.dirs.sessions, {
        getTmuxSessionState: (name) => tmuxBackend.getTmuxSessionState(cfg, name),
        onStateChanged: (name, state) => {
          onStateChanged(name, state)
          log.info('reconcile', `${name}: startup correction to ${state}`)
        },
      }).then(async (sessions) => {
        // Reattach ttyd for tmux sessions that survived a server crash
        for (const session of sessions) {
          if (session.state === 'stopped' || session.state === 'creating') continue
          const port = session.port ?? await tmuxBackend.findPort(interactivePortWindow(cfg))
          try {
            const result = await tmuxBackend.reattachTmuxSession(cfg, { session, port })
            updateSession(cfg.dirs.sessions, session.name, { port: result.port, ttydPid: result.ttydPid ?? null })
            tmuxBackend.onTtydRestart(session.name, (newPid) => {
              updateSession(cfg.dirs.sessions, session.name, { ttydPid: newPid })
            })
            const run = docStore.getRun(session.name)
            if (run && run.port !== result.port) {
              docStore.upsertRun(session.name, { ...run, port: result.port })
            }
            log.info('reattach', `${session.name}: ttyd restarted on :${result.port}`)
          } catch (err) {
            log.warn('reattach', `${session.name}: failed to reattach: ${(err as Error).message}`)
          }
        }

        // GC ttyds left squatting ports by prior backend lifecycles (their tmux
        // session is gone but ttyd survived the restart). Runs after reattach so
        // a session we just adopted is never mistaken for an orphan.
        tmuxBackend.reapOrphanTtyds(cfg.sessions.prefix)
          .then(n => { if (n > 0) log.info('reconcile', `startup orphan sweep reaped ${n} ttyd(s)`) })
          .catch(err => log.warn('reconcile', `startup orphan sweep failed: ${(err as Error).message}`))

        // Seed the ready queue from all current session states so '[' works immediately after restart
        for (const session of sessions) {
          readyQueue.onStatusChange(session.name, session.state)
        }
        sse.setReadyQueue(readyQueue.getQueue())
        sse.broadcastReadyQueueUpdate()

        // Start JSONL status watcher — polls transcript files to derive running/idle
        // status directly, replacing the hook-based approach.
        const watcher = new StatusWatcher({
          sessionsDir: cfg.dirs.sessions,
          onStatusChanged: onStateChanged,
          onRecapEntries: (name, entries) => {
            for (const entry of entries) {
              docStore.addRecapEntry(name, entry)
            }
            // Look up the Session for label data (conversation.id). If the session
            // record vanished between the watcher reading it and this callback,
            // skip observation — reconcileLiveSessions will flush on next tick.
            const session = getSession(cfg.dirs.sessions, name)
            if (session) observeFromRecapEntries(name, entries, session)
          },
          onSessionsListed: (names) => reconcileLiveSessions(names),
          resolveTmuxName: (name) => tmuxBackend.tmuxSessionName(cfg, name),
        })
        watcher.start()
      }).catch(err => log.warn('reconcile', `startup reconciliation failed: ${(err as Error).message}`))

      // Periodic session state reconciliation (30s)
      setInterval(() => {
        reconcileSessionStates(cfg.dirs.sessions, {
          getTmuxSessionState: (name) => tmuxBackend.getTmuxSessionState(cfg, name),
          onStateChanged: (name, state) => {
            onStateChanged(name, state)
            log.info('reconcile', `${name}: state corrected to ${state}`)
          },
        }).catch(err => console.error('[reconcile] error:', (err as Error).message))
        // Drain any ttyds whose tmux session has since died, so the port pool
        // can't slowly fill with squatters between restarts.
        tmuxBackend.reapOrphanTtyds(cfg.sessions.prefix)
          .catch(err => console.error('[orphan-sweep] error:', (err as Error).message))
      }, 30_000)

      // Periodic git diff reconciliation (10s — balances freshness vs git load when many runs are active)
      setInterval(() => {
        for (const run of docStore.getAllRuns()) {
          if (run.status !== 'running' && run.status !== 'idle') continue
          const sess = getSession(cfg.dirs.sessions, run.id)
          const workdir = sess?.workspace?.path
          if (!workdir) continue
          getGitDiffFiles(workdir).then(files => {
            docStore.reconcileFiles(run.id, files)
          }).catch(err => {
            log.warn('reconcile', `git-diff failed for ${run.id}: ${(err as Error).message}`)
          })
        }
      }, 10_000)

      // The Slate watcher — mirrors the git-diff reconcile loop, but fs-watches each
      // watched run's `.tinstar/slate/` for latency and reconciles the validated
      // directory into canonical Surfaces as one epoch (plan U2). A re-observation
      // of unchanged content commits nothing, so the poll-floor backstop is cheap.
      //
      // Its own `SurfaceService` instance, with the same adapters the HTTP one gets.
      // Sharing one would mean the watcher and a request could interleave inside a
      // single object's state; they already serialize where it matters (the sidecar's
      // transaction queue), and the service itself holds no per-call state.
      const slateService = new SurfaceService(docStore, { sourceAdapters: slateSourceAdapters() })
      slateWatcher = new SlateWatcher({
        listLiveRuns: () => {
          const runs: { runId: string; workdir: string }[] = []
          for (const run of docStore.getAllRuns()) {
            if (run.status !== 'running' && run.status !== 'idle') continue
            const workdir = getSession(cfg.dirs.sessions, run.id)?.workspace?.path
            if (workdir) runs.push({ runId: run.id, workdir })
          }
          return runs
        },
        // Runs whose canonical records still name a worktree, live session or not.
        listBoundRuns: () => boundSlateRuns(docStore.getAllSurfaces()),
        runContext: runId => {
          const run = docStore.getRun(runId)
          if (!run) return null
          // The SAME derivation migration uses, so a file-authored entry lands on the
          // Surface migration already adopted from its legacy point instead of minting
          // a second identity. A run with no `createdAt` has no derivable incarnation
          // and is skipped rather than given a substitute — see `deriveRunIncarnation`.
          const incarnation = deriveRunIncarnation(runId, run.createdAt)
          if (!incarnation) return null
          return {
            spaceId: run.spaceId || LEGACY_SPACELESS_SPACE_ID,
            incarnation,
            rootSurfaceId: deriveLegacyRunRootId(incarnation),
          }
        },
        applyEpoch: epoch => reconcileSlateEpoch(slateService, epoch, {
          actor: { kind: 'job', id: 'slate-watcher', label: 'Slate watcher' },
        }),
      })
      slateWatcher.start()

      // The durable refresh engine (plan U6). Its own SurfaceService for the same
      // reason the watcher has one: no per-call state to share, and no interleaving
      // inside one object between a sweep and a request.
      refreshCoordinator = buildRefreshCoordinator({
        cfg,
        docStore,
        service: new SurfaceService(docStore, { sourceAdapters: slateSourceAdapters() }),
        // The watcher's reconciler IS the barrier's re-observation for `slate-file`
        // bindings. Reusing it rather than writing a second reader is what makes
        // "the barrier sees exactly what the watcher would have seen" true by
        // construction instead of by two implementations agreeing today.
        reobserveRun: runId => slateWatcher!.reconcileNow(runId),
      })
      // Reconstruct in-flight work BEFORE the first sweep, so a job whose worker
      // died with the last process is failed rather than silently re-dispatched
      // alongside a worker that may still be writing to its staging path.
      void refreshCoordinator.recover()
        .then(r => {
          if (r.failed.length) log.info('refresh', `restart failed ${r.failed.length} in-flight refresh job(s)`)
        })
        .catch(err => log.warn('refresh', `restart recovery failed: ${(err as Error).message}`))

      // One sweep loop: deadlines, harvest, dispatch. Guarded against overlap —
      // a sweep that outruns its interval would double-dispatch, and the compare-
      // and-swap would merely make that noisy rather than harmless.
      let sweeping = false
      setInterval(() => {
        if (sweeping || !refreshCoordinator) return
        sweeping = true
        void refreshCoordinator.sweep()
          .catch(err => log.warn('refresh', `sweep failed: ${(err as Error).message}`))
          .finally(() => { sweeping = false })
      }, cfg.refresh.sweepMs)

      // The `git-revision` trigger source. Rides the same cadence as the git-diff
      // reconcile above rather than adding a third timer, and reports the HEAD it
      // read as EVIDENCE — the coordinator dedupes on it and never orders it.
      setInterval(() => {
        if (!refreshCoordinator) return
        const seen = new Set<string>()
        for (const run of docStore.getAllRuns()) {
          const workdir = getSession(cfg.dirs.sessions, run.id)?.workspace?.path
          if (!workdir || seen.has(workdir)) continue
          seen.add(workdir)
          void headRevision(workdir).then(sha => {
            if (!sha || !refreshCoordinator) return
            return refreshCoordinator.note({
              kind: 'git-revision', sourceId: workdir, worktree: workdir,
              evidence: sha, runId: run.id, at: Date.now(),
            })
          }).catch(err => log.warn('refresh', `git trigger failed for ${run.id}: ${(err as Error).message}`))
        }
      }, 15_000)
    } catch (err) {
      log.error('server', 'session initialization failed', { error: (err as Error).message })
      if (fastSim) {
        const simSpace = { id: shortId('spc'), name: '_simulator', createdAt: new Date().toISOString() }
        docStore.upsertSpace(simSpace.id, simSpace)
        docStore.activeSpaceId = simSpace.id
        docStore.clear()
        startSimulator()
      }
    }
  } else if (fastSim) {
    const simSpace = { id: shortId('spc'), name: '_simulator', createdAt: new Date().toISOString() }
    docStore.upsertSpace(simSpace.id, simSpace)
    docStore.activeSpaceId = simSpace.id
    startSimulator()
  }

  const ctx: RouteContext = {
    docStore, otelStore, sse, bus, startSimulator, resetSimulator,
    simulatorTestApiEnabled: fastSim,
    sessionConfig, readyQueue, telemetryRoutes, ccQuotaService, refreshCoordinator,
    slashRegistry, slashUsage, otlpExporter,
    get natsTraffic() { return natsTraffic },
    get natsHealth() { return natsHealth },
  }

  // Auto-start the marshal so it's always available without a UI nudge.
  // Deferred so it doesn't block server startup or interleave with the
  // session rehydration that just ran above.
  setImmediate(() => {
    ensureMarshalSession(ctx)
      .then(result => {
        if (!result.ok) log.warn('marshal-boot', `auto-start failed: ${result.error.code} ${result.error.message}`)
        else log.info('marshal-boot', `marshal session ready: ${result.data.state}`)
      })
      .catch(err => log.warn('marshal-boot', `auto-start threw: ${(err as Error).message}`))
  })

  return ctx
}

/**
 * Take the backend singleton for the Vite plugin path.
 *
 * `standalone.ts` has enforced one backend per config dir since the ttyd
 * port-war fix; the plugin path never did, so a dev server and a standalone
 * backend could both own one config root — and, from U1 on, both open one
 * Surface sidecar. This closes that hole with the SAME guard rather than a
 * second lock: `acquireBackendSingleton` is the one owner, and the sidecar only
 * ever ASSERTS it (`backendSingletonOwner`).
 *
 * Exported so the refusal is testable without booting Vite. Throws rather than
 * `process.exit`ing, because a Vite plugin that killed the process would take
 * down a dev server the user may be running for unrelated reasons — Vite surfaces
 * the throw as a startup failure, which is the same outcome with a readable cause.
 */
export function acquireBackendSingletonForPlugin(configDir = getConfigRoot()): () => void {
  const lockPath = join(configDir, 'server.lock')
  const result = acquireBackendSingleton(lockPath)
  if (!result.acquired) {
    const who = result.ownerPid ? ` (pid ${result.ownerPid})` : ''
    throw new Error(
      `another tinstar backend is already running on ${configDir}${who}. ` +
      `Stop it first, or run this one under a different TINSTAR_CONFIG_HOME.`,
    )
  }
  // The marker outlives only this process; drop it on exit exactly as
  // standalone.ts does, so the next start sees a clean (or stealable) lock.
  const release = () => { try { rmSync(`${lockPath}.mark`, { recursive: true, force: true }) } catch { /* gone */ } }
  process.on('exit', release)
  return release
}

export function tinstarBackend(): Plugin {
  let ctx: RouteContext | null = null
  return {
    name: 'tinstar-backend',
    configureServer(server) {
      // BEFORE initBackend: the Surface sidecar asserts this guard on open, and
      // an unguarded boot is exactly the case that assertion exists to catch.
      acquireBackendSingletonForPlugin()
      ctx = initBackend()
      server.middlewares.use((req, res, next) => {
        handleRequest(ctx!, req, res)
          .then(handled => { if (!handled) next() })
          .catch(next)
      })
      // Flush docStore on server close to persist any pending writes
      server.httpServer?.on('close', () => ctx?.docStore.flush())
    },
  }
}

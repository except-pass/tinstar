import type { Plugin } from 'vite'
import { EventBus } from './event-bus'
import { DocumentStore } from './stores/document-store'
import { OTelStore } from './stores/otel-store'
import { DocumentProcessor } from './processors/document-processor'
import { OTelProcessor } from './processors/otel-processor'
import { SSEBroadcaster } from './api/sse'
import { handleRequest, type RouteContext } from './api/routes'
import { MockSensorSimulator } from './simulator/mock-sensors'
import { join } from 'node:path'
import { readdirSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { shortId } from './utils/shortId'
import {
  loadConfig,
  ensureDirs,
  loadActiveSpaceId,
  saveActiveSpaceId,
  reconcileSessionStates,
  dockerBackend,
  tmuxBackend,
  getSession,
  updateSession,
  type TinstarConfig,
} from './sessions'
import type { SessionStatus } from '../types'
import { getGitDiffFiles } from './sessions/git-diff'
import { StatusWatcher } from './sessions/status-watcher'
import { ReadyQueue } from './sessions/ReadyQueue'
import { log } from './logger'
import { reconcileGitHistory } from './commits'
import { NatsTrafficBridge } from './nats-traffic'
import { registerSaloonSubs } from './api/saloonBridge'
import { NatsHealthMonitor } from './nats-health'
import { natsControlSocketPath } from './sessions/backends/tmux'
import { SessionReadinessTracker } from './sessions/readiness'
import { NatsManager } from './nats/nats-manager.js'
import { ObservabilityStack } from './observability/index.js'
import { createTelemetryRoutes } from './api/telemetry.js'
import { OtlpExporter } from './stores/otlp-exporter'
import { CcQuotaService } from './cc-quota/service'

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
  let readinessTracker: SessionReadinessTracker | undefined

  if (!shutdownRegistered) {
    shutdownRegistered = true
    const shutdown = async () => {
      try { natsHealth?.stop() } catch { /* ignore */ }
      try { await natsTraffic?.stop() } catch { /* ignore */ }
      try { await readinessTracker?.stop() } catch { /* ignore */ }
      try { await natsManager?.stop() } catch { /* ignore */ }
      try { await observability.stop() } catch { /* ignore */ }
      try { telemetryRoutes.stopPolling() } catch { /* ignore */ }
      try { docStore.flush() } catch { /* ignore */ }
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
  } catch { /* ignore */ }
  try {
    for (const entry of readdirSync('/tmp')) {
      if (entry.startsWith('bunx-') && entry.includes('nats-channel-mcp')) {
        rmSync(join('/tmp', entry), { recursive: true, force: true })
      }
    }
  } catch { /* ignore */ }

  // Start managed NATS server (installs binary if needed, spawns, probes)
  natsManager = new NatsManager()
  void natsManager.start().then(() => {
    // Start NATS traffic bridge — subscribes to widget subjects and broadcasts via SSE
    natsTraffic = new NatsTrafficBridge(sse, natsManager!.url)
    natsTraffic.start()

    // Sync existing widget subscriptions now that the bridge is live
    for (const widget of docStore.getAllNatsTrafficWidgets()) {
      if (widget.subscriptions?.length) {
        natsTraffic.updateWidgetSubscriptions(widget.id, widget.subscriptions)
      }
    }

    // Re-register every persisted session's subs with the bridge. Saloon entries
    // are synthetic (keyed `saloon:<name>`) and not persisted as widget docs, so
    // the widget hydration loop above doesn't cover them.
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
      })
      const healthEntries = readdirSync(sessionConfig.dirs.sessions, { withFileTypes: true })
      for (const entry of healthEntries) {
        if (!entry.isDirectory()) continue
        const sess = getSession(sessionConfig.dirs.sessions, entry.name)
        if (sess?.nats?.enabled) natsHealth.trackSession(sess.name)
      }
      natsHealth.start()
    }

    // Start session readiness tracker — listens for tinstar.ready.> signals
    readinessTracker = new SessionReadinessTracker(natsManager!.url)
    readinessTracker.start()
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
      sessionConfig = loadConfig(process.env.TINSTAR_DATA_DIR ? { _rootDir: process.env.TINSTAR_DATA_DIR } : undefined)
      ensureDirs(sessionConfig)

      // Enable file-backed persistence so data survives server restarts
      docStore.enablePersistence(join(sessionConfig.dirs.root, 'docstore.json'))

      // Initialize spaces — ensure at least one exists
      const savedSpaceId = loadActiveSpaceId(sessionConfig.dirs.root)
      const savedSpace = savedSpaceId ? docStore.getSpace(savedSpaceId) : undefined
      const isSimSaved = savedSpace?.name === '_simulator'
      if (savedSpace && (!isSimSaved || fastSim)) {
        docStore.activeSpaceId = savedSpaceId!
      } else if (docStore.getAllSpaces().length > 0) {
        const userSpace = docStore.getAllSpaces().find(s => s.name !== '_simulator')
        docStore.activeSpaceId = (userSpace ?? docStore.getAllSpaces()[0]!).id
      } else {
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
        const existingRun = docStore.getRun(sess.name)
        const tpl = sess.cliTemplate ? sessionConfig.cliTemplates.find(t => t.name === sess.cliTemplate) : null
        if (!existingRun) {
          docStore.upsertRun(sess.name, {
            id: sess.name,
            status: sess.state,
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
          log.info('rehydrate', `created run for session ${sess.name} (${sess.state})`)
        } else {
          // Refresh fields that mirror live session state. NATS fields are SSOT on
          // the session (subscriptions mutate on breakout joins, orphan flag flips
          // on control-socket loss) and the run projection must track them across
          // restarts. agentIcon picks up template-icon changes too.
          const refreshed = {
            ...existingRun,
            natsEnabled: sess.nats?.enabled ?? false,
            natsSubject: sess.nats?.subscriptions?.[1] ?? sess.nats?.subscriptions?.[0],
            natsSubscriptions: sess.nats?.subscriptions,
            natsControlOrphanedAt: sess.natsControlOrphanedAt ?? null,
            agentIcon: tpl?.icon ?? existingRun.agentIcon,
          }
          docStore.upsertRun(sess.name, refreshed)
          if (existingRun.status !== sess.state) {
            log.info('rehydrate', `${sess.name}: correcting status ${existingRun.status} → ${sess.state}`)
            docStore.updateRunStatus(sess.name, sess.state)
          }
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
      const onStateChanged = (name: string, state: SessionStatus) => {
        docStore.updateRunStatus(name, state)
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
        getContainerState: (name) => dockerBackend.getContainerState(cfg, name),
        getTmuxSessionState: (name) => tmuxBackend.getTmuxSessionState(cfg, name),
        onStateChanged: (name, state) => {
          onStateChanged(name, state)
          log.info('reconcile', `${name}: startup correction to ${state}`)
        },
      }).then(async (sessions) => {
        // Reattach ttyd for tmux sessions that survived a server crash
        for (const session of sessions) {
          if (session.state === 'stopped' || session.state === 'creating') continue
          if (session.backend !== 'tmux') continue
          const port = session.port ?? await tmuxBackend.findPort(cfg.ports.hostStart)
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
          },
        })
        watcher.start()
      }).catch(err => log.warn('reconcile', `startup reconciliation failed: ${(err as Error).message}`))

      // Periodic session state reconciliation (30s)
      setInterval(() => {
        reconcileSessionStates(cfg.dirs.sessions, {
          getContainerState: (name) => dockerBackend.getContainerState(cfg, name),
          getTmuxSessionState: (name) => tmuxBackend.getTmuxSessionState(cfg, name),
          onStateChanged: (name, state) => {
            onStateChanged(name, state)
            log.info('reconcile', `${name}: state corrected to ${state}`)
          },
        }).catch(err => console.error('[reconcile] error:', (err as Error).message))
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
          }).catch(() => {})
        }
      }, 10_000)
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

  return {
    docStore, otelStore, sse, bus, startSimulator, resetSimulator,
    sessionConfig, readyQueue, telemetryRoutes, ccQuotaService,
    get natsTraffic() { return natsTraffic },
    get natsHealth() { return natsHealth },
    get readinessTracker() { return readinessTracker },
  }
}

export function tinstarBackend(): Plugin {
  let ctx: RouteContext | null = null
  return {
    name: 'tinstar-backend',
    configureServer(server) {
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

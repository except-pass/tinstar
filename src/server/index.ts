import type { Plugin } from 'vite'
import { EventBus } from './event-bus'
import { DocumentStore } from './stores/document-store'
import { OTelStore } from './stores/otel-store'
import { DocumentProcessor } from './processors/document-processor'
import { OTelProcessor } from './processors/otel-processor'
import { SSEBroadcaster } from './api/sse'
import { handleRequest } from './api/routes'
import { MockSensorSimulator } from './simulator/mock-sensors'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import {
  loadConfig,
  ensureDirs,
  reconcileSessionStates,
  dockerBackend,
  tmuxBackend,
  ensureCaddy,
  syncRoutes,
  listSessions,
  getSession,
  type TinstarConfig,
} from './sessions'
import { log } from './logger'

export function tinstarBackend(): Plugin {
  let bus: EventBus
  let docStore: DocumentStore
  let otelStore: OTelStore
  let sse: SSEBroadcaster
  let simulator: MockSensorSimulator | null = null
  let sessionConfig: TinstarConfig | null = null
  let reconcileTimer: ReturnType<typeof setInterval> | null = null

  return {
    name: 'tinstar-backend',

    configureServer(server) {
      // Instantiate core components
      bus = new EventBus()
      docStore = new DocumentStore()
      otelStore = new OTelStore()

      // Wire processors
      new DocumentProcessor(bus, docStore)
      new OTelProcessor(bus, otelStore)

      // Wire SSE
      sse = new SSEBroadcaster(docStore)

      const fastSim = process.env.TINSTAR_FAST_SIM === '1'
      const speedMultiplier = fastSim ? 0 : 1

      function startSimulator() {
        if (simulator?.isRunning()) return
        simulator = new MockSensorSimulator(bus, speedMultiplier)
        simulator.start()
      }

      function resetSimulator() {
        simulator?.stop()
        simulator = null
        docStore.clear()
        otelStore.clear()
      }

      // Only auto-start simulator when TINSTAR_FAST_SIM=1 (E2E tests).
      // In normal dev, the UI starts clean — use POST /api/simulator/start to populate.
      if (fastSim) {
        startSimulator()
      }

      // --- Session management ---
      // Initialize session config unless disabled (e.g. in CI where Docker/tmux are unavailable)
      if (process.env.TINSTAR_NO_SESSIONS !== '1') {
        try {
          sessionConfig = loadConfig()
          ensureDirs(sessionConfig)

          // Enable file-backed persistence so data survives server restarts
          docStore.enablePersistence(join(sessionConfig.dirs.root, 'docstore.json'))

          // Rehydrate runs for sessions on disk + sync statuses with session files
          const sessEntries = readdirSync(sessionConfig.dirs.sessions, { withFileTypes: true })
          for (const entry of sessEntries) {
            if (!entry.isDirectory()) continue
            const sess = getSession(sessionConfig.dirs.sessions, entry.name)
            if (!sess) continue
            const existingRun = docStore.getRun(sess.name)
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
                procedures: [],
                port: sess.port ?? null,
                backend: sess.backend ?? null,
                taskId: '',
                worktreeId: '',
                createdAt: sess.created ?? new Date().toISOString(),
              })
              log.info('rehydrate', `created run for session ${sess.name} (${sess.state})`)
            } else if (existingRun.status !== sess.state) {
              // Sync stale docstore status with session file on disk
              log.info('rehydrate', `${sess.name}: correcting status ${existingRun.status} → ${sess.state}`)
              docStore.updateRunStatus(sess.name, sess.state)
            }
          }

          log.info('server', `session config loaded`, { root: sessionConfig.dirs.root, logFile: log.file })

          // Run reconciliation immediately to correct stale statuses from persisted store
          const cfg = sessionConfig
          reconcileSessionStates(cfg.dirs.sessions, {
            getContainerState: (name) => dockerBackend.getContainerState(cfg, name),
            getTmuxSessionState: (name) => tmuxBackend.getTmuxSessionState(cfg, name),
            onStateChanged: (name, state) => {
              docStore.updateRunStatus(name, state)
              bus.emit({
                type: 'managed_session.state_changed',
                timestamp: new Date().toISOString(),
                payload: { name, state },
              })
              log.info('reconcile', `${name}: startup correction to ${state}`)
            },
          }).catch(err => log.warn('reconcile', `startup reconciliation failed: ${(err as Error).message}`))

          // Start Caddy reverse proxy for session terminal access
          ensureCaddy({
            listenPort: sessionConfig.caddy.listenPort,
            adminPort: sessionConfig.caddy.adminPort,
            configDir: sessionConfig.dirs.root,
          }).then(async () => {
            log.info('server', `caddy proxy ready on :${sessionConfig!.caddy.listenPort}`)
            // Sync routes for any sessions that survived a restart
            const sessions = await listSessions(sessionConfig!.dirs.sessions)
            const routeData = sessions.map(s => ({ name: s.name, port: s.port ?? null, state: s.state }))
            return syncRoutes(routeData, sessionConfig!.caddy.adminPort)
          }).catch(err => {
            log.warn('server', `caddy startup failed (terminals will use direct ports): ${(err as Error).message}`)
          })

          // Periodic reconciliation (30s)
          reconcileTimer = setInterval(() => {
            reconcileSessionStates(cfg.dirs.sessions, {
              getContainerState: (name) => dockerBackend.getContainerState(cfg, name),
              getTmuxSessionState: (name) => tmuxBackend.getTmuxSessionState(cfg, name),
              onStateChanged: (name, state) => {
                docStore.updateRunStatus(name, state)
                bus.emit({
                  type: 'managed_session.state_changed',
                  timestamp: new Date().toISOString(),
                  payload: { name, state },
                })
                log.info('reconcile', `${name}: state corrected to ${state}`)
              },
            }).catch(err => console.error('[reconcile] error:', (err as Error).message))
          }, 30_000)
        } catch (err) {
          log.error('server', 'session initialization failed', { error: (err as Error).message })
        }
      }

      // Attach middleware
      server.middlewares.use((req, res, next) => {
        const handled = handleRequest(
          {
            docStore,
            otelStore,
            sse,
            bus,
            startSimulator,
            resetSimulator,
            sessionConfig,
          },
          req,
          res,
        )
        if (!handled) next()
      })
    },
  }
}

import type { Plugin } from 'vite'
import { EventBus } from './event-bus'
import { DocumentStore } from './stores/document-store'
import { OTelStore } from './stores/otel-store'
import { DocumentProcessor } from './processors/document-processor'
import { OTelProcessor } from './processors/otel-processor'
import { SSEBroadcaster } from './api/sse'
import { handleRequest } from './api/routes'
import { MockSensorSimulator } from './simulator/mock-sensors'
import {
  loadConfig,
  ensureDirs,
  reconcileSessionStates,
  dockerBackend,
  tmuxBackend,
  ensureCaddy,
  syncRoutes,
  listSessions,
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
          log.info('server', `session config loaded`, { root: sessionConfig.dirs.root, logFile: log.file })

          // Start Caddy reverse proxy for session terminal access
          ensureCaddy({
            listenPort: sessionConfig.caddy.listenPort,
            adminPort: sessionConfig.caddy.adminPort,
            configDir: sessionConfig.dirs.root,
          }).then(() => {
            log.info('server', `caddy proxy ready on :${sessionConfig!.caddy.listenPort}`)
            // Sync routes for any sessions that survived a restart
            const sessions = listSessions(sessionConfig!.dirs.sessions)
            const routeData = sessions.map(s => ({ name: s.name, port: s.port ?? null, state: s.state }))
            return syncRoutes(routeData, sessionConfig!.caddy.adminPort)
          }).catch(err => {
            log.warn('server', `caddy startup failed (terminals will use direct ports): ${(err as Error).message}`)
          })

          // Periodic reconciliation (30s)
          const cfg = sessionConfig
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

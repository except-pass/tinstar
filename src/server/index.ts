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
import { randomUUID } from 'node:crypto'
import {
  loadConfig,
  ensureDirs,
  loadActiveSpaceId,
  saveActiveSpaceId,
  reconcileSessionStates,
  dockerBackend,
  tmuxBackend,
  ensureCaddy,
  syncRoutes,
  listSessions,
  getSession,
  type TinstarConfig,
} from './sessions'
import { getGitDiffFiles } from './sessions/git-diff'
import { watchDrafts, ensureDraftsDir } from './sessions/skill-drafts'
import { ReadyQueue } from './sessions/ReadyQueue'
import { log } from './logger'
import { reconcileGitHistory } from './commits'

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

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
      const readyQueue = new ReadyQueue()
      sse.setReadyQueue(readyQueue.getQueue())

      // Start draft watcher — emits skill.drafted SSE events when new drafts appear
      ensureDraftsDir()
      watchDrafts(sse)

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
        // Ensure simulator space exists and is active before clearing
        let simSpace = docStore.getAllSpaces().find(s => s.name === '_simulator')
        if (!simSpace) {
          simSpace = { id: shortId('spc'), name: '_simulator', createdAt: new Date().toISOString() }
          docStore.upsertSpace(simSpace.id, simSpace)
        }
        docStore.activeSpaceId = simSpace.id
        docStore.clear()
        otelStore.clear()
      }

      // Only auto-start simulator when TINSTAR_FAST_SIM=1 (E2E tests).
      // In normal dev, the UI starts clean — use POST /api/simulator/start to populate.
      // NOTE: Simulator start is deferred until after persistence loads (see below)
      // so that persisted data doesn't overwrite mock data.

      // --- Session management ---
      // Initialize session config unless disabled (e.g. in CI where Docker/tmux are unavailable)
      if (process.env.TINSTAR_NO_SESSIONS !== '1') {
        try {
          sessionConfig = loadConfig()
          ensureDirs(sessionConfig)

          // Enable file-backed persistence so data survives server restarts
          docStore.enablePersistence(join(sessionConfig.dirs.root, 'docstore.json'))

          // Initialize spaces — ensure at least one exists
          // Skip _simulator space when not in fast-sim mode (E2E may have left it as active)
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
                port: sess.port ?? null,
                backend: sess.backend ?? null,
                taskId: '',
                worktreeId: '',
                createdAt: sess.created ?? new Date().toISOString(),
                spaceId: docStore.activeSpaceId,
              })
              log.info('rehydrate', `created run for session ${sess.name} (${sess.state})`)
            } else if (existingRun.status !== sess.state) {
              // Sync stale docstore status with session file on disk
              log.info('rehydrate', `${sess.name}: correcting status ${existingRun.status} → ${sess.state}`)
              docStore.updateRunStatus(sess.name, sess.state)
            }
          }

          log.info('server', `session config loaded`, { root: sessionConfig.dirs.root, logFile: log.file })

          // Start simulator AFTER persistence loads so mock data isn't overwritten
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

          // Run reconciliation immediately to correct stale statuses from persisted store
          reconcileGitHistory(docStore, sessionConfig)

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

          // Periodic session state reconciliation (30s)
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

          // Periodic git diff reconciliation for running/idle sessions (5s)
          setInterval(() => {
            for (const run of docStore.getAllRuns()) {
              if (run.status !== 'running' && run.status !== 'idle') continue
              const sess = getSession(cfg.dirs.sessions, run.id)
              const workdir = sess?.workspace?.path
              if (!workdir) continue
              getGitDiffFiles(workdir).then(files => {
                docStore.reconcileFiles(run.id, files)
              }).catch(() => { /* git not available or not a repo — skip */ })
            }
          }, 5_000)
        } catch (err) {
          log.error('server', 'session initialization failed', { error: (err as Error).message })
          // Session init failed but simulator still needs to run
          if (fastSim) {
            const simSpace = { id: shortId('spc'), name: '_simulator', createdAt: new Date().toISOString() }
            docStore.upsertSpace(simSpace.id, simSpace)
            docStore.activeSpaceId = simSpace.id
            docStore.clear()
            startSimulator()
          }
        }
      } else if (fastSim) {
        // No session management — start simulator directly
        const simSpace = { id: shortId('spc'), name: '_simulator', createdAt: new Date().toISOString() }
        docStore.upsertSpace(simSpace.id, simSpace)
        docStore.activeSpaceId = simSpace.id
        startSimulator()
      }

      // Attach middleware
      server.middlewares.use((req, res, next) => {
        handleRequest(
          {
            docStore,
            otelStore,
            sse,
            bus,
            startSimulator,
            resetSimulator,
            sessionConfig,
            readyQueue,
          },
          req,
          res,
        ).then(handled => { if (!handled) next() }).catch(next)
      })
    },
  }
}

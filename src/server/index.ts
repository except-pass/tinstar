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
import { randomUUID } from 'node:crypto'
import {
  loadConfig,
  ensureDirs,
  loadActiveSpaceId,
  saveActiveSpaceId,
  reconcileSessionStates,
  dockerBackend,
  tmuxBackend,
  getSession,
  type TinstarConfig,
} from './sessions'
import type { SessionStatus } from '../types'
import { getGitDiffFiles } from './sessions/git-diff'
import { watchDrafts, ensureDraftsDir } from './sessions/skill-drafts'
import { ReadyQueue } from './sessions/ReadyQueue'
import { log } from './logger'
import { reconcileGitHistory } from './commits'

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

export function initBackend(): RouteContext {
  // Instantiate core components
  const bus = new EventBus()
  const docStore = new DocumentStore()
  const otelStore = new OTelStore()

  // Wire processors
  new DocumentProcessor(bus, docStore)
  new OTelProcessor(bus, otelStore)

  // Wire SSE
  const sse = new SSEBroadcaster(docStore)
  const readyQueue = new ReadyQueue()
  sse.setReadyQueue(readyQueue.getQueue())
  bus.on('ready_queue.update', (ev) => sse.setReadyQueue(ev.payload.queue))

  // Start draft watcher — emits skill.drafted SSE events when new drafts appear
  ensureDraftsDir()
  watchDrafts(sse)

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
      sessionConfig = loadConfig()
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
          log.info('rehydrate', `${sess.name}: correcting status ${existingRun.status} → ${sess.state}`)
          docStore.updateRunStatus(sess.name, sess.state)
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

      // Periodic git diff reconciliation (5s)
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
      }, 5_000)
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

  return { docStore, otelStore, sse, bus, startSimulator, resetSimulator, sessionConfig, readyQueue }
}

export function tinstarBackend(): Plugin {
  return {
    name: 'tinstar-backend',
    configureServer(server) {
      const ctx = initBackend()
      server.middlewares.use((req, res, next) => {
        handleRequest(ctx, req, res)
          .then(handled => { if (!handled) next() })
          .catch(next)
      })
    },
  }
}

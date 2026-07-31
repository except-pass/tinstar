import type { Plugin } from 'vite'
import { EventBus } from './event-bus'
import { DocumentStore, runNeedsStatusCorrection } from './stores/document-store'
import { bootSurfaces } from './stores/surface-boot'
import { OTelStore } from './stores/otel-store'
import { DocumentProcessor } from './processors/document-processor'
import { OTelProcessor } from './processors/otel-processor'
import { SSEBroadcaster } from './api/sse'
import {
  acquirePersistedSessionBackendLeaseForConfig,
  clearStoppedSessionPort,
  ensureMarshalSession,
  finishBootSessionDeletion,
  handleRequest,
  invalidatePersistedSessionBackendGenerationForConfig,
  persistedSessionBackendGenerationForConfig,
  probeOrRetireSessionBackendForReconcile,
  reserveBootSessionDeletion,
  type RouteContext,
} from './api/routes'
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
  deleteSession,
  getSession,
  listSessions,
  updateSession,
  interactivePortWindow,
  refreshConfigProblem,
  type TinstarConfig,
  type Session,
} from './sessions'
import type { Run } from '../domain/types'
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
import { rehydrateSaloonSubs } from './api/saloonBridge'
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
import { createDefaultProviderRegistry } from './providers/lifecycle'

// Module-level flag: ensures SIGINT/SIGTERM handlers are registered only once.
// If initBackend runs twice (Vite HMR), the second invocation skips registration
// so we avoid a double-signal race. The first instance's shutdown handler is
// accepted as-is — prod only calls initBackend once.
let shutdownRegistered = false

/** NATS fields mirrored from durable Session truth onto the Run projection.
 * Historical subjects on disabled sessions are deliberately not live state. */
export function sessionNatsProjection(
  session: Pick<Session, 'nats'>,
): Pick<Run, 'natsEnabled' | 'natsSubject' | 'natsSubscriptions'> {
  if (!session.nats?.enabled) {
    return {
      natsEnabled: false,
      natsSubject: undefined,
      natsSubscriptions: undefined,
    }
  }
  return {
    natsEnabled: true,
    natsSubject: session.nats.subscriptions[1] ?? session.nats.subscriptions[0],
    natsSubscriptions: session.nats.subscriptions,
  }
}

/**
 * Rebuild fields whose durable authority is Session during boot. In
 * particular, Run.port must never resurrect a stale proxy target after a
 * crash between Session retirement and the debounced docstore write.
 */
export function rehydrateRunProjectionFromSession(
  existingRun: Run,
  session: Pick<
    Session,
    'port' | 'background' | 'nats' | 'natsControlOrphanedAt'
  >,
  agentIcon?: string,
): Run {
  return {
    ...existingRun,
    port: session.port ?? null,
    background: session.background ?? false,
    ...sessionNatsProjection(session),
    natsControlOrphanedAt: session.natsControlOrphanedAt ?? null,
    agentIcon: agentIcon ?? existingRun.agentIcon,
  }
}

/** Return only sessions that may rejoin live boot-time services. A durable
 * deletion marker means the record exists solely so a later DELETE can finish
 * backend cleanup. Purge any stale Run projection immediately, regardless of
 * whether the NATS callback or the main rehydration loop observes it first. */
export function getLiveSessionForBoot(
  docStore: DocumentStore,
  sessionsDir: string,
  name: string,
): Session | null {
  if (existsSync(join(sessionsDir, name, '.deleting'))) {
    docStore.deleteRun(name)
    return null
  }
  return getSession(sessionsDir, name)
}

export function startupReattachStillCurrent(
  config: TinstarConfig,
  expectedSession: Pick<Session, 'name' | 'created'>,
  expectedGeneration: string,
): boolean {
  const current = getSession(config.dirs.sessions, expectedSession.name)
  if (!current) return false
  return (
    current.created === expectedSession.created
    && current.state !== 'stopped'
    && current.state !== 'creating'
    && persistedSessionBackendGenerationForConfig(
      config,
      expectedSession.name,
    ) === expectedGeneration
  )
}

interface DeletingSessionBootCleanupDeps {
  deleteTmuxSession: (config: TinstarConfig, session: Session) => Promise<void>
  getTmuxSessionState: (
    config: TinstarConfig,
    sessionName: string,
  ) => Promise<'exists' | 'missing'>
  deleteSession: (sessionsDir: string, sessionName: string) => boolean
  releasePort: (port: number) => void
}

interface DeletingSessionBootRehydrateDeps extends DeletingSessionBootCleanupDeps {
  claimPort: (port: number) => void
  reserveBootSessionDeletion: typeof reserveBootSessionDeletion
  finishBootSessionDeletion: typeof finishBootSessionDeletion
}

/**
 * Make one fail-safe cleanup attempt for durable mid-delete evidence at boot.
 * A confirmed backend miss finishes the deletion; a live backend or failed
 * probe retains both the record and its claimed port for an explicit retry.
 */
export async function reconcileDeletingSessionOnBoot(
  config: TinstarConfig,
  session: Session,
  deps: DeletingSessionBootCleanupDeps = {
    deleteTmuxSession: tmuxBackend.deleteTmuxSession,
    getTmuxSessionState: tmuxBackend.getTmuxSessionState,
    deleteSession,
    releasePort: tmuxBackend.releasePort,
  },
): Promise<'deleted' | 'retained'> {
  try {
    await deps.deleteTmuxSession(config, session)
  } catch (err) {
    // A failed teardown command is not itself proof that the backend survived.
    // The strict probe below is the only authority for destructive cleanup.
    log.warn(
      'rehydrate',
      `partially-deleted session teardown failed: `
      + `${session.name}: ${(err as Error).message}`,
    )
  }
  try {
    const backendState = await deps.getTmuxSessionState(config, session.name)
    if (backendState !== 'missing') {
      log.warn(
        'rehydrate',
        `retaining partially-deleted session with a live backend: ${session.name}`,
      )
      return 'retained'
    }
  } catch (err) {
    log.warn(
      'rehydrate',
      `retaining partially-deleted session after backend probe failed: `
      + `${session.name}: ${(err as Error).message}`,
    )
    return 'retained'
  }

  if (!deps.deleteSession(config.dirs.sessions, session.name)) {
    log.warn(
      'rehydrate',
      `retaining partially-deleted session after record cleanup failed: ${session.name}`,
    )
    return 'retained'
  }
  if (session.port) deps.releasePort(session.port)
  log.info('rehydrate', `finished partially-deleted session cleanup: ${session.name}`)
  return 'deleted'
}

/**
 * Wire durable deletion evidence into boot ownership, port accounting, strict
 * backend cleanup, and generation-safe owner release.
 */
export async function rehydrateDeletingSessionOnBoot(
  config: TinstarConfig,
  name: string,
  deps: DeletingSessionBootRehydrateDeps = {
    deleteTmuxSession: tmuxBackend.deleteTmuxSession,
    getTmuxSessionState: tmuxBackend.getTmuxSessionState,
    deleteSession,
    releasePort: tmuxBackend.releasePort,
    claimPort: tmuxBackend.claimPort,
    reserveBootSessionDeletion,
    finishBootSessionDeletion,
  },
): Promise<'deleted' | 'retained' | 'conflict'> {
  const deletingSession = getSession(config.dirs.sessions, name)
  if (deletingSession?.backend === 'tmux' && deletingSession.port) {
    deps.claimPort(deletingSession.port)
  }
  const cleanupToken = deps.reserveBootSessionDeletion(
    config.dirs.sessions,
    config.sessions.prefix,
    name,
  )
  if (!cleanupToken) {
    log.warn(
      'rehydrate',
      `retaining partially-deleted session with conflicting backend ownership: ${name}`,
    )
    return 'conflict'
  }

  const recoverySession = deletingSession ?? { name, port: null } as Session
  try {
    const outcome = await reconcileDeletingSessionOnBoot(
      config,
      recoverySession,
      deps,
    )
    deps.finishBootSessionDeletion(
      config.dirs.sessions,
      name,
      cleanupToken,
      outcome,
    )
    return outcome
  } catch (err) {
    deps.finishBootSessionDeletion(
      config.dirs.sessions,
      name,
      cleanupToken,
      'retained',
    )
    throw err
  }
}

export async function afterBootDeletionCleanups<T>(
  cleanups: readonly Promise<void>[],
  action: () => Promise<T>,
): Promise<T> {
  await Promise.allSettled(cleanups)
  return action()
}

export interface VerifiedSessionTtydReattachDeps {
  identityInspectionUnavailable: () => boolean
  isIdentityInspectionError: (err: unknown) => boolean
  isSupersededError: (err: unknown) => boolean
  acquireLease: (
    config: TinstarConfig,
    name: string,
    generation: string,
  ) => { token: string; release: () => void } | null
  getSession: typeof getSession
  findPort: (config: TinstarConfig) => Promise<number>
  reattach: typeof tmuxBackend.reattachTmuxSession
  isCurrent: typeof startupReattachStillCurrent
  verifySurface: typeof tmuxBackend.verifyTtydSessionSurface
  stopTtyd: typeof tmuxBackend.stopManagedTtyd
  releasePort: typeof tmuxBackend.releasePort
  updateSession: typeof updateSession
  tmuxName: typeof tmuxBackend.tmuxSessionName
  onTtydRestart: typeof tmuxBackend.onTtydRestart
}

const verifiedSessionTtydReattachDeps: VerifiedSessionTtydReattachDeps = {
  identityInspectionUnavailable: tmuxBackend.ttydIdentityInspectionUnavailable,
  isIdentityInspectionError: err =>
    err instanceof tmuxBackend.TtydIdentityInspectionError,
  isSupersededError: err =>
    tmuxBackend.findTtydStartSupersededError(err) !== null,
  acquireLease: acquirePersistedSessionBackendLeaseForConfig,
  getSession,
  findPort: config => tmuxBackend.findPort(interactivePortWindow(config)),
  reattach: tmuxBackend.reattachTmuxSession,
  isCurrent: startupReattachStillCurrent,
  verifySurface: tmuxBackend.verifyTtydSessionSurface,
  stopTtyd: tmuxBackend.stopManagedTtyd,
  releasePort: tmuxBackend.releasePort,
  updateSession,
  tmuxName: tmuxBackend.tmuxSessionName,
  onTtydRestart: tmuxBackend.onTtydRestart,
}

/**
 * Restore one strictly observed live session's terminal surface.
 *
 * This is a two-phase port/publication transaction: verify the existing port,
 * durably retire it if suspect, verify any replacement, then publish Session
 * and Run together. Compensation retains claims whenever rollback is uncertain.
 */
export async function reattachVerifiedSessionTtydAttempt(
  config: TinstarConfig,
  docStore: DocumentStore,
  name: string,
  verifiedGeneration: string,
  deps: VerifiedSessionTtydReattachDeps = verifiedSessionTtydReattachDeps,
): Promise<boolean> {
  if (deps.identityInspectionUnavailable()) return false
  const lease = deps.acquireLease(config, name, verifiedGeneration)
  if (!lease) return false
  let freshPort: number | null = null
  let session: Session | null = null
  let sessionPublished = false
  let priorRun: ReturnType<DocumentStore['getRun']> = undefined
  let runPublicationAttempted = false
  const abandonInconclusiveSurface = (): false => {
    if (freshPort != null) {
      deps.stopTtyd(session?.name ?? name)
      deps.releasePort(freshPort)
    }
    return false
  }
  try {
    session = deps.getSession(config.dirs.sessions, name)
    if (
      !session
      || session.state === 'stopped'
      || session.state === 'creating'
    ) return false
    let port = session.port ?? await deps.findPort(config)
    if (session.port == null) freshPort = port
    let result = await deps.reattach(config, { session, port })
    if (!deps.isCurrent(config, session, lease.token)) {
      deps.stopTtyd(session.name)
      if (freshPort != null) deps.releasePort(freshPort)
      return false
    }
    let surfaceState = await deps.verifySurface({
      port: result.port,
      pid: result.ttydPid,
      tmuxName: deps.tmuxName(config, session.name),
    })
    if (surfaceState === 'inconclusive') {
      return abandonInconclusiveSurface()
    }
    if (
      surfaceState === 'unhealthy'
      && session.port != null
      && deps.isCurrent(config, session, lease.token)
    ) {
      deps.stopTtyd(session.name)
      const staleSession = session
      const stalePort = session.port
      const staleRun = docStore.getRun(session.name)
      const clearedSession = deps.updateSession(
        config.dirs.sessions,
        session.name,
        { port: null, ttydPid: null },
      )
      if (!clearedSession) {
        throw new Error(`failed to retire stale port ${stalePort}`)
      }
      try {
        if (staleRun && staleRun.port != null) {
          docStore.upsertRun(session.name, { ...staleRun, port: null })
        }
      } catch (err) {
        const sessionRolledBack = deps.updateSession(
          config.dirs.sessions,
          staleSession.name,
          {
            port: staleSession.port,
            ttydPid: staleSession.ttydPid ?? null,
          },
        ) !== null
        try {
          if (staleRun) docStore.upsertRun(staleSession.name, staleRun)
        } catch {
          // The old claim remains held below when either rollback fails.
        }
        if (!sessionRolledBack) {
          log.warn(
            'reattach',
            `${name}: retaining stale port claim after retirement rollback failed`,
          )
        }
        throw err
      }
      deps.releasePort(stalePort)
      session = clearedSession
      port = await deps.findPort(config)
      freshPort = port
      result = await deps.reattach(config, { session, port })
      if (!deps.isCurrent(config, session, lease.token)) {
        deps.stopTtyd(session.name)
        deps.releasePort(port)
        return false
      }
      surfaceState = await deps.verifySurface({
        port: result.port,
        pid: result.ttydPid,
        tmuxName: deps.tmuxName(config, session.name),
      })
    }
    if (surfaceState === 'inconclusive') {
      return abandonInconclusiveSurface()
    }
    if (
      surfaceState !== 'verified'
      || !deps.isCurrent(config, session, lease.token)
    ) {
      deps.stopTtyd(session.name)
      if (surfaceState === 'verified') {
        if (freshPort != null) deps.releasePort(freshPort)
        return false
      }
      throw new Error(`ttyd on port ${result.port} did not become ready`)
    }
    const updated = deps.updateSession(
      config.dirs.sessions,
      session.name,
      { port: result.port, ttydPid: result.ttydPid ?? null },
    )
    if (!updated) {
      deps.stopTtyd(session.name)
      if (freshPort != null) deps.releasePort(freshPort)
      return false
    }
    sessionPublished = true
    const sessionName = session.name
    deps.onTtydRestart(sessionName, (newPid) => {
      const callbackLease = deps.acquireLease(
        config,
        sessionName,
        lease.token,
      )
      if (!callbackLease) return
      try {
        deps.updateSession(config.dirs.sessions, sessionName, { ttydPid: newPid })
      } finally {
        callbackLease.release()
      }
    })
    priorRun = docStore.getRun(session.name)
    if (priorRun && priorRun.port !== result.port) {
      runPublicationAttempted = true
      docStore.upsertRun(session.name, { ...priorRun, port: result.port })
    }
    log.info('reattach', `${session.name}: ttyd ready on :${result.port}`)
    return true
  } catch (err) {
    // A newer lifecycle boundary owns whatever terminal survives, but cannot
    // inherit our allocator claim: findPort skips claimed ports and verifies a
    // real bind before reuse. Return the fresh claim without stopping a surface
    // that may already belong to the winning boundary.
    if (deps.isSupersededError(err)) {
      if (freshPort != null) deps.releasePort(freshPort)
      const stage = tmuxBackend.findTtydStartSupersededError(err)?.stage
      log.info(
        'reattach',
        `${name}: reattach superseded${stage ? ` at ${stage}` : ''}`
          + ' by a newer lifecycle boundary',
      )
      return false
    }
    // Strict host-inspection failures are explicitly inconclusive: reattach
    // has not created a replacement, so tearing down the incumbent would turn
    // an observation outage into a terminal outage.
    const inspectionInconclusive = deps.isIdentityInspectionError(err)
    if (!inspectionInconclusive) deps.stopTtyd(name)
    let rollbackComplete = true
    if (sessionPublished && session) {
      try {
        rollbackComplete = deps.updateSession(
          config.dirs.sessions,
          session.name,
          {
            port: session.port ?? null,
            ttydPid: session.ttydPid ?? null,
          },
        ) !== null
      } catch (rollbackErr) {
        rollbackComplete = false
        log.warn(
          'reattach',
          `${name}: failed to roll back Session publication: `
          + `${(rollbackErr as Error).message}`,
        )
      }
    }
    if (runPublicationAttempted && priorRun) {
      try {
        docStore.upsertRun(name, priorRun)
      } catch (rollbackErr) {
        rollbackComplete = false
        log.warn(
          'reattach',
          `${name}: failed to roll back Run projection: `
          + `${(rollbackErr as Error).message}`,
        )
      }
    }
    if (freshPort != null) {
      if (rollbackComplete) {
        deps.releasePort(freshPort)
      } else {
        log.warn(
          'reattach',
          `${name}: retaining port ${freshPort} after publication rollback failed`,
        )
      }
    }
    log.warn(
      'reattach',
      `${name}: failed to reattach: ${(err as Error).message}`,
    )
    return false
  } finally {
    lease.release()
  }
}

/** Serialize reattach attempts by session name while allowing different names in parallel. */
export function createSessionTtydReattachSingleFlight(
  operation: (name: string, generation: string) => Promise<boolean>,
): (name: string, generation: string) => Promise<boolean> {
  const inFlight = new Map<string, {
    tail: Promise<boolean>
    byGeneration: Map<string, Promise<boolean>>
  }>()
  return (name, generation) => {
    const existingState = inFlight.get(name)
    const existingAttempt = existingState?.byGeneration.get(generation)
    if (existingAttempt) return existingAttempt
    // A newer backend generation must not collapse onto a stale attempt.
    // Queue it behind the current name-scoped mutation, then run with its own
    // lease once the older attempt has released.
    const attempt = (
      existingState
        ? existingState.tail.catch(() => false).then(
          () => operation(name, generation),
        )
        : operation(name, generation)
    ).finally(() => {
      const current = inFlight.get(name)
      if (!current) return
      if (current.byGeneration.get(generation) === attempt) {
        current.byGeneration.delete(generation)
      }
      if (current.tail === attempt && current.byGeneration.size === 0) {
        inFlight.delete(name)
      }
    })
    const state = existingState ?? {
      tail: attempt,
      byGeneration: new Map<string, Promise<boolean>>(),
    }
    state.tail = attempt
    state.byGeneration.set(generation, attempt)
    inFlight.set(name, state)
    return attempt
  }
}

export function initBackend(): RouteContext {
  // Instantiate core components
  const bus = new EventBus()
  const docStore = new DocumentStore()
  const otelStore = new OTelStore()
  const providerRegistry = createDefaultProviderRegistry()

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
        const sess = getLiveSessionForBoot(docStore, sessionConfig.dirs.sessions, entry.name)
        if (!sess) continue
        rehydrateSaloonSubs(natsTraffic, sess)
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
        const sess = getLiveSessionForBoot(docStore, sessionConfig.dirs.sessions, entry.name)
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
  const bootDeletionCleanups: Promise<void>[] = []

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
        const sess = getLiveSessionForBoot(docStore, sessionConfig.dirs.sessions, entry.name)
        if (!sess && existsSync(deletingMarker)) {
          // The marker is durable evidence that backend teardown may still be
          // incomplete. Hide its Run and NATS projections, reclaim its port
          // immediately, then make one strict backend probe: confirmed absence
          // finishes deletion while a live/unknown result remains recoverable.
          const cleanup = rehydrateDeletingSessionOnBoot(
            sessionConfig,
            entry.name,
          )
            .then(() => undefined)
            .catch(err => {
              log.warn(
                'rehydrate',
                `partially-deleted session cleanup crashed: `
                + `${entry.name}: ${(err as Error).message}`,
              )
            })
          bootDeletionCleanups.push(cleanup)
          continue
        }
        if (!sess) continue
        // Reclaim any port already bound to this session so a different session's
        // start path can't grab it via findPort() and trigger a ttyd kill war.
        if (sess.backend === 'tmux' && sess.port) {
          tmuxBackend.claimPort(sess.port)
        }
        const existingRun = docStore.getRun(sess.name)
        const tpl = sess.cliTemplate ? sessionConfig.cliTemplates.find(t => t.id === sess.cliTemplate) : null
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
            // Direct subject is the second subscription (index 1) in two-tier model
            // Format: [broadcast, direct] where direct = broadcast + session name.
            ...sessionNatsProjection(sess),
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
          const refreshed = rehydrateRunProjectionFromSession(
            existingRun,
            sess,
            tpl?.icon,
          )
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
        if (state === 'stopped') {
          clearStoppedSessionPort(cfg, docStore, name)
        }
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

      const reattachVerifiedSessionTtyd = createSessionTtydReattachSingleFlight(
        (name, generation) =>
          reattachVerifiedSessionTtydAttempt(
            cfg,
            docStore,
            name,
            generation,
          ),
      )

      const confirmedLiveSessionGenerations = new Map<string, string>()
      reconcileSessionStates(cfg.dirs.sessions, {
        getTmuxSessionState: name =>
          probeOrRetireSessionBackendForReconcile(cfg, name),
        onTmuxSessionStateObserved: (name, observation) => {
          if (observation.state === 'exists') {
            confirmedLiveSessionGenerations.set(name, observation.generation)
          }
        },
        beforeStateChanged: (name, _state, observation) =>
          invalidatePersistedSessionBackendGenerationForConfig(
            cfg,
            name,
            observation.generation,
          ),
        onStateChanged: (name, state) => {
          onStateChanged(name, state)
          log.info('reconcile', `${name}: startup correction to ${state}`)
        },
      }).then(async () => {
        // Only publish a terminal after a strict positive tmux observation and
        // a successful ttyd readiness check. Inconclusive boot probes remain
        // fail-closed here and are retried by the periodic reconciliation.
        for (const [name, generation] of confirmedLiveSessionGenerations) {
          await reattachVerifiedSessionTtyd(name, generation)
        }

        // GC ttyds left squatting ports by prior backend lifecycles (their tmux
        // session is gone but ttyd survived the restart). Runs after reattach so
        // a session we just adopted is never mistaken for an orphan.
        tmuxBackend.reapOrphanTtyds(cfg.sessions.prefix)
          .then(n => { if (n > 0) log.info('reconcile', `startup orphan sweep reaped ${n} ttyd(s)`) })
          .catch(err => log.warn('reconcile', `startup orphan sweep failed: ${(err as Error).message}`))

        // Re-read after reattachment: deletion can start while the startup
        // probes are in flight, and deletion-marked records are not live.
        const currentSessions = await listSessions(cfg.dirs.sessions)
        // Seed the ready queue from all current session states so '[' works immediately after restart
        for (const session of currentSessions) {
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
          captureBackendGeneration: name =>
            persistedSessionBackendGenerationForConfig(cfg, name),
          isBackendGenerationCurrent: (name, generation) =>
            persistedSessionBackendGenerationForConfig(cfg, name) === generation,
          providerRegistry,
        })
        watcher.start()
      }).catch(err => log.warn('reconcile', `startup reconciliation failed: ${(err as Error).message}`))

      // Periodic session state reconciliation (30s)
      setInterval(() => {
        const verifiedLiveGenerations = new Map<string, string>()
        reconcileSessionStates(cfg.dirs.sessions, {
          getTmuxSessionState: name =>
            probeOrRetireSessionBackendForReconcile(cfg, name),
          onTmuxSessionStateObserved: (name, observation) => {
            if (observation.state === 'exists') {
              verifiedLiveGenerations.set(name, observation.generation)
            }
          },
          beforeStateChanged: (name, _state, observation) =>
            invalidatePersistedSessionBackendGenerationForConfig(
              cfg,
              name,
              observation.generation,
            ),
          onStateChanged: (name, state) => {
            onStateChanged(name, state)
            log.info('reconcile', `${name}: state corrected to ${state}`)
          },
        })
          .then(async () => {
            await Promise.allSettled(
              [...verifiedLiveGenerations].map(async ([name, generation]) => {
                const session = getSession(cfg.dirs.sessions, name)
                if (
                  !session
                  || session.state === 'stopped'
                  || session.state === 'creating'
                ) return
                if (tmuxBackend.ttydIdentityInspectionUnavailable()) return
                const surfaceState = session.port == null
                  ? 'unhealthy'
                  : await tmuxBackend.verifyTtydSessionSurface({
                    port: session.port,
                    pid: session.ttydPid ?? undefined,
                    tmuxName: tmuxBackend.tmuxSessionName(cfg, session.name),
                    timeout: 750,
                    interval: 150,
                  })
                if (surfaceState === 'unhealthy') {
                  await reattachVerifiedSessionTtyd(name, generation)
                }
              }),
            )
          })
          .catch(err => console.error('[reconcile] error:', (err as Error).message))
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
    sessionConfig, readyQueue, telemetryRoutes, ccQuotaService, refreshCoordinator,
    slashRegistry, slashUsage, otlpExporter,
    providerRegistry,
    get natsTraffic() { return natsTraffic },
    get natsHealth() { return natsHealth },
  }

  // Auto-start the marshal so it's always available without a UI nudge.
  // Deferred so it doesn't block server startup. Await any durable deletion
  // retries first: a successfully cleaned stale marshal must be recreated
  // after its boot owner releases the name, not rejected once and forgotten.
  setImmediate(() => {
    afterBootDeletionCleanups(
      bootDeletionCleanups,
      () => ensureMarshalSession(ctx),
    )
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

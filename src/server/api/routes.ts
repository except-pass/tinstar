import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { log } from '../logger'
import { getMetricsText, register as turnLengthRegister } from '../observability/turn-length'
import type { DocumentStore } from '../stores/document-store'
import type { OTelStore } from '../stores/otel-store'
import type { SSEBroadcaster } from './sse'
import type { EventBus } from '../event-bus'
import type { BusEvent, BusEventType, PayloadFor } from '../types'
import { buildAgentSubject, BREAKOUT_PREFIX } from '../nats/subjects'
import { ok as okEnvelope, fail as failEnvelope, type OkOpts, type FailOpts } from './envelope'
import type { ErrorCode } from '../../domain/api'
import type { TinstarConfig } from '../sessions/config'
import type { Session } from '../sessions/session'
import { detectBranch } from '../sessions/session'
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  setState,
  claudeStateDir,
  getProject,
  listProjects,
  registerProject,
  unregisterProject,
  createWorktree,
  listWorktrees,
  listSessions,
  reconcileSessionStates,
  loadSecrets,
  tmuxBackend,
} from '../sessions'
import { resolveEntitySettings } from '../sessions/entity-settings'
import type { Run, EditorWidget, ImageWidget, TopicMetadata } from '../../domain/types'
import { saveActiveSpaceId, deepMerge, loadConfigMerged } from '../sessions/config'
import { emptyGraph, addMember, type ConstellationSlot } from '../../domain/constellationGraph'
import { spec as openapiSpec } from './openapi'
import { bounceNatsTraffic } from './natsTrafficBounce'
import { registerSaloonSubs, unregisterSaloonSubs } from './saloonBridge'
import { ReadyQueue } from '../sessions/ReadyQueue'
import { buildCommitRecord, reconcileGitHistory } from '../commits'
import { shortId } from '../utils/shortId'
import { imageSize } from 'image-size'
import { computeNatsSubscriptions, diffSubscriptions, sanitizeSubjectToken } from '../sessions/nats-subscriptions'
import { natsControlSocketPath } from '../sessions/backends/tmux'
import { probeNatsLiveStatus } from '../nats-health'
import { getDetailedUsage } from '../sessions/context-usage'
import type { TelemetryRoutes } from './telemetry'
import { joinParticipants, deriveHierarchicalName, bootstrapHierarchicalTopicMetadata } from '../topic-metadata'
import type { SlashCommandRegistry } from '../sessions/slashCommandRegistry'
import type { SlashUsage } from '../sessions/slashUsage'
import { extractLeadingSlashName } from '../sessions/slashUsage'
import type { OtlpExporter } from '../stores/otlp-exporter'
import { resolveCorsHeaders, parseAllowlistFromEnv } from './cors'
import { resolveWidgetRegistry } from './pluginWidgetRegistry'
import type { PluginWidgetInstance } from '../../domain/types'

function currentCorsAllowlist(): string[] {
  return parseAllowlistFromEnv(process.env.TINSTAR_CORS_ORIGINS)
}

/** Build a hierarchical NATS subject for a session: tinstar.<space>.<init>.<epic>.<task>.<session> */
function buildNatsSubject(
  sessionName: string,
  docStore: DocumentStore,
  taskId?: string,
  epicId?: string,
  initiativeId?: string,
): string {
  const BLANK = '_'
  const sanitize = sanitizeSubjectToken

  // Resolve hierarchy
  let initId = initiativeId
  let epId = epicId
  let spaceId: string | undefined

  if (taskId) {
    const task = docStore.getTask(taskId)
    if (task) {
      epId = epId || task.epicId
      initId = initId || task.initiativeId
      spaceId = task.spaceId
    }
  }
  if (epId && !initId) {
    const epic = docStore.getEpic(epId)
    if (epic) {
      initId = epic.initiativeId
      spaceId = spaceId || epic.spaceId
    }
  }
  if (initId && !spaceId) {
    const init = docStore.getInitiative(initId)
    if (init) {
      spaceId = init.spaceId
    }
  }

  const space = spaceId ? docStore.getSpace(spaceId) : null
  const initiative = initId ? docStore.getInitiative(initId) : null
  const epic = epId ? docStore.getEpic(epId) : null
  const task = taskId ? docStore.getTask(taskId) : null

  const spaceName = space ? sanitize(space.name) : BLANK
  const initName = initiative ? sanitize(initiative.name) : BLANK
  const epicName = epic ? sanitize(epic.name) : BLANK
  const taskName = task ? sanitize(task.name) : BLANK

  return buildAgentSubject({
    space: spaceName,
    init: initName,
    epic: epicName,
    task: taskName,
    session: sanitize(sessionName),
  })
}
import { discoverHands, getHandByName } from '../hands'
import { MARSHAL_AGENT_NAME, MARSHAL_AGENT_DESCRIPTION, MARSHAL_AGENT_PROMPT } from '../hands/builtins/index'

// ─── NATS socket communication ─────────────────────────────────────────

/**
 * Send a command to the channel server's Unix socket for hot subscription management.
 * Path is defined by natsControlSocketPath() and wired up on the channel-server side
 * by the --control-socket arg set in generateNatsMcpConfig (backends/tmux.ts).
 */
function sendNatsSocketCommand(sessionName: string, cmd: { action: 'subscribe' | 'unsubscribe' | 'delete-durable'; subject: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socketPath = natsControlSocketPath(sessionName)
    const socket = createConnection(socketPath)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Socket timeout'))
    }, 5000)

    socket.on('connect', () => {
      socket.write(JSON.stringify(cmd) + '\n')
      clearTimeout(timeout)
      socket.end()
      resolve()
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/**
 * A structured description of why a NATS control-socket command failed.
 * Returned to API callers so they can surface the failure instead of us
 * silently eating it.
 *
 * - NATS_SOCKET_UNREACHABLE (ENOENT): socket file is gone — session stopped
 *   or never started. Persisted state will apply on next startup. Safe.
 * - NATS_SOCKET_ORPHANED (ECONNREFUSED, file present): a second channel-server
 *   instance unlinked the original listener's socket file (see
 *   except-pass/nats-channel-mcp channel-server.ts unlinkSync+listen on start).
 *   The live channel-server's listener is bound to an orphaned inode. Static
 *   subscriptions from startup still work — dynamic subscribes never will
 *   until the session is restarted.
 * - NATS_SOCKET_ERROR: other unexpected failure.
 */
type NatsSocketWarningCode =
  | 'NATS_SOCKET_UNREACHABLE'
  | 'NATS_SOCKET_ORPHANED'
  | 'NATS_SOCKET_ERROR'
  // Deprecated, kept for backwards-compat in structured responses: maps to
  // UNREACHABLE | ORPHANED based on file presence. Callers should key off
  // the new codes.
  | 'NATS_SOCKET_MISSING'

interface NatsSocketWarning {
  code: NatsSocketWarningCode
  message: string
  action: 'subscribe' | 'unsubscribe' | 'delete-durable'
  subject: string
  /** Parent session is alive but its dynamic-subscribe path is dead; caller should restart the session to recover. */
  restartRecommended?: boolean
}

export function classifyNatsSocketError(
  err: unknown,
  action: 'subscribe' | 'unsubscribe' | 'delete-durable',
  subject: string,
  sessionName: string,
  fileExists: boolean,
): NatsSocketWarning {
  const e = err as NodeJS.ErrnoException
  if (e?.code === 'ENOENT') {
    return {
      code: 'NATS_SOCKET_UNREACHABLE',
      message: `Session '${sessionName}' control socket is not present — session is not running. Registry update persisted; will apply on next start.`,
      action,
      subject,
    }
  }
  if (e?.code === 'ECONNREFUSED') {
    if (fileExists) {
      // File present but no listener → orphaned by a startup-sequence
      // collision in the external channel-server package. Session is alive
      // but dynamic subscribes will never land until restart.
      return {
        code: 'NATS_SOCKET_ORPHANED',
        message: `Session '${sessionName}' is running but its NATS control socket is orphaned — a channel-server restart unlinked the live listener. Dynamic ${action} on '${subject}' will NOT take effect. Static subscriptions from session start still work; restart the session to recover dynamic-subscribe.`,
        action,
        subject,
        restartRecommended: true,
      }
    }
    // ECONNREFUSED without a file is odd (race with unlink) — treat as unreachable
    return {
      code: 'NATS_SOCKET_UNREACHABLE',
      message: `Session '${sessionName}' control socket refused the connection and the file is gone. Registry update persisted; will apply on next start.`,
      action,
      subject,
    }
  }
  return {
    code: 'NATS_SOCKET_ERROR',
    message: e?.message ?? String(err),
    action,
    subject,
  }
}

/**
 * Attempt a control-socket command and return a structured warning on
 * failure instead of throwing. ENOENT / ECONNREFUSED are logged at `warn`
 * (expected when the session isn't running); anything else is logged at
 * `error` (unexpected — channel server died or went unresponsive with the
 * socket still on disk).
 */
async function trySendNatsSocketCommand(
  sessionName: string,
  cmd: { action: 'subscribe' | 'unsubscribe' | 'delete-durable'; subject: string },
): Promise<NatsSocketWarning | null> {
  try {
    await sendNatsSocketCommand(sessionName, cmd)
    return null
  } catch (err) {
    const fileExists = existsSync(natsControlSocketPath(sessionName))
    const warning = classifyNatsSocketError(err, cmd.action, cmd.subject, sessionName, fileExists)
    // UNREACHABLE is the expected "session not running" case — warn.
    // ORPHANED is a real in-flight failure: session is up but subscribe silently drops — error.
    const logFn = warning.code === 'NATS_SOCKET_UNREACHABLE' ? log.warn : log.error
    logFn('nats', `control-socket ${cmd.action} failed for ${sessionName} (${cmd.subject}): ${warning.message}`, {
      sessionName,
      action: cmd.action,
      subject: cmd.subject,
      code: warning.code,
    })
    return warning
  }
}

// ─── Multiplexed file watcher ──────────────────────────────────────────
// Tracks fs.watch instances keyed by absolute path. Multiple subscribers
// (image widgets, file editors) share a single watcher per file. Updates
// are broadcast through the singleton SSE connection, avoiding per-widget
// EventSource connections that exhaust HTTP/1.1's 6-connection limit.

interface WatcherEntry {
  watcher: ReturnType<typeof watch>
  debounceTimer: ReturnType<typeof setTimeout> | null
  subscribers: Set<string>  // subscriber IDs
  absolutePath: string
  mode: 'content' | 'notify'  // content = send file contents (editor), notify = send timestamp (image)
}

const fileWatchers = new Map<string, WatcherEntry>()

function watcherKey(absolutePath: string): string {
  return absolutePath
}

function addFileWatchSubscriber(
  absolutePath: string,
  subscriberId: string,
  mode: 'content' | 'notify',
  sse: SSEBroadcaster,
): void {
  const key = watcherKey(absolutePath)
  const existing = fileWatchers.get(key)
  if (existing) {
    existing.subscribers.add(subscriberId)
    return
  }

  const entry: WatcherEntry = {
    watcher: null!,
    debounceTimer: null,
    subscribers: new Set([subscriberId]),
    absolutePath,
    mode,
  }

  try {
    entry.watcher = watch(absolutePath, () => {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(() => {
        if (mode === 'content') {
          readFile(absolutePath, 'utf-8').then(content => {
            sse.broadcastEvent('file_watch', { path: absolutePath, type: 'content', data: content })
          }).catch(() => {
            sse.broadcastEvent('file_watch', { path: absolutePath, type: 'error', data: 'file unavailable' })
          })
        } else {
          sse.broadcastEvent('file_watch', { path: absolutePath, type: 'updated', timestamp: Date.now() })
        }
      }, 50)
    })
    fileWatchers.set(key, entry)
  } catch {
    // file may not exist yet — that's ok, subscriber will get nothing until it does
  }
}

function removeFileWatchSubscriber(absolutePath: string, subscriberId: string): void {
  const key = watcherKey(absolutePath)
  const entry = fileWatchers.get(key)
  if (!entry) return
  entry.subscribers.delete(subscriberId)
  if (entry.subscribers.size === 0) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.watcher.close()
    fileWatchers.delete(key)
  }
}


interface CreateSessionParams {
  name: string
  project?: string
  worktree?: boolean
  worktreePath?: string
  prompt?: string
  skipPermissions?: boolean
  cliTemplate?: string
  taskId?: string
  epicId?: string
  initiativeId?: string
  color?: string
  nats?: { enabled: boolean; subscriptions?: string[] }
  /** Persistent persona for this session — substituted into the CLI template
   * via {agentName}/{agentJson}/{agentPrompt}/{agentDescription} placeholders.
   * Used by the marshal so its persona survives `/clear`. */
  agent?: { name: string; description: string; prompt: string }
  /** Extra text appended to the agent's system prompt via the CLI's
   * --append-system-prompt. Used to inject a resolved hand's prompt. The
   * caller resolves the hand (POST /api/sessions owns the not-found response);
   * this is the already-resolved text. */
  appendSystemPrompt?: string | null
}

interface CreateSessionContext {
  cfg: TinstarConfig
  sessDir: string
  docStore: DocumentStore
  readyQueue: ReadyQueue
  sse: SSEBroadcaster
  emitSessionEvent: <T extends BusEventType>(type: T, payload: PayloadFor<T>) => void
  secrets: () => Record<string, string>
  dashboardUrl: string
  natsTraffic?: import('../nats-traffic').NatsTrafficBridge
  natsHealth?: import('../nats-health').NatsHealthMonitor
}

async function createSessionInternal(
  params: CreateSessionParams,
  ctx: CreateSessionContext
): Promise<{ ok: true; session: Session } | { ok: false; error: { code: string; message: string } }> {
  const {
    name, project, worktree = false, worktreePath,
    prompt, skipPermissions = true, cliTemplate: cliTemplateName,
    taskId, epicId, initiativeId, color: colorParam, nats, agent, appendSystemPrompt
  } = params

  const { cfg, sessDir, docStore, readyQueue, sse, emitSessionEvent, secrets, natsTraffic, natsHealth } = ctx

  if (!name) return { ok: false, error: { code: 'MISSING_NAME', message: 'Session name is required' } }

  if (getSession(sessDir, name)) {
    return { ok: false, error: { code: 'SESSION_EXISTS', message: `Session '${name}' already exists` } }
  }

  // Resolve project
  let projectPath: string | null = null
  if (project) {
    projectPath = getProject(cfg.files.projects, project)
    if (!projectPath) return { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: `Project '${project}' not found` } }
  }

  // Create worktree or use existing
  let workspacePath = projectPath
  let branch: string | null = null
  if (worktreePath && projectPath) {
    workspacePath = worktreePath
    branch = await detectBranch(worktreePath)
  } else if (worktree && projectPath) {
    workspacePath = await createWorktree(projectPath, name)
    branch = name
  }

  const isWorktree = !!(worktreePath || worktree)

  // Register a Worktree entity so it appears in hierarchy/grouping
  let worktreeEntityId = ''
  if (isWorktree && workspacePath) {
    worktreeEntityId = name
    docStore.upsertWorktree(worktreeEntityId, {
      id: worktreeEntityId,
      name,
      branch: branch ?? name,
      repo: project ?? '',
      worktreePath: workspacePath,
      spaceId: docStore.activeSpaceId,
    })
  }

  // Resolve run color
  const color = colorParam
    ?? (taskId ? docStore.getTask(taskId)?.settings?.defaultRunColor : undefined)
    ?? (epicId ? docStore.getEpic(epicId)?.settings?.defaultRunColor : undefined)
    ?? (initiativeId ? docStore.getInitiative(initiativeId)?.settings?.defaultRunColor : undefined)

  // Resolve CLI template
  const resolvedTemplate = cliTemplateName
    ? cfg.cliTemplates.find(t => t.name === cliTemplateName) ?? null
    : null

  // Compute NATS subscriptions
  let resolvedNats: { enabled: boolean; subscriptions: string[] } | null = nats ? { enabled: nats.enabled, subscriptions: nats.subscriptions ?? [] } : null
  const natsCtx = {
    sessionName: name,
    spaceId: docStore.activeSpaceId || null,
    taskId: taskId || null,
    epicId: epicId || null,
    initiativeId: initiativeId || null,
  }
  if (!nats && (taskId || epicId || initiativeId)) {
    resolvedNats = { enabled: true, subscriptions: computeNatsSubscriptions(natsCtx, docStore) }
  } else if (nats?.enabled && !nats.subscriptions?.length) {
    resolvedNats = { enabled: true, subscriptions: computeNatsSubscriptions(natsCtx, docStore) }
  }

  const session = createSession(sessDir, {
    name,
    backend: 'tmux',
    project,
    workspace: {
      path: workspacePath,
      worktree: isWorktree,
      branch,
      basePath: isWorktree ? projectPath : null,
    },
    profile: null,
    oneshot: false,
    skipPermissions,
    cliTemplate: cliTemplateName ?? null,
    adapter: resolvedTemplate?.adapter ?? null,
    nats: resolvedNats,
  })

  const enriched = session as Session & { _stateDir?: string; initialPrompt?: string }
  enriched._stateDir = claudeStateDir(sessDir, name)

  const sec = secrets()
  const port = await tmuxBackend.findPort(cfg.ports.hostStart)
  if (prompt) enriched.initialPrompt = prompt

  const result = await tmuxBackend.createTmuxSession(cfg, { session: enriched, secrets: sec, port, template: resolvedTemplate, agent: agent ?? null, appendSystemPrompt: appendSystemPrompt ?? null })
  const sessionPort = result.port
  updateSession(sessDir, name, { port: sessionPort, ttydPid: result.ttydPid ?? null, state: 'running' })
  tmuxBackend.onTtydRestart(name, (newPid) => {
    updateSession(sessDir, name, { ttydPid: newPid })
  })

  // Create Run entry
  const runId = name
  const initialStatus = prompt ? 'running' : 'idle'
  const backendInfo = `tmux session: ${name}`

  // Build NATS subject for this session
  const natsSubject = resolvedNats?.enabled
    ? buildNatsSubject(name, docStore, taskId, epicId, initiativeId)
    : undefined

  docStore.upsertRun(runId, {
    id: runId,
    color,
    status: initialStatus,
    sessionId: name,
    initiative: initiativeId ?? '',
    epic: epicId ?? '',
    task: taskId ?? '',
    repo: project ?? '',
    worktree: isWorktree ? (branch ?? name) : '',
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: sessionPort ?? null,
    backend: 'tmux',
    backendInfo,
    agentIcon: resolvedTemplate?.icon ?? undefined,
    natsEnabled: resolvedNats?.enabled ?? false,
    natsSubject,
    natsSubscriptions: resolvedNats?.enabled ? resolvedNats.subscriptions : undefined,
    natsControlOrphanedAt: session.natsControlOrphanedAt ?? null,
    taskId: taskId ?? '',
    worktreeId: worktreeEntityId,
    createdAt: new Date().toISOString(),
    spaceId: docStore.activeSpaceId,
  })

  registerSaloonSubs(natsTraffic, name, resolvedNats?.enabled ? resolvedNats.subscriptions : [])
  bootstrapHierarchicalTopicMetadata(resolvedNats?.subscriptions ?? [], name, docStore)
  if (resolvedNats?.enabled) natsHealth?.trackSession(name)

  readyQueue.onStatusChange(name, initialStatus)
  sse.setReadyQueue(readyQueue.getQueue())
  sse.broadcastReadyQueueUpdate()
  emitSessionEvent('managed_session.created', { name, state: 'running' })

  const updated = getSession(sessDir, name)!
  return { ok: true, session: updated }
}

export interface RouteContext {
  docStore: DocumentStore
  otelStore: OTelStore
  sse: SSEBroadcaster
  bus: EventBus
  startSimulator: () => void
  resetSimulator: () => void
  sessionConfig: TinstarConfig | null
  readyQueue: ReadyQueue
  natsTraffic?: import('../nats-traffic').NatsTrafficBridge
  natsHealth?: import('../nats-health').NatsHealthMonitor
  telemetryRoutes?: TelemetryRoutes
  ccQuotaService?: import('../cc-quota/service').CcQuotaService
  slashRegistry?: SlashCommandRegistry
  slashUsage?: SlashUsage
  otlpExporter?: OtlpExporter
}

function moduleJson(res: ServerResponse, data: unknown, status = 200, corsHeaders?: Record<string, string>): true {
  // Some routes respond asynchronously (e.g. readBody(...).then(...)).
  // If the client disconnects or another codepath already responded, avoid crashing
   // with ERR_HTTP_HEADERS_SENT.
  if (res.headersSent || res.writableEnded) return true
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(corsHeaders ?? { 'Access-Control-Allow-Origin': '*' }),
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(data))
  return true
}

/** Deep-merge entity patch with special handling for settings sub-object.
 * - settings keys with null values are stripped (returns to "inherit" state)
 * - settings sub-object is merged, not replaced
 */
function deepMergeEntity<T extends Record<string, unknown>>(existing: T, patch: Record<string, unknown>): T {
  const result = { ...existing, ...patch }
  if (patch.settings && typeof patch.settings === 'object') {
    const existingSettings = (existing as Record<string, unknown>).settings as Record<string, unknown> | undefined
    const mergedSettings = { ...existingSettings, ...patch.settings as Record<string, unknown> }
    // Strip null-valued keys (clearing local override)
    for (const key of Object.keys(mergedSettings)) {
      if (mergedSettings[key] === null) delete mergedSettings[key]
    }
    ;(result as Record<string, unknown>).settings = Object.keys(mergedSettings).length > 0 ? mergedSettings : undefined
  }
  return result
}

// --- Canvas widget placement (host placement API) ---

/** Gap (canvas units) placed between a widget and its `nearNodeId` reference.
 *  Mirrors RUN_GAP in useWidgetLayouts.ts. */
const PLACEMENT_GAP = 20
const DEFAULT_BROWSER_SIZE = { width: 800, height: 600 }

interface PlacementInput {
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  nearNodeId?: string
}

interface LayoutEntry { x: number; y: number; width: number; height: number }

/** Look up a node's persisted layout (x/y/width/height) from
 *  `config.ui.layouts['tinstar-layouts-v3-<spaceId>']`. This is the SSOT the
 *  frontend hydrates from, so it's the right place to resolve `nearNodeId`. */
function lookupNodeLayout(ctx: RouteContext, spaceId: string, nodeId: string): LayoutEntry | null {
  try {
    const cfg = loadConfigMerged(ctx.sessionConfig?.dirs.root) as { ui?: { layouts?: Record<string, Record<string, LayoutEntry>> } }
    const byKey = cfg.ui?.layouts ?? {}
    const entry = byKey[`tinstar-layouts-v3-${spaceId}`]?.[nodeId]
    if (entry && typeof entry.x === 'number' && typeof entry.y === 'number') return entry
  } catch { /* fall through */ }
  return null
}

/** Resolve a placement request to a concrete `{ position, size }` seed, or null
 *  when no placement was requested / couldn't be resolved. Explicit `position`
 *  wins; otherwise `nearNodeId` places the new widget just to the right of the
 *  referenced node (same top edge). */
function resolvePlacement(
  ctx: RouteContext,
  spaceId: string,
  input: PlacementInput,
): { position: { x: number; y: number }; size: { width: number; height: number } } | null {
  const size = (input.size && Number.isFinite(input.size.width) && Number.isFinite(input.size.height))
    ? { width: input.size.width, height: input.size.height }
    : DEFAULT_BROWSER_SIZE
  if (input.position && Number.isFinite(input.position.x) && Number.isFinite(input.position.y)) {
    return { position: { x: input.position.x, y: input.position.y }, size }
  }
  if (input.nearNodeId) {
    const ref = lookupNodeLayout(ctx, spaceId, input.nearNodeId)
    if (ref) {
      return { position: { x: ref.x + ref.width + PLACEMENT_GAP, y: ref.y }, size }
    }
  }
  return null
}

/** Coerce a slot value (1..9, number or string) to a ConstellationSlot, or null. */
function toSlot(value: unknown): ConstellationSlot | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 9) return null
  return String(n) as ConstellationSlot
}

/** Add a widget to a space's constellation slot, server-side (reactive via SSE).
 *  Idempotent: addMember is a no-op if the membership already exists. */
function assignWidgetToSlot(ctx: RouteContext, spaceId: string, widgetId: string, slot: ConstellationSlot): void {
  const graph = ctx.docStore.getConstellationGraph(spaceId) ?? emptyGraph(spaceId)
  ctx.docStore.upsertConstellationGraph(spaceId, addMember(graph, widgetId, slot))
}

/** Synchronously enumerate every persisted session on disk. Mirrors the
 * rehydrate loop in index.ts (readdirSync + getSession per entry). Used by
 * topic-metadata routes to derive participants live from `nats.subscriptions`.
 */
function listAllSessions(ctx: RouteContext): Session[] {
  const sessDir = ctx.sessionConfig?.dirs.sessions
  if (!sessDir) return []
  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = readdirSync(sessDir, { withFileTypes: true, encoding: 'utf8' as const })
  } catch {
    return []
  }
  const out: Session[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sess = getSession(sessDir, entry.name)
    if (sess) out.push(sess)
  }
  return out
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

const MARSHAL_NAME = 'marshal'

/** Build a CreateSessionContext from the long-lived RouteContext. The
 * per-request handler builds this same shape inline; this helper lets the
 * boot path and the marshal endpoints reuse it without duplicating wiring. */
function buildCreateSessionContext(ctx: RouteContext): CreateSessionContext | null {
  if (!ctx.sessionConfig) return null
  const cfg = ctx.sessionConfig
  return {
    cfg,
    sessDir: cfg.dirs.sessions,
    docStore: ctx.docStore,
    readyQueue: ctx.readyQueue,
    sse: ctx.sse,
    emitSessionEvent: (type, payload) => ctx.bus.emit({ type, timestamp: new Date().toISOString(), payload } as BusEvent),
    secrets: () => loadSecrets(cfg.dirs.secrets),
    dashboardUrl: `http://localhost:${process.env.TINSTAR_DASHBOARD_PORT ?? 5273}`,
    natsTraffic: ctx.natsTraffic,
    natsHealth: ctx.natsHealth,
  }
}

type MarshalResult =
  | { ok: true; data: { name: string; port: number | null; state: string } }
  | { ok: false; error: { code: string; message: string } }

/** Idempotent — returns the existing marshal session if one is on disk,
 * otherwise creates a fresh one. Used by /api/marshal/ensure and called
 * from server boot so the marshal is always available without a UI nudge. */
export async function ensureMarshalSession(ctx: RouteContext): Promise<MarshalResult> {
  const createCtx = buildCreateSessionContext(ctx)
  if (!createCtx) return { ok: false, error: { code: 'NO_CONFIG', message: 'sessionConfig unavailable' } }

  const existing = getSession(createCtx.sessDir, MARSHAL_NAME)
  if (existing) {
    return { ok: true, data: { name: existing.name, port: existing.port ?? null, state: existing.state } }
  }

  const hand = getHandByName('marshal')
  if (!hand) return { ok: false, error: { code: 'HAND_NOT_FOUND', message: 'marshal hand definition is missing' } }

  const result = await createSessionInternal({
    name: MARSHAL_NAME,
    skipPermissions: true,
    cliTemplate: hand.cliTemplate,
    prompt: hand.prompt,
    agent: {
      name: MARSHAL_AGENT_NAME,
      description: MARSHAL_AGENT_DESCRIPTION,
      prompt: MARSHAL_AGENT_PROMPT,
    },
  }, createCtx)
  if (!result.ok) return { ok: false, error: result.error }

  const sess = getSession(createCtx.sessDir, MARSHAL_NAME)
  return { ok: true, data: { name: MARSHAL_NAME, port: sess?.port ?? null, state: sess?.state ?? 'running' } }
}

/** Tear down the existing marshal (if any) and create a fresh one. Used
 * when the session has crashed or wedged — equivalent to the user clicking
 * "restart marshal" in the sidebar. Synchronously awaits cleanup so the
 * subsequent create won't race with disk-dir removal. */
export async function restartMarshalSession(ctx: RouteContext): Promise<MarshalResult> {
  const createCtx = buildCreateSessionContext(ctx)
  if (!createCtx) return { ok: false, error: { code: 'NO_CONFIG', message: 'sessionConfig unavailable' } }
  const { cfg, sessDir } = createCtx

  const existing = getSession(sessDir, MARSHAL_NAME)
  if (existing) {
    try { writeFileSync(join(sessDir, MARSHAL_NAME, '.deleting'), '') } catch { /* dir may already be gone */ }
    ctx.docStore.deleteRun(MARSHAL_NAME)
    ctx.readyQueue.onDelete(MARSHAL_NAME)
    ctx.sse.setReadyQueue(ctx.readyQueue.getQueue())
    ctx.sse.broadcastReadyQueueUpdate()
    createCtx.emitSessionEvent('managed_session.deleted', { name: MARSHAL_NAME })

    try {
      await tmuxBackend.deleteTmuxSession(cfg, existing)
      if (existing.port) tmuxBackend.releasePort(existing.port)
    } catch (err) {
      log.warn('marshal-restart', `backend cleanup: ${(err as Error).message}`)
    }
    if (!deleteSession(sessDir, MARSHAL_NAME)) {
      // Disk dir didn't go away — wait briefly then try once more so the
      // following create doesn't trip the SESSION_EXISTS guard.
      await new Promise(r => setTimeout(r, 500))
      deleteSession(sessDir, MARSHAL_NAME)
    }
  }

  return ensureMarshalSession(ctx)
}

export async function handleRequest(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? ''
  const method = req.method ?? 'GET'

  const corsHeaders = resolveCorsHeaders({
    origin: req.headers.origin,
    allowlist: currentCorsAllowlist(),
  }) as Record<string, string>

  // Per-request shadow that auto-applies the resolved CORS headers.
  // Shadows the module-scope `json` so existing call sites don't need to be updated.
  const json = (res: ServerResponse, data: unknown, status = 200): true =>
    moduleJson(res, data, status, corsHeaders)

  // ok() and fail() are the application-API envelope helpers (ADR 0001).
  // Per-request shadows that thread corsHeaders through automatically, so call
  // sites read like English: `ok(res, data)` or `fail(res, 'NOT_FOUND', 'missing')`.
  const ok = <T>(res: ServerResponse, data: T, opts: OkOpts = {}): true =>
    okEnvelope(res, data, { ...opts, headers: { ...corsHeaders, ...(opts.headers ?? {}) } })
  const fail = (res: ServerResponse, code: ErrorCode, message: string, opts: FailOpts = {}): true =>
    failEnvelope(res, code, message, { ...opts, headers: { ...corsHeaders, ...(opts.headers ?? {}) } })

  // CORS preflight
  if (method === 'OPTIONS' && url.startsWith('/api/')) {
    res.writeHead(204, corsHeaders)
    res.end()
    return true
  }

  // Telemetry routes — delegated to createTelemetryRoutes
  if (ctx.telemetryRoutes && url.startsWith('/api/telemetry/')) {
    // Normalize pathname (strip query string)
    const pathname = url.split('?')[0] ?? url
    if (await ctx.telemetryRoutes.handle(req, res, pathname, corsHeaders)) return true
  }

  // GET /api/docs — Scalar API reference UI
  if (method === 'GET' && (url === '/api/docs' || url === '/api/docs/')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html>
<html><head><title>Tinstar API</title><meta charset="utf-8"/></head>
<body><script id="api-reference" data-url="/api/docs/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>`)
    return true
  }

  // GET /api/docs/openapi.json — raw OpenAPI spec
  if (method === 'GET' && url === '/api/docs/openapi.json') {
    json(res, openapiSpec)
    return true
  }

  // GET /api/metrics — Prometheus exposition for turn-length histogram
  if (method === 'GET' && url === '/api/metrics') {
    try {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': turnLengthRegister.contentType })
      res.end(await getMetricsText())
    } catch (err) {
      log.warn('metrics', `failed to render: ${(err as Error).message}`)
      res.writeHead(500, { ...corsHeaders, 'Content-Type': 'text/plain' })
      res.end('# error generating metrics\n')
    }
    return true
  }

  // GET /api/state — raw SSE snapshot shape (ADR 0001 exception); useServerEvents
  // consumes the same shape over SSE, so the body cannot be wrapped in the envelope.
  if (method === 'GET' && url === '/api/state') {
    const sessDir = ctx.sessionConfig?.dirs.sessions
    const sessions = sessDir ? await listSessions(sessDir) : []
    json(res, { ...ctx.docStore.snapshot(), sessions })
    return true
  }

  // GET /api/events (SSE)
  if (method === 'GET' && url === '/api/events') {
    ctx.sse.addClient(res, corsHeaders)
    return true
  }

  // GET /api/otel/spans
  if (method === 'GET' && url.startsWith('/api/otel/spans')) {
    const parsed = new URL(url, 'http://localhost')
    const traceId = parsed.searchParams.get('traceId')
    const spans = traceId ? ctx.otelStore.getSpansByTrace(traceId) : ctx.otelStore.getAllSpans()
    // Raw OTLP span array (ADR 0001 exception).
    json(res, spans)
    return true
  }

  // GET /api/otel/metrics
  if (method === 'GET' && url.startsWith('/api/otel/metrics')) {
    const parsed = new URL(url, 'http://localhost')
    const name = parsed.searchParams.get('name')
    const metrics = name ? ctx.otelStore.getMetricsByName(name) : ctx.otelStore.getAllMetrics()
    // Raw OTLP metric array (ADR 0001 exception).
    json(res, metrics)
    return true
  }

  // GET /api/cc-quota — returns the last pushed snapshot
  if (method === 'GET' && ctx.ccQuotaService && url === '/api/cc-quota') {
    // Raw cc-quota snapshot shape (ADR 0001 exception); consumed by useCcQuota
    // which expects the raw payload, not the envelope.
    json(res, ctx.ccQuotaService.getSnapshot())
    return true
  }

  // GET /api/slash-commands — returns registered slash commands merged with usage stats
  if (method === 'GET' && url === '/api/slash-commands') {
    if (!ctx.slashRegistry) return ok(res, { commands: [] })
    const commands = await ctx.slashRegistry.list()
    const usage = ctx.slashUsage?.snapshot() ?? {}
    const merged = commands.map(c => ({
      ...c,
      useCount: usage[c.name]?.count ?? 0,
      lastUsedAt: usage[c.name]?.lastUsedAt ?? null,
    }))
    return ok(res, { commands: merged })
  }

  // POST /api/cc-quota/ingest — Claude Code statusline hook pushes its full
  // session-state JSON here; we extract rate_limits and update the snapshot.
  if (method === 'POST' && ctx.ccQuotaService && url === '/api/cc-quota/ingest') {
    const body = await readBody(req)
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      fail(res, 'BAD_REQUEST', 'malformed_json')
      return true
    }
    const snap = ctx.ccQuotaService.ingest(payload)
    // Raw cc-quota snapshot shape (ADR 0001 exception). The snapshot's own
    // .data field would collide with the envelope's .data; consumers of the
    // POST response (just the test suite — statusline hooks ignore the body)
    // expect the raw shape that GET /api/cc-quota returns.
    json(res, snap)
    return true
  }

  // POST /api/simulator/start
  if (method === 'POST' && url === '/api/simulator/start') {
    ctx.startSimulator()
    ok(res, { status: 'started' })
    return true
  }

  // POST /api/simulator/reset
  if (method === 'POST' && url === '/api/simulator/reset') {
    ctx.resetSimulator()
    ok(res, { status: 'reset' })
    return true
  }

  // POST /api/simulator/patch-run — test-only: set any field on a run and broadcast delta
  if (method === 'POST' && url === '/api/simulator/patch-run') {
    const body = await readBody(req)
    const { id, ...patch } = JSON.parse(body) as { id: string } & Record<string, unknown>
    const run = ctx.docStore.getRun(id)
    if (!run) { fail(res, 'NOT_FOUND', 'run not found'); return true }
    const updated = { ...run, ...patch }
    ctx.docStore.upsertRun(id, updated)
    ok(res, null)
    return true
  }



  // POST /api/git/commit-hook
  if (method === 'POST' && url === '/api/git/commit-hook') {
    readBody(req).then(body => {
      try {
        const payload = JSON.parse(body) as {
          sha: string
          repo: string
          branch: string
          message: string
          authorName: string
          authorEmail: string
          authorDate: string
          worktreeId?: string
        }
        if (!ctx.sessionConfig) return fail(res, 'CONFIG_UNAVAILABLE', 'session config unavailable')
        if (!payload.sha || !payload.message) return fail(res, 'BAD_REQUEST', 'invalid payload')
        const record = buildCommitRecord(payload, 'hook', ctx.sessionConfig.git.taskMarkerRegex)
        const inserted = ctx.docStore.upsertCommit(record)
        ok(res, { inserted })
      } catch {
        fail(res, 'BAD_REQUEST', 'invalid json')
      }
    })
    return true
  }

  // POST /api/git/reconcile
  if (method === 'POST' && url === '/api/git/reconcile') {
    if (!ctx.sessionConfig) {
      fail(res, 'CONFIG_UNAVAILABLE', 'session config unavailable')
      return true
    }
    const result = reconcileGitHistory(ctx.docStore, ctx.sessionConfig)
    ok(res, result)
    return true
  }

  // GET /api/commits
  if (method === 'GET' && url.startsWith('/api/commits')) {
    const parsed = new URL(url, 'http://localhost')
    const taskTag = parsed.searchParams.get('taskTag')
    const assigned = parsed.searchParams.get('assigned')
    const since = parsed.searchParams.get('since')
    const until = parsed.searchParams.get('until')
    let commits = ctx.docStore.getAllCommits()
    if (taskTag) commits = commits.filter(c => c.taskTags.includes(taskTag))
    if (assigned === 'false') commits = commits.filter(c => c.taskTags.length === 0)
    if (since) commits = commits.filter(c => new Date(c.authorDate).getTime() >= new Date(since).getTime())
    if (until) commits = commits.filter(c => new Date(c.authorDate).getTime() <= new Date(until).getTime())
    commits = commits.sort((a, b) => new Date(b.authorDate).getTime() - new Date(a.authorDate).getTime())
    ok(res, commits)
    return true
  }

  // GET /api/standup
  if (method === 'GET' && url.startsWith('/api/standup')) {
    if (ctx.sessionConfig) reconcileGitHistory(ctx.docStore, ctx.sessionConfig)
    const parsed = new URL(url, 'http://localhost')
    const since = parsed.searchParams.get('since')
    const until = parsed.searchParams.get('until')
    let commits = ctx.docStore.getAllCommits()
    if (since) commits = commits.filter(c => new Date(c.authorDate).getTime() >= new Date(since).getTime())
    if (until) commits = commits.filter(c => new Date(c.authorDate).getTime() <= new Date(until).getTime())
    const grouped: Record<string, typeof commits> = {}
    const unassigned: typeof commits = []
    for (const commit of commits) {
      if (commit.taskTags.length === 0) {
        unassigned.push(commit)
        continue
      }
      for (const tag of commit.taskTags) {
        if (!grouped[tag]) grouped[tag] = []
        grouped[tag].push(commit)
      }
    }
    ok(res, { grouped, unassigned })
    return true
  }

  // POST /api/commit/:sha/assign-task
  if (method === 'POST' && /^\/api\/commit\/[^/]+\/assign-task$/.test(url)) {
    const sha = url.split('/')[3] ?? ''
    readBody(req).then(body => {
      try {
        const { taskTag } = JSON.parse(body) as { taskTag: string }
        if (!taskTag) return fail(res, 'BAD_REQUEST', 'taskTag is required')
        const updated = ctx.docStore.assignTaskTag(sha, taskTag)
        if (!updated) return fail(res, 'NOT_FOUND', 'not found')
        ok(res, updated)
      } catch {
        fail(res, 'BAD_REQUEST', 'invalid json')
      }
    })
    return true
  }

  // --- Spaces ---

  // GET /api/spaces
  if (method === 'GET' && url === '/api/spaces') {
    ok(res, ctx.docStore.getAllSpaces())
    return true
  }

  // POST /api/spaces
  if (method === 'POST' && url === '/api/spaces') {
    readBody(req).then(body => {
      const { name } = JSON.parse(body)
      const space = {
        id: shortId('spc'),
        name: name ?? 'Untitled Space',
        createdAt: new Date().toISOString(),
      }
      ctx.docStore.upsertSpace(space.id, space)
      ok(res, space, { status: 201 })
    })
    return true
  }

  // POST /api/spaces/:id/activate
  if (method === 'POST' && /^\/api\/spaces\/[^/]+\/activate$/.test(url)) {
    const id = url.split('/')[3]!
    const space = ctx.docStore.getSpace(id)
    if (!space) { fail(res, 'NOT_FOUND', 'not found'); return true }
    ctx.docStore.activeSpaceId = id
    if (ctx.sessionConfig) {
      saveActiveSpaceId(ctx.sessionConfig.dirs.root, id)
    }
    ctx.sse.broadcastSnapshot()
    ok(res, { activeSpaceId: id })
    return true
  }

  // PATCH /api/spaces/:id
  if (method === 'PATCH' && url.startsWith('/api/spaces/') && !url.includes('/activate')) {
    const id = url.slice('/api/spaces/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getSpace(id)
      if (!existing) return fail(res, 'NOT_FOUND', 'not found')
      const patch = JSON.parse(body)

      // Validate labelConfig if present
      if (patch.labelConfig !== undefined) {
        const levels = patch.labelConfig?.levels
        if (!Array.isArray(levels) || levels.length < 1 || levels.length > 3) {
          return fail(res, 'INVALID_PARAMS', 'labelConfig.levels must be an array of length 1–3')
        }
        for (const lvl of levels) {
          if (typeof lvl.label !== 'string' || !lvl.label.trim()) {
            return fail(res, 'INVALID_PARAMS', 'Each level must have a non-empty label')
          }
          if (typeof lvl.icon !== 'string' || !lvl.icon.trim()) {
            return fail(res, 'INVALID_PARAMS', 'Each level must have a non-empty icon')
          }
        }
      }

      ctx.docStore.upsertSpace(id, { ...existing, ...patch })
      ok(res, ctx.docStore.getSpace(id))
    })
    return true
  }

  // DELETE /api/spaces/:id
  if (method === 'DELETE' && url.startsWith('/api/spaces/') && !url.includes('/activate')) {
    const id = url.slice('/api/spaces/'.length)
    if (id === ctx.docStore.activeSpaceId) {
      fail(res, 'CONFLICT', 'Cannot delete the active space. Switch to another space first.')
      return true
    }
    if (ctx.docStore.getAllSpaces().length <= 1) {
      fail(res, 'CONFLICT', 'Cannot delete the last space.')
      return true
    }
    const orphanedRuns = ctx.docStore.getAllRuns().filter(r =>
      (r as Run).spaceId === id &&
      (r.status === 'running' || r.status === 'idle' || r.status === 'needs_attention')
    )
    ctx.docStore.clearSpace(id)
    ctx.docStore.deleteSpace(id)
    ok(
      res,
      null,
      orphanedRuns.length > 0
        ? { warnings: { orphanedRuns: [`${orphanedRuns.length} session(s) are still running. Use \`tmux ls\` to manage them.`] } }
        : undefined,
    )
    return true
  }

  // POST /api/initiatives
  if (method === 'POST' && url === '/api/initiatives') {
    readBody(req).then(body => {
      const { name, color, status, summary, id: providedId, externalUrl } = JSON.parse(body)
      const entity = {
        id: providedId ?? shortId('init'),
        name: name ?? 'Untitled Initiative',
        color: color ?? '#00f0ff',
        status: status ?? 'active',
        summary: summary ?? '',
        spaceId: ctx.docStore.activeSpaceId,
        externalUrl: externalUrl ?? null,
      }
      ctx.docStore.upsertInitiative(entity.id, entity)
      ok(res, entity, { status: 201 })
    })
    return true
  }

  // POST /api/epics
  if (method === 'POST' && url === '/api/epics') {
    readBody(req).then(body => {
      const { name, initiativeId, status, summary, id: providedId, externalUrl } = JSON.parse(body)
      const entity = {
        id: providedId ?? shortId('epic'),
        name: name ?? 'Untitled Epic',
        initiativeId: initiativeId ?? '',
        status: status ?? 'active',
        summary: summary ?? '',
        spaceId: ctx.docStore.activeSpaceId,
        externalUrl: externalUrl ?? null,
      }
      ctx.docStore.upsertEpic(entity.id, entity)
      ok(res, entity, { status: 201 })
    })
    return true
  }

  // POST /api/tasks
  if (method === 'POST' && url === '/api/tasks') {
    readBody(req).then(body => {
      const { name, epicId, initiativeId, status, id: providedId, percentDone, externalUrl } = JSON.parse(body)
      const entity = {
        id: providedId ?? shortId('task'),
        name: name ?? 'Untitled Task',
        epicId: epicId ?? '',
        initiativeId: initiativeId ?? '',
        status: status ?? 'active',
        spaceId: ctx.docStore.activeSpaceId,
        percentDone: percentDone ?? null,
        externalUrl: externalUrl ?? null,
      }
      ctx.docStore.upsertTask(entity.id, entity)

      ok(res, entity, { status: 201 })
    })
    return true
  }

  // POST /api/worktrees
  if (method === 'POST' && url === '/api/worktrees') {
    readBody(req).then(body => {
      const { name, branch, repo, worktreePath } = JSON.parse(body)
      const entity = {
        id: shortId('wt'),
        name: name ?? 'Untitled Worktree',
        branch: branch ?? '',
        repo: repo ?? '',
        worktreePath: worktreePath ?? '',
        spaceId: ctx.docStore.activeSpaceId,
      }
      ctx.docStore.upsertWorktree(entity.id, entity)
      ok(res, entity, { status: 201 })
    })
    return true
  }

  // GET /api/initiatives/:id
  if (method === 'GET' && /^\/api\/initiatives\/[^/]+$/.test(url)) {
    const id = url.slice('/api/initiatives/'.length)
    const entity = ctx.docStore.getInitiative(id)
    if (!entity) { fail(res, 'NOT_FOUND', 'not found'); return true }
    ok(res, entity)
    return true
  }

  // GET /api/epics/:id
  if (method === 'GET' && /^\/api\/epics\/[^/]+$/.test(url)) {
    const id = url.slice('/api/epics/'.length)
    const entity = ctx.docStore.getEpic(id)
    if (!entity) { fail(res, 'NOT_FOUND', 'not found'); return true }
    ok(res, entity)
    return true
  }

  // GET /api/tasks/:id
  if (method === 'GET' && /^\/api\/tasks\/[^/]+$/.test(url)) {
    const id = url.slice('/api/tasks/'.length)
    const entity = ctx.docStore.getTask(id)
    if (!entity) { fail(res, 'NOT_FOUND', 'not found'); return true }
    ok(res, entity)
    return true
  }

  // GET /api/initiatives/:id/settings
  if (method === 'GET' && /^\/api\/initiatives\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/initiatives/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'initiative', ctx.docStore)
    if (!result) { fail(res, 'NOT_FOUND', 'not found'); return true }
    ok(res, result)
    return true
  }

  // GET /api/epics/:id/settings
  if (method === 'GET' && /^\/api\/epics\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/epics/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'epic', ctx.docStore)
    if (!result) { fail(res, 'NOT_FOUND', 'not found'); return true }
    ok(res, result)
    return true
  }

  // GET /api/tasks/:id/settings
  if (method === 'GET' && /^\/api\/tasks\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/tasks/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'task', ctx.docStore)
    if (!result) { fail(res, 'NOT_FOUND', 'not found'); return true }
    ok(res, result)
    return true
  }

  // PATCH /api/initiatives/:id
  if (method === 'PATCH' && url.startsWith('/api/initiatives/')) {
    const id = url.slice('/api/initiatives/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getInitiative(id)
      if (!existing) return fail(res, 'NOT_FOUND', 'not found')
      const patch = JSON.parse(body) as Record<string, unknown>
      const merged = deepMergeEntity(existing as unknown as Record<string, unknown>, patch) as unknown as typeof existing
      ctx.docStore.upsertInitiative(id, merged)
      ok(res, ctx.docStore.getInitiative(id))
    })
    return true
  }

  // PATCH /api/epics/:id
  if (method === 'PATCH' && url.startsWith('/api/epics/')) {
    const id = url.slice('/api/epics/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getEpic(id)
      if (!existing) return fail(res, 'NOT_FOUND', 'not found')
      const patch = JSON.parse(body) as Record<string, unknown>
      const merged = deepMergeEntity(existing as unknown as Record<string, unknown>, patch) as unknown as typeof existing
      ctx.docStore.upsertEpic(id, merged)
      ok(res, ctx.docStore.getEpic(id))
    })
    return true
  }

  // PATCH /api/tasks/:id
  if (method === 'PATCH' && url.startsWith('/api/tasks/')) {
    const id = url.slice('/api/tasks/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getTask(id)
      if (!existing) return fail(res, 'NOT_FOUND', 'not found')
      const patch = JSON.parse(body) as Record<string, unknown>
      const merged = deepMergeEntity(existing as unknown as Record<string, unknown>, patch) as unknown as typeof existing
      ctx.docStore.upsertTask(id, merged)
      ok(res, ctx.docStore.getTask(id))
    })
    return true
  }

  // PATCH /api/worktrees/:id
  if (method === 'PATCH' && url.startsWith('/api/worktrees/')) {
    const id = url.slice('/api/worktrees/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getWorktree(id)
      if (!existing) return fail(res, 'NOT_FOUND', 'not found')
      const patch = JSON.parse(body)
      ctx.docStore.upsertWorktree(id, { ...existing, ...patch })
      ok(res, ctx.docStore.getWorktree(id))
    })
    return true
  }

  // GET /api/topics — all metadata records, with participants joined in
  if (method === 'GET' && url === '/api/topics') {
    const sessions = listAllSessions(ctx)
    const data = ctx.docStore.getAllTopicMetadata().map(m => joinParticipants(m, sessions))
    ok(res, data)
    return true
  }

  // GET /api/topics/:subject — single record
  if (method === 'GET' && url.startsWith('/api/topics/') && !url.endsWith('/refresh')) {
    const subject = decodeURIComponent(url.slice('/api/topics/'.length))
    const md = ctx.docStore.getTopicMetadata(subject)
    if (!md) return fail(res, 'NOT_FOUND', 'not found')
    ok(res, joinParticipants(md, listAllSessions(ctx)))
    return true
  }

  // PATCH /api/topics/:subject — rename / re-describe (anyone may write).
  // Upsert semantics: if no record exists yet, create one with kind='custom'.
  // The bootstrap path normally writes hierarchical records on session-create;
  // this fallback covers subjects the bootstrap missed (e.g. sessions that
  // pre-existed the feature, or arbitrary subjects a user wants to annotate).
  if (method === 'PATCH' && url.startsWith('/api/topics/') && !url.endsWith('/refresh')) {
    const subject = decodeURIComponent(url.slice('/api/topics/'.length))
    readBody(req).then(body => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(body)
      } catch {
        return fail(res, 'BAD_REQUEST', 'invalid json')
      }
      const existing = ctx.docStore.getTopicMetadata(subject) ?? {
        subject,
        kind: 'custom' as const,
        createdAt: new Date().toISOString(),
      }
      const merged: TopicMetadata = {
        ...existing,
        ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
        ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
      }
      ctx.docStore.upsertTopicMetadata(subject, merged)
      ok(res, joinParticipants(merged, listAllSessions(ctx)))
    })
    return true
  }

  // POST /api/topics/:subject/refresh — re-bootstrap a hierarchical name from
  // the entity tree's CURRENT values. No-op for breakout / custom kinds.
  if (method === 'POST' && url.startsWith('/api/topics/') && url.endsWith('/refresh')) {
    const subject = decodeURIComponent(url.slice('/api/topics/'.length, -('/refresh'.length)))
    const existing = ctx.docStore.getTopicMetadata(subject)
    if (!existing) return fail(res, 'NOT_FOUND', 'not found')
    if (existing.kind !== 'broadcast' && existing.kind !== 'dm') {
      return ok(res, joinParticipants(existing, listAllSessions(ctx)))
    }
    const refreshedName = deriveHierarchicalName(subject, ctx.docStore, existing.kind)
    if (refreshedName) {
      const merged = { ...existing, name: refreshedName }
      ctx.docStore.upsertTopicMetadata(subject, merged)
      return ok(res, joinParticipants(merged, listAllSessions(ctx)))
    }
    ok(res, joinParticipants(existing, listAllSessions(ctx)))
    return true
  }

  // DELETE /api/initiatives/:id
  if (method === 'DELETE' && url.startsWith('/api/initiatives/')) {
    const id = url.slice('/api/initiatives/'.length)
    ctx.docStore.deleteInitiative(id)
    ok(res, null)
    return true
  }

  // DELETE /api/epics/:id
  if (method === 'DELETE' && url.startsWith('/api/epics/')) {
    const id = url.slice('/api/epics/'.length)
    ctx.docStore.deleteEpic(id)
    ok(res, null)
    return true
  }

  // DELETE /api/tasks/:id
  if (method === 'DELETE' && url.startsWith('/api/tasks/')) {
    const id = url.slice('/api/tasks/'.length)
    ctx.docStore.deleteTask(id)
    ok(res, null)
    return true
  }

  // DELETE /api/worktrees/:id
  if (method === 'DELETE' && url.startsWith('/api/worktrees/')) {
    const id = url.slice('/api/worktrees/'.length)
    ctx.docStore.deleteWorktree(id)
    ok(res, null)
    return true
  }

  // POST /api/editor-widgets
  if (method === 'POST' && url === '/api/editor-widgets') {
    readBody(req).then(body => {
      const { sessionId, filePath } = JSON.parse(body) as { sessionId?: string; filePath?: string }
      if (!sessionId || !filePath) {
        fail(res, 'INVALID_PARAMS', 'sessionId and filePath required')
        return
      }
      const run = ctx.docStore.getAllRuns().find(r => r.sessionId === sessionId)
      if (!run) {
        fail(res, 'SESSION_NOT_FOUND', `No run with sessionId ${sessionId}`)
        return
      }
      // Resolve display names from taxonomy
      const task = ctx.docStore.getAllTasks().find(t => t.id === run.taskId)
      const epic = task ? ctx.docStore.getAllEpics().find(e => e.id === task.epicId) : undefined
      const initiative = epic ? ctx.docStore.getAllInitiatives().find(i => i.id === epic.initiativeId) : undefined
      const worktree = ctx.docStore.getAllWorktrees().find(w => w.id === run.worktreeId)

      // Resolve relative paths to absolute (Explorer panel sends relative paths)
      const sessDir = ctx.sessionConfig?.dirs.sessions ?? ''
      const session = getSession(sessDir, sessionId)
      const workspacePath = session?.workspace?.path
      const absoluteFilePath = (() => {
        if (!filePath.startsWith('/')) return workspacePath ? resolve(workspacePath, filePath) : filePath
        if (existsSync(filePath)) return filePath
        // Container-absolute path (e.g. /src/utils/foo.ts): strip leading slash, resolve against workspace
        return workspacePath ? resolve(workspacePath, filePath.replace(/^\/+/, '')) : filePath
      })()

      const widget: EditorWidget = {
        id: shortId('editor'),
        spaceId: ctx.docStore.activeSpaceId || undefined,
        sessionId,
        filePath: absoluteFilePath,
        task: task?.name ?? '',
        epic: epic?.name ?? '',
        initiative: initiative?.name ?? '',
        worktree: worktree?.name ?? '',
        repo: worktree?.repo ?? run.repo ?? '',
        color: run.color,
      }
      ctx.docStore.upsertEditorWidget(widget.id, widget)
      ok(res, widget)
    })
    return true
  }

  // DELETE /api/editor-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/editor-widgets/')) {
    const id = url.slice('/api/editor-widgets/'.length)
    const existing = ctx.docStore.getAllEditorWidgets().find(w => w.id === id)
    if (!existing) {
      fail(res, 'NOT_FOUND', `EditorWidget ${id} not found`)
      return true
    }
    ctx.docStore.deleteEditorWidget(id)
    ok(res, null)
    return true
  }

  // POST /api/image-widgets
  if (method === 'POST' && url === '/api/image-widgets') {
    readBody(req).then(body => {
      try {
      const { sessionId, filePath } = JSON.parse(body) as { sessionId?: string; filePath?: string }
      if (!sessionId || !filePath) {
        fail(res, 'INVALID_PARAMS', 'sessionId and filePath required')
        return
      }
      const run = ctx.docStore.getAllRuns().find(r => r.sessionId === sessionId)
      if (!run) {
        fail(res, 'SESSION_NOT_FOUND', `No run with sessionId ${sessionId}`)
        return
      }
      const task = ctx.docStore.getAllTasks().find(t => t.id === run.taskId)
      const epic = task ? ctx.docStore.getAllEpics().find(e => e.id === task.epicId) : undefined
      const initiative = epic ? ctx.docStore.getAllInitiatives().find(i => i.id === epic.initiativeId) : undefined
      const worktree = ctx.docStore.getAllWorktrees().find(w => w.id === run.worktreeId)

      const sessDir = ctx.sessionConfig?.dirs.sessions ?? ''
      const session = getSession(sessDir, sessionId)
      const workspacePath = session?.workspace?.path
      const absoluteFilePath = (() => {
        if (!filePath.startsWith('/')) return workspacePath ? resolve(workspacePath, filePath) : filePath
        if (existsSync(filePath)) return filePath
        return workspacePath ? resolve(workspacePath, filePath.replace(/^\/+/, '')) : filePath
      })()

      if (workspacePath && !absoluteFilePath.startsWith(workspacePath + '/')) {
        fail(res, 'PATH_OUTSIDE_WORKSPACE', 'filePath must be inside the session workspace')
        return
      }

      let naturalWidth = 640
      let naturalHeight = 480
      try {
        const buf = readFileSync(absoluteFilePath)
        const dims = imageSize(buf)
        naturalWidth = dims.width ?? 640
        naturalHeight = dims.height ?? 480
      } catch {
        // unsupported format or corrupt — use fallback
      }

      const widget: ImageWidget = {
        id: shortId('image'),
        spaceId: ctx.docStore.activeSpaceId || undefined,
        sessionId,
        filePath: absoluteFilePath,
        task: task?.name ?? '',
        epic: epic?.name ?? '',
        initiative: initiative?.name ?? '',
        worktree: worktree?.name ?? '',
        repo: worktree?.repo ?? run.repo ?? '',
        color: run.color,
        naturalWidth,
        naturalHeight,
      }
      ctx.docStore.upsertImageWidget(widget.id, widget)
      ok(res, widget)
      } catch {
        fail(res, 'BAD_REQUEST', 'Invalid request body')
      }
    })
    return true
  }

  // DELETE /api/image-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/image-widgets/')) {
    const id = url.slice('/api/image-widgets/'.length)
    const existing = ctx.docStore.getAllImageWidgets().find(w => w.id === id)
    if (!existing) {
      fail(res, 'NOT_FOUND', `ImageWidget ${id} not found`)
      return true
    }
    ctx.docStore.deleteImageWidget(id)
    ok(res, null)
    return true
  }

  // GET /api/image-file?session=SESSION_ID&path=FILE_PATH
  if (method === 'GET' && url.startsWith('/api/image-file')) {
    const qs = new URL(url, 'http://localhost').searchParams
    const sessionId = qs.get('session')
    const filePath = qs.get('path')

    if (!sessionId || !filePath) {
      fail(res, 'BAD_REQUEST', 'session and path required')
      return true
    }

    let absolutePath: string
    if (filePath.startsWith('/') && existsSync(filePath)) {
      absolutePath = filePath
    } else {
      const sessDir = ctx.sessionConfig?.dirs.sessions
      if (!sessDir) { fail(res, 'CONFIG_UNAVAILABLE', 'session config unavailable'); return true }
      const session = getSession(sessDir, sessionId)
      if (!session) { fail(res, 'SESSION_NOT_FOUND', 'session not found'); return true }
      const workspacePath = session.workspace?.path ?? null
      if (!workspacePath) { fail(res, 'BAD_REQUEST', 'session workspace unavailable'); return true }
      absolutePath = filePath.startsWith('/')
        ? resolve(workspacePath, filePath.replace(/^\/+/, ''))
        : resolve(workspacePath, filePath)
      if (!absolutePath.startsWith(workspacePath + '/')) {
        fail(res, 'PATH_OUTSIDE_WORKSPACE', 'path outside workspace')
        return true
      }
    }

    if (!existsSync(absolutePath)) {
      fail(res, 'NOT_FOUND', 'file not found')
      return true
    }

    const ext = absolutePath.split('.').pop()?.toLowerCase() ?? ''
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      bmp: 'image/bmp', ico: 'image/x-icon',
    }
    const contentType = mimeMap[ext] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    const stream = createReadStream(absolutePath)
    req.on('close', () => stream.destroy())
    stream.pipe(res)
    return true
  }

  // POST /api/nats-traffic/bounce — stop+start the NATS observer connection
  // and re-establish all widget subscriptions. Used by the Saloon refresh
  // button. Safe: does not touch session control sockets or running agents.
  if (method === 'POST' && url === '/api/nats-traffic/bounce') {
    readBody(req).then(async () => {
      try {
        await bounceNatsTraffic(ctx.natsTraffic)
        ok(res, null)
      } catch (err) {
        const e = err as { code?: string; message?: string }
        // Map the NATS bridge's BRIDGE_UNAVAILABLE through; otherwise classify as INTERNAL.
        if (e.code === 'BRIDGE_UNAVAILABLE') {
          fail(res, 'BRIDGE_UNAVAILABLE', e.message ?? String(err))
        } else {
          fail(res, 'INTERNAL', e.message ?? String(err))
        }
      }
    })
    return true
  }

  // POST /api/file-content/git-base — return the HEAD-committed version of a file
  if (method === 'POST' && url === '/api/file-content/git-base') {
    const execFileAsync = promisify(execFile)
    readBody(req).then(async body => {
      try {
        const { sessionId, filePath } = JSON.parse(body) as { sessionId?: string; filePath?: string }
        if (!sessionId || !filePath) { fail(res, 'BAD_REQUEST', 'sessionId and filePath required'); return }

        const sessDir = ctx.sessionConfig?.dirs.sessions
        if (!sessDir) { fail(res, 'CONFIG_UNAVAILABLE', 'session config unavailable'); return }
        const session = getSession(sessDir, sessionId)
        if (!session) { fail(res, 'SESSION_NOT_FOUND', 'session not found'); return }
        const workspacePath = session.workspace?.path ?? null
        if (!workspacePath) { fail(res, 'BAD_REQUEST', 'session workspace unavailable'); return }

        const absolutePath = filePath.startsWith('/')
          ? filePath
          : resolve(workspacePath, filePath)
        if (!absolutePath.startsWith(workspacePath + '/')) {
          fail(res, 'PATH_OUTSIDE_WORKSPACE', 'path outside workspace'); return
        }
        const relPath = relative(workspacePath, absolutePath)

        const { stdout } = await execFileAsync(
          'git', ['show', `HEAD:${relPath}`],
          { cwd: workspacePath, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024, timeout: 5000 },
        )
        ok(res, { content: stdout })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('does not exist') || msg.includes('bad revision')) {
          ok(res, { content: null })
        } else {
          fail(res, 'LIST_FAILED', 'failed to read git base', { details: { detail: msg } })
        }
      }
    })
    return true
  }

  // POST /api/file-watch/subscribe — subscribe to file changes via the main SSE
  if (method === 'POST' && url === '/api/file-watch/subscribe') {
    readBody(req).then(body => {
      try {
        const { sessionId, filePath, subscriberId, mode } = JSON.parse(body) as {
          sessionId?: string; filePath?: string; subscriberId?: string; mode?: 'content' | 'notify'
        }
        if (!sessionId || !filePath || !subscriberId) {
          fail(res, 'BAD_REQUEST', 'sessionId, filePath, and subscriberId required')
          return
        }

        let absolutePath: string
        if (filePath.startsWith('/') && existsSync(filePath)) {
          absolutePath = filePath
        } else {
          const sessDir = ctx.sessionConfig?.dirs.sessions
          if (!sessDir) { fail(res, 'CONFIG_UNAVAILABLE', 'session config unavailable'); return }
          const session = getSession(sessDir, sessionId)
          if (!session) { fail(res, 'SESSION_NOT_FOUND', 'session not found'); return }
          const workspacePath = session.workspace?.path ?? null
          if (!workspacePath) { fail(res, 'BAD_REQUEST', 'session workspace unavailable'); return }
          absolutePath = filePath.startsWith('/')
            ? resolve(workspacePath, filePath.replace(/^\/+/, ''))
            : resolve(workspacePath, filePath)
          if (!absolutePath.startsWith(workspacePath + '/')) {
            fail(res, 'PATH_OUTSIDE_WORKSPACE', 'path outside workspace')
            return
          }
        }

        addFileWatchSubscriber(absolutePath, subscriberId, mode ?? 'notify', ctx.sse)

        // For content mode, read and return initial file contents in the response
        // to avoid a race between the HTTP response (which sets absolutePath)
        // and a separate SSE broadcast (which the client would ignore if
        // absolutePath isn't set yet).
        if ((mode ?? 'notify') === 'content' && existsSync(absolutePath)) {
          readFile(absolutePath, 'utf-8').then(content => {
            ok(res, { absolutePath, content })
          }).catch(() => {
            ok(res, { absolutePath })
          })
        } else {
          ok(res, { absolutePath })
        }
      } catch {
        fail(res, 'BAD_REQUEST', 'invalid request body')
      }
    })
    return true
  }

  // POST /api/file-watch/unsubscribe
  if (method === 'POST' && url === '/api/file-watch/unsubscribe') {
    readBody(req).then(body => {
      try {
        const { absolutePath, subscriberId } = JSON.parse(body) as {
          absolutePath?: string; subscriberId?: string
        }
        if (!absolutePath || !subscriberId) {
          fail(res, 'BAD_REQUEST', 'absolutePath and subscriberId required')
          return
        }
        removeFileWatchSubscriber(absolutePath, subscriberId)
        ok(res, null)
      } catch {
        fail(res, 'BAD_REQUEST', 'invalid request body')
      }
    })
    return true
  }

  // --- Browser widget header-injection proxy ---
  // /api/proxy/{widgetId}/... → proxied to widget's target origin with injected headers
  if (url.startsWith('/api/proxy/')) {
    const afterProxy = url.slice('/api/proxy/'.length)
    const slashIdx = afterProxy.indexOf('/')
    const widgetId = slashIdx === -1 ? afterProxy.split('?')[0]! : afterProxy.slice(0, slashIdx)
    const proxyPath = slashIdx === -1 ? '/' : afterProxy.slice(slashIdx)

    const widget = ctx.docStore.getAllBrowserWidgets().find(w => w.id === widgetId)
    if (!widget) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Browser widget not found')
      return true
    }

    let origin: string
    try { origin = new URL(widget.url).origin } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Invalid widget URL')
      return true
    }

    const target = new URL(proxyPath, origin)
    const fwdHeaders: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host }
    // Request uncompressed so we can rewrite text responses
    delete fwdHeaders['accept-encoding']
    // Inject custom headers
    if (widget.headers) {
      for (const [k, v] of Object.entries(widget.headers)) fwdHeaders[k.toLowerCase()] = v
    }

    const proxyBase = `/api/proxy/${widgetId}`

    const proxyReq = httpRequest(
      { hostname: target.hostname, port: target.port || undefined, path: target.pathname + target.search, method: req.method, headers: fwdHeaders },
      proxyRes => {
        const ct = (proxyRes.headers['content-type'] || '').toLowerCase()
        const isRewritable = ct.includes('text/') || ct.includes('javascript') || ct.includes('json')

        if (!isRewritable) {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
          proxyRes.pipe(res)
          return
        }

        // Buffer text responses and rewrite root-relative paths to route through proxy
        const chunks: Buffer[] = []
        proxyRes.on('data', (c: Buffer) => chunks.push(c))
        proxyRes.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf-8')
          // Rewrite quoted root-relative paths: "/foo" → "/api/proxy/{id}/foo"
          // Skip protocol-relative "//..." URLs
          body = body.replace(/(["'])\/((?!\/)[^"']*)/g, `$1${proxyBase}/$2`)
          // Rewrite unquoted url() in CSS: url(/foo) → url(/api/proxy/{id}/foo)
          body = body.replace(/url\(\/((?!\/)[^)]*)\)/g, `url(${proxyBase}/$1)`)

          // Inject console-capture script into HTML so the widget can show a dev console
          if (ct.includes('text/html')) {
            const capture = `<script>(function(){` +
              `var W='${widgetId}',O={l:console.log,w:console.warn,e:console.error};` +
              `function s(l,a){try{var r=[];for(var i=0;i<a.length;i++){var v=a[i];` +
              `r.push(v instanceof Error?(v.stack||v.message):typeof v==='object'?` +
              `(function(){try{return JSON.stringify(v)}catch(e){return String(v)}})():String(v))}` +
              `window.parent.postMessage({type:'bw-console',wid:W,lvl:l,args:r,ts:Date.now()},'*')}catch(e){}}` +
              `console.log=function(){s('log',arguments);O.l.apply(console,arguments)};` +
              `console.warn=function(){s('warn',arguments);O.w.apply(console,arguments)};` +
              `console.error=function(){s('error',arguments);O.e.apply(console,arguments)};` +
              `window.addEventListener('error',function(e){s('error',[e.message+' at '+e.filename+':'+e.lineno+':'+e.colno])});` +
              `window.addEventListener('unhandledrejection',function(e){s('error',['Unhandled rejection: '+(e.reason&&(e.reason.stack||e.reason))])})` +
              `})()</script>`
            const headMatch = body.match(/<head[^>]*>/i)
            if (headMatch) body = body.replace(headMatch[0], headMatch[0] + capture)
            else body = capture + body
          }

          const headers: Record<string, string | string[] | undefined> = { ...proxyRes.headers }
          delete headers['content-encoding']
          delete headers['transfer-encoding']
          headers['content-length'] = String(Buffer.byteLength(body))

          res.writeHead(proxyRes.statusCode ?? 502, headers)
          res.end(body)
        })
      },
    )
    proxyReq.on('error', (err) => {
      log.warn('proxy', `browser widget proxy error: ${err.message}`)
      if (!res.headersSent) {
        const hint = err.message.includes('ECONNREFUSED')
          ? `Nothing is listening on ${target.host}. Is the server running?`
          : err.message
        res.writeHead(502, { 'Content-Type': 'text/html' })
        res.end(`<!DOCTYPE html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:#94a3b8;font-family:ui-monospace,monospace;font-size:13px;text-align:center;padding:2rem"><div><div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">⚠</div><div style="color:#e2e8f0;margin-bottom:0.5rem">Cannot reach <code style="color:#f59e0b">${target.host}</code></div><div style="opacity:0.6;max-width:400px">${hint}</div></div></body></html>`)
      }
    })
    req.pipe(proxyReq)
    return true
  }

  // POST /api/browser-widgets
  if (method === 'POST' && url === '/api/browser-widgets') {
    readBody(req).then(body => {
      const parsed = JSON.parse(body) as {
        sessionId?: string; url?: string; headers?: Record<string, string>; spaceId?: string;
        color?: string;
        position?: { x: number; y: number }; size?: { width: number; height: number };
        nearNodeId?: string; slot?: number | string;
      }
      const { sessionId, url: widgetUrl = '', headers: widgetHeaders, color: colorOverride } = parsed
      const run = sessionId ? ctx.docStore.getAllRuns().find(r => r.sessionId === sessionId) : undefined
      if (sessionId && !run) {
        fail(res, 'SESSION_NOT_FOUND', `No run with sessionId ${sessionId}`)
        return
      }
      const widgetColor = colorOverride ?? run?.color ?? '#5b6b7a'
      const spaceId = parsed.spaceId || ctx.docStore.activeSpaceId || ''
      const placement = resolvePlacement(ctx, spaceId, parsed)
      const widget: import('../../domain/types').BrowserWidget = {
        id: shortId('browser'),
        spaceId: spaceId || undefined,
        ...(sessionId ? { sessionId } : {}),
        url: widgetUrl,
        color: widgetColor,
        ...(widgetHeaders && Object.keys(widgetHeaders).length > 0 ? { headers: widgetHeaders } : {}),
        ...(placement ? { position: placement.position, size: placement.size } : {}),
      }
      ctx.docStore.upsertBrowserWidget(widget.id, widget)
      const slot = toSlot(parsed.slot)
      if (slot && spaceId) assignWidgetToSlot(ctx, spaceId, widget.id, slot)
      ok(res, widget)
    })
    return true
  }

  // PATCH /api/browser-widgets/:id
  if (method === 'PATCH' && url.startsWith('/api/browser-widgets/')) {
    const id = url.slice('/api/browser-widgets/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getAllBrowserWidgets().find(w => w.id === id)
      if (!existing) {
        fail(res, 'NOT_FOUND', `BrowserWidget ${id} not found`)
        return
      }
      const patch = JSON.parse(body) as {
        url?: string; title?: string; headers?: Record<string, string>;
        position?: { x: number; y: number }; size?: { width: number; height: number };
        nearNodeId?: string; slot?: number | string;
      }
      const spaceId = existing.spaceId || ctx.docStore.activeSpaceId || ''
      const placement = resolvePlacement(ctx, spaceId, patch)
      const { position: _p, size: _s, nearNodeId: _n, slot: _sl, ...rest } = patch
      const updated = {
        ...existing,
        ...rest,
        ...(placement ? { position: placement.position, size: placement.size } : {}),
      }
      ctx.docStore.upsertBrowserWidget(id, updated)
      const slot = toSlot(patch.slot)
      if (slot && spaceId) assignWidgetToSlot(ctx, spaceId, id, slot)
      ok(res, updated)
    })
    return true
  }

  // DELETE /api/browser-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/browser-widgets/')) {
    const id = url.slice('/api/browser-widgets/'.length)
    const existing = ctx.docStore.getAllBrowserWidgets().find(w => w.id === id)
    if (!existing) {
      fail(res, 'NOT_FOUND', `BrowserWidget ${id} not found`)
      return true
    }
    ctx.docStore.deleteBrowserWidget(id)
    ok(res, null)
    return true
  }

  // POST /api/plugin-widgets
  if (method === 'POST' && url === '/api/plugin-widgets') {
    readBody(req).then(body => {
      const parsed = JSON.parse(body) as {
        pluginId?: string; widgetType?: string; spaceId?: string;
        position?: { x: number; y: number };
        size?: { width: number; height: number };
        data?: unknown;
      }
      const { pluginId, widgetType, spaceId, position, size, data } = parsed

      if (!pluginId || !widgetType || !spaceId || !position || !size) {
        fail(res, 'INVALID_PARAMS', 'pluginId, widgetType, spaceId, position, size all required')
        return
      }

      const configRoot = ctx.sessionConfig?.dirs.root
      if (!configRoot) {
        fail(res, 'CONFIG_UNAVAILABLE', 'configRoot unavailable')
        return
      }
      const registry = resolveWidgetRegistry(configRoot)
      const reg = registry.find(r => r.pluginId === pluginId && r.widgetType === widgetType)
      if (!reg) {
        fail(res, 'CONFLICT', `unknown_widget_type: ${pluginId}/${widgetType}`)
        return
      }

      if (!ctx.docStore.getAllSpaces().some(s => s.id === spaceId)) {
        fail(res, 'NOT_FOUND', `unknown_space: ${spaceId}`)
        return
      }

      if (data !== undefined) {
        let serialized: string
        try { serialized = JSON.stringify(data) }
        catch { fail(res, 'BAD_REQUEST', 'bad_data: not JSON-serializable'); return }
        if (serialized.length > 65536) {
          fail(res, 'BAD_REQUEST', 'data_too_large: serialized data exceeds 64KB', { status: 413 })
          return
        }
      }

      if (reg.singleton) {
        const existing = ctx.docStore.getAllPluginWidgets().find(
          p => p.pluginId === pluginId && p.widgetType === widgetType && p.spaceId === spaceId,
        )
        if (existing) {
          fail(res, 'CONFLICT', `singleton_violation: existing instance id=${existing.id}`)
          return
        }
      }

      const now = new Date().toISOString()
      const instance: PluginWidgetInstance = {
        id: shortId('pw'),
        pluginId,
        widgetType,
        spaceId,
        position,
        size,
        data: data ?? null,
        createdAt: now,
        updatedAt: now,
      }
      ctx.docStore.upsertPluginWidget(instance.id, instance)
      ok(res, instance)
    })
    return true
  }

  // PATCH /api/plugin-widgets/:id
  if (method === 'PATCH' && url.startsWith('/api/plugin-widgets/')) {
    const id = url.slice('/api/plugin-widgets/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getAllPluginWidgets().find(p => p.id === id)
      if (!existing) {
        fail(res, 'NOT_FOUND', `PluginWidget ${id} not found`)
        return
      }
      const patch = JSON.parse(body) as {
        position?: { x: number; y: number };
        size?: { width: number; height: number };
        data?: unknown;
        attention?: { level: string; reason: string } | null;
      }

      // Size cap on the proposed data
      if ('data' in patch) {
        let serialized: string
        try { serialized = JSON.stringify(patch.data) }
        catch { fail(res, 'BAD_REQUEST', 'bad_data: not JSON-serializable'); return }
        if (serialized.length > 65536) {
          fail(res, 'BAD_REQUEST', 'data_too_large: serialized data exceeds 64KB', { status: 413 })
          return
        }
      }

      // Attention handling — validate and apply, then strip from the path the data-update takes.
      let attentionApplied = false
      if ('attention' in patch) {
        const attn = patch.attention
        if (attn === null) {
          ctx.docStore.setPluginWidgetAttention(id, null)
          attentionApplied = true
        } else if (
          attn && typeof attn === 'object'
          && (attn.level === 'urgent' || attn.level === 'attention' || attn.level === 'info')
          && typeof attn.reason === 'string'
        ) {
          ctx.docStore.setPluginWidgetAttention(id, {
            level: attn.level,
            reason: attn.reason.slice(0, 200),
            setAt: new Date().toISOString(),
          })
          attentionApplied = true
        } else {
          fail(res, 'BAD_REQUEST', 'invalid_attention: shape must be { level: urgent|attention|info, reason: string } or null')
          return
        }
      }

      const baseline = attentionApplied
        ? ctx.docStore.getAllPluginWidgets().find(p => p.id === id)!
        : existing

      const updated: PluginWidgetInstance = {
        ...baseline,
        ...(patch.position ? { position: patch.position } : {}),
        ...(patch.size ? { size: patch.size } : {}),
        ...('data' in patch ? { data: patch.data } : {}),
        updatedAt: new Date().toISOString(),
      }
      ctx.docStore.upsertPluginWidget(id, updated)
      ok(res, updated)
    })
    return true
  }

  // DELETE /api/plugin-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/plugin-widgets/')) {
    const id = url.slice('/api/plugin-widgets/'.length)
    const existing = ctx.docStore.getAllPluginWidgets().find(p => p.id === id)
    if (!existing) {
      fail(res, 'NOT_FOUND', `PluginWidget ${id} not found`)
      return true
    }
    ctx.docStore.deletePluginWidget(id)
    ok(res, null)
    return true
  }

  // PUT /api/constellation-graph/:spaceId — replace a space's membership graph (whole-doc, atomic)
  if (method === 'PUT' && url.startsWith('/api/constellation-graph/')) {
    const spaceId = decodeURIComponent(url.slice('/api/constellation-graph/'.length))
    readBody(req).then(body => {
      const graph = JSON.parse(body) as import('../../domain/constellationGraph').ConstellationGraph
      ctx.docStore.upsertConstellationGraph(spaceId, { ...graph, spaceId })
      ok(res, { ok: true })
    }).catch(() => fail(res, 'BAD_REQUEST', 'Invalid JSON'))
    return true
  }

  // GET /api/plugin-widgets/registry — palette UI lists available widget types
  if (method === 'GET' && url === '/api/plugin-widgets/registry') {
    const configRoot = ctx.sessionConfig?.dirs.root
    if (!configRoot) {
      ok(res, [])
      return true
    }
    ok(res, resolveWidgetRegistry(configRoot))
    return true
  }

  // GET /api/plugin-widgets and /api/plugin-widgets?spaceId=...
  if (method === 'GET' && (url === '/api/plugin-widgets' || url.startsWith('/api/plugin-widgets?'))) {
    const parsedUrl = new URL(url, 'http://placeholder')
    const spaceId = parsedUrl.searchParams.get('spaceId')
    const all = ctx.docStore.getAllPluginWidgets()
    const filtered = spaceId ? all.filter(p => p.spaceId === spaceId) : all
    ok(res, filtered)
    return true
  }

  // NOTE: GET /api/file-watch SSE endpoint removed — file watching now goes
  // through POST /api/file-watch/subscribe and the main SSE connection.

  // PATCH /api/runs/:id
  if (method === 'PATCH' && url.startsWith('/api/runs/')) {
    const id = url.slice('/api/runs/'.length)
    readBody(req).then(async body => {
      const existing = ctx.docStore.getRun(id)
      if (!existing) return fail(res, 'NOT_FOUND', 'not found')
      const patch = JSON.parse(body) as {
        taskId?: string
        attention?: { level: string; reason: string } | null
        [key: string]: unknown
      }
      const { attention: attentionPatch, ...patchWithoutAttention } = patch

      // Attention handling mirrors plugin widgets so clearing a run does not
      // leave a lingering null payload in the stored run state.
      let attentionApplied = false
      if ('attention' in patch) {
        const attn = attentionPatch
        if (attn === null) {
          ctx.docStore.setRunAttention(id, null)
          attentionApplied = true
        } else if (
          attn && typeof attn === 'object'
          && (attn.level === 'urgent' || attn.level === 'attention' || attn.level === 'info')
          && typeof attn.reason === 'string'
        ) {
          ctx.docStore.setRunAttention(id, {
            level: attn.level,
            reason: attn.reason.slice(0, 200),
            setAt: new Date().toISOString(),
          })
          attentionApplied = true
        } else {
          return fail(res, 'BAD_REQUEST', 'invalid_attention: shape must be { level: urgent|attention|info, reason: string } or null')
        }
      }

      // Check if taskId changed and NATS is enabled — need to update subscriptions
      const taskIdChanged = patchWithoutAttention.taskId !== undefined && patchWithoutAttention.taskId !== existing.taskId
      const sessDir = ctx.sessionConfig?.dirs.sessions
      if (taskIdChanged && existing.natsEnabled && sessDir) {
        const session = getSession(sessDir, existing.sessionId)
        if (session?.nats?.enabled) {
          // Compute old and new subscriptions
          const oldSubs = session.nats.subscriptions || []
          const newSubs = computeNatsSubscriptions({
            sessionName: existing.sessionId,
            spaceId: existing.spaceId,
            taskId: patchWithoutAttention.taskId,
          }, ctx.docStore)

          const { add, remove } = diffSubscriptions(oldSubs, newSubs)

          // Send socket commands to update channel server. Persisted state is
          // the source of truth: we always update the session file below so the
          // new subscriptions apply on next startup. Any socket failures are
          // collected into natsWarnings and returned to the caller so the UI
          // can surface that the hot-apply did not land.
          const natsWarnings: NatsSocketWarning[] = []
          for (const subject of remove) {
            const w = await trySendNatsSocketCommand(existing.sessionId, { action: 'unsubscribe', subject })
            if (w) natsWarnings.push(w)
          }
          for (const subject of add) {
            const w = await trySendNatsSocketCommand(existing.sessionId, { action: 'subscribe', subject })
            if (w) natsWarnings.push(w)
          }

          // Update session file with new subscriptions
          updateSession(sessDir, existing.sessionId, { nats: { ...session.nats, subscriptions: newSubs } })

          // Update run's natsSubject and full subscription list
          patchWithoutAttention.natsSubject = newSubs[1] ?? newSubs[0]
          patchWithoutAttention.natsSubscriptions = newSubs
          log.info('nats', `${existing.sessionId}: subscriptions updated for new task ${patchWithoutAttention.taskId}`)

          // Mirror the new subscription list into the traffic bridge so the
          // Saloon window-event stream stays aligned.
          registerSaloonSubs(ctx.natsTraffic, existing.sessionId, newSubs)

          if (natsWarnings.length > 0) {
            const baseline = attentionApplied ? ctx.docStore.getRun(id)! : existing
            ctx.docStore.upsertRun(id, { ...baseline, ...patchWithoutAttention })
            return ok(res, ctx.docStore.getRun(id), { warnings: { nats: natsWarnings } })
          }
        }
      }

      const baseline = attentionApplied ? ctx.docStore.getRun(id)! : existing
      ctx.docStore.upsertRun(id, { ...baseline, ...patchWithoutAttention })
      ok(res, ctx.docStore.getRun(id))
    })
    return true
  }

  // --- Session management routes (only active when sessionConfig is set) ---

  if (ctx.sessionConfig) {
    const cfg = ctx.sessionConfig
    const sessDir = cfg.dirs.sessions
    const secrets = () => loadSecrets(cfg.dirs.secrets)
    const dashboardUrl = `http://localhost:${process.env.TINSTAR_DASHBOARD_PORT ?? 5273}`

    function emitSessionEvent<T extends BusEventType>(type: T, payload: PayloadFor<T>): void {
      ctx.bus.emit({ type, timestamp: new Date().toISOString(), payload } as BusEvent)
    }

    // Helper to extract :name from URL patterns like /api/sessions/foo or /api/sessions/foo/start
    function extractSessionName(urlPath: string, prefix: string): string | null {
      const rest = urlPath.slice(prefix.length)
      const slash = rest.indexOf('/')
      return slash === -1 ? rest : rest.slice(0, slash)
    }

    // GET /api/sessions
    if (method === 'GET' && url === '/api/sessions') {
      reconcileSessionStates(sessDir, {
        getTmuxSessionState: (name) => tmuxBackend.getTmuxSessionState(cfg, name),
        onStateChanged: (name, state) => {
          emitSessionEvent('managed_session.state_changed', { name, state })
        },
      }).then(sessions => ok(res, sessions))
        .catch(err => fail(res, 'LIST_FAILED', (err as Error).message))
      return true
    }

    // GET /api/sessions/:name (exact match, no trailing path)
    if (method === 'GET' && url.startsWith('/api/sessions/') && !url.includes('/start') && !url.includes('/stop') && !url.includes('/files') && !url.includes('/context') && !url.includes('/nats-status')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session) {
          fail(res, 'SESSION_NOT_FOUND', `Session '${name}' not found`)
        } else {
          ok(res, session)
        }
        return true
      }
    }

    // GET /api/sessions/:name/files?path=<relative-dir>
    if (method === 'GET' && url.startsWith('/api/sessions/') && url.includes('/files')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session?.workspace?.path) {
          fail(res, 'CONFLICT', 'Session has no workspace')
          return true
        }
        const wsRoot = session.workspace.path
        const params = new URL(url, 'http://localhost').searchParams
        const relPath = params.get('path') || '.'
        const absPath = join(wsRoot, relPath)

        // Safety: ensure we don't escape the workspace
        if (!absPath.startsWith(wsRoot)) {
          fail(res, 'PATH_OUTSIDE_WORKSPACE', 'Path escapes workspace')
          return true
        }

        try {
          const entries = readdirSync(absPath, { withFileTypes: true })
            .filter(e => e.name !== 'node_modules' && e.name !== '.git')
            .map(e => ({
              name: e.name,
              path: relative(wsRoot, join(absPath, e.name)),
              isDir: e.isDirectory(),
            }))
            .sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
              return a.name.localeCompare(b.name)
            })
          ok(res, entries)
        } catch (err) {
          fail(res, 'INTERNAL', (err as Error).message)
        }
        return true
      }
    }

    // GET /api/sessions/:name/context-window — live % from latest statusline push
    if (method === 'GET' && url.startsWith('/api/sessions/') && url.endsWith('/context-window')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session) {
          fail(res, 'SESSION_NOT_FOUND', `Session '${name}' not found`)
          return true
        }
        const convId = session.conversation?.id
        const snap = convId && ctx.ccQuotaService ? ctx.ccQuotaService.getSessionContext(convId) : null
        ok(res, snap)
        return true
      }
    }

    // GET /api/sessions/:name/context
    if (method === 'GET' && url.startsWith('/api/sessions/') && url.endsWith('/context')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session) {
          fail(res, 'SESSION_NOT_FOUND', `Session '${name}' not found`)
          return true
        }
        if (!session.conversation?.id) {
          fail(res, 'CONFLICT', 'Session has no active conversation')
          return true
        }
        getDetailedUsage(session.conversation.id)
          .then(data => ok(res, data))
          .catch(err => {
            log.error('api', `context fetch failed for ${name}: ${(err as Error).message}`)
            fail(res, 'INTERNAL', (err as Error).message)
          })
        return true
      }
    }

    // POST /api/sessions
    if (method === 'POST' && url === '/api/sessions') {
      readBody(req).then(async (body) => {
        const { name, project, worktree = false, worktreePath, prompt, skipPermissions = true, cliTemplate: cliTemplateName, taskId, epicId, initiativeId, color: colorParam, nats, hand: handName } = JSON.parse(body)
        log.info('sessions', `creating session: ${name}`, { project, worktree, cliTemplate: cliTemplateName, taskId, epicId, initiativeId, color: colorParam })

        // Resolve a named hand here so the HTTP layer keeps ownership of the
        // not-found response. The resolved CLI template + persona prompt are
        // handed to the shared createSessionInternal, which does the rest of
        // the work (worktree, color, NATS subscriptions, run projection, …).
        let resolvedHand: ReturnType<typeof getHandByName> = null
        if (handName) {
          resolvedHand = getHandByName(handName)
          if (!resolvedHand) return fail(res, 'NOT_FOUND', `Hand '${handName}' not found`)
        }

        const createCtx = buildCreateSessionContext(ctx)
        if (!createCtx) return fail(res, 'INTERNAL', 'sessionConfig unavailable')

        try {
          const result = await createSessionInternal({
            name, project, worktree, worktreePath, prompt, skipPermissions,
            cliTemplate: cliTemplateName ?? resolvedHand?.cliTemplate,
            taskId, epicId, initiativeId, color: colorParam, nats,
            appendSystemPrompt: resolvedHand?.prompt ?? null,
          }, createCtx)

          if (!result.ok) {
            switch (result.error.code) {
              case 'MISSING_NAME': return fail(res, 'BAD_REQUEST', result.error.message)
              case 'SESSION_EXISTS': return fail(res, 'CONFLICT', result.error.message)
              case 'PROJECT_NOT_FOUND': return fail(res, 'NOT_FOUND', result.error.message)
              default: return fail(res, 'INTERNAL', result.error.message)
            }
          }
          ok(res, result.session, { status: 201 })
        } catch (err) {
          log.error('sessions', `session creation failed: ${name}`, { error: (err as Error).message })
          fail(res, 'INTERNAL', (err as Error).message)
        }
      })
      return true
    }

    // POST /api/tasks/:taskId/sessions — create a session inside a task with
    // automatic settings inheritance. Resolves the task's project (and any
    // other inheritable fields) from the entity hierarchy so the caller only
    // has to supply the session name. Designed for the marshal and other
    // automation that wants one-call session creation in task context.
    //
    // Body: { name, ...overrides } where overrides may include any field
    // that POST /api/sessions accepts (cliTemplate, backend, prompt, nats,
    // color, etc). Explicit overrides win over resolved task settings.
    {
      const taskSessionsMatch = method === 'POST' && url.match(/^\/api\/tasks\/([^/]+)\/sessions$/)
      if (taskSessionsMatch) {
        const taskId = taskSessionsMatch[1]!
        readBody(req).then(async (body) => {
          const overrides = body ? JSON.parse(body) : {}
          if (!overrides.name) {
            return fail(res, 'BAD_REQUEST', 'Session name is required')
          }

          const task = ctx.docStore.getTask(taskId)
          if (!task) return fail(res, 'NOT_FOUND', `Task '${taskId}' not found`)

          const settings = resolveEntitySettings(taskId, 'task', ctx.docStore)
          const resolvedProject = settings?.resolved?.project

          const params: CreateSessionParams = {
            nats: { enabled: true },
            ...overrides,
            project: overrides.project ?? resolvedProject,
            taskId,
            epicId: overrides.epicId ?? task.epicId,
            initiativeId: overrides.initiativeId ?? task.initiativeId,
          }

          const createCtx: CreateSessionContext = {
            cfg, sessDir,
            docStore: ctx.docStore,
            readyQueue: ctx.readyQueue,
            sse: ctx.sse,
            emitSessionEvent,
            secrets,
            dashboardUrl,
            natsTraffic: ctx.natsTraffic,
            natsHealth: ctx.natsHealth,
          }

          const result = await createSessionInternal(params, createCtx)
          if (!result.ok) {
            // createSessionInternal returns its own error codes; map the ones we know to envelope codes,
            // everything else collapses to INTERNAL with the original message.
            if (result.error.code === 'SESSION_EXISTS') return fail(res, 'CONFLICT', result.error.message)
            return fail(res, 'INTERNAL', result.error.message)
          }
          ok(res, result.session, { status: 201 })
        }).catch(err => fail(res, 'INTERNAL', (err as Error).message))
        return true
      }
    }

    // POST /api/sessions/:name/stop
    if (method === 'POST' && url.endsWith('/stop') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        readBody(req).then(async () => {
          const session = getSession(sessDir, name)
          if (!session) return fail(res, 'SESSION_NOT_FOUND', `Session '${name}' not found`)

          try {
            await tmuxBackend.stopTmuxSession(cfg, session)
            if (session.port) tmuxBackend.releasePort(session.port)

            // Clear port/ttydPid so a later start re-allocates a fresh port via
            // findPort(). Leaving stale values here causes the proxy /s/{name}
            // to route to whichever ttyd later wins port 8703, and lets two
            // managed-ttyd auto-restart handlers war over the same port.
            updateSession(sessDir, session.name, { port: null, ttydPid: null })
            const run = ctx.docStore.getRun(session.name)
            if (run) ctx.docStore.upsertRun(session.name, { ...run, port: null })

            setState(sessDir, session.name, 'stopped')
            ctx.docStore.updateRunStatus(session.name, 'stopped')
            emitSessionEvent('managed_session.state_changed', { name: session.name, state: 'stopped' })
            ok(res, getSession(sessDir, session.name))
          } catch (err) {
            fail(res, 'INTERNAL', (err as Error).message)
          }
        })
        return true
      }
    }

    // POST /api/sessions/:name/start
    if (method === 'POST' && url.endsWith('/start') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        readBody(req).then(async () => {
          const session = getSession(sessDir, name)
          if (!session) return fail(res, 'SESSION_NOT_FOUND', `Session '${name}' not found`)

          // Verify workspace directory still exists
          const wsPath = session.workspace?.path
          if (wsPath && !existsSync(wsPath)) {
            return fail(res, 'CONFLICT', `Workspace directory no longer exists: ${wsPath}`)
          }

          // Require a conversation ID to resume — sessions created before this change won't have one
          if (!session.conversation?.id) {
            return fail(res, 'BAD_REQUEST', `Session '${name}' has no conversation ID. Delete and recreate it.`)
          }

          try {
            const sec = secrets()

            const port = session.port ?? await tmuxBackend.findPort(cfg.ports.hostStart)
            const resumeTemplate = session.cliTemplate
              ? cfg.cliTemplates.find(t => t.name === session.cliTemplate) ?? null
              : null
            const result = await tmuxBackend.startTmuxSession(cfg, { session, secrets: sec, port, template: resumeTemplate })
            updateSession(sessDir, session.name, { port: result.port, ttydPid: result.ttydPid ?? null })
            tmuxBackend.onTtydRestart(session.name, (newPid) => {
              updateSession(sessDir, session.name, { ttydPid: newPid })
            })

            // Re-read session to get updated port
            const updated = getSession(sessDir, session.name)
            const resumePort = updated?.port ?? session.port
            setState(sessDir, session.name, 'running')
            // Fresh channel-server → any prior orphan is stale.
            updateSession(sessDir, session.name, { natsControlOrphanedAt: null })
            {
              const run = ctx.docStore.getRun(session.name)
              if (run) ctx.docStore.upsertRun(session.name, { ...run, natsControlOrphanedAt: null })
            }
            ctx.docStore.updateRunStatus(session.name, 'running')
            // Also update port on the run in case it changed
            if (resumePort) {
              const run = ctx.docStore.getRun(session.name)
              if (run && run.port !== resumePort) {
                ctx.docStore.upsertRun(session.name, { ...run, port: resumePort })
              }
            }
            emitSessionEvent('managed_session.state_changed', { name: session.name, state: 'running' })
            ok(res, updated)
          } catch (err) {
            fail(res, 'INTERNAL', (err as Error).message)
          }
        })
        return true
      }
    }

    // DELETE /api/sessions/:name
    if (method === 'DELETE' && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)

        // Mark the session dir as mid-deletion so a server restart doesn't rehydrate it
        try { writeFileSync(join(sessDir, name, '.deleting'), '') } catch { /* dir may already be gone */ }

        // Respond immediately — UI removal is instant
        ctx.docStore.deleteRun(name)
        unregisterSaloonSubs(ctx.natsTraffic, name)
        ctx.natsHealth?.untrackSession(name)
        emitSessionEvent('managed_session.deleted', { name })
        ctx.readyQueue.onDelete(name)
        ctx.sse.setReadyQueue(ctx.readyQueue.getQueue())
        ctx.sse.broadcastReadyQueueUpdate()
        ok(res, null)

        // Cleanup: stop backend first (releases bind mounts), then remove session dir
        ;(async () => {
          try {
            if (session) {
              // Best-effort delete-durable for every NATS subject this session
              // owned. Must run BEFORE backend stop — channel-server's control
              // socket disappears when the process dies. Failures here are
              // benign: channel-server's InactiveThreshold reaps any leftover,
              // but we log warnings so visible leaks aren't silent.
              if (session.nats?.enabled && cfg.nats.jetstream) {
                const run = ctx.docStore.getRun(name)
                const subjects = new Set<string>([
                  ...(session.nats.subscriptions ?? []),
                  ...(run?.breakoutRooms ?? []),
                ])
                const results = await Promise.allSettled(
                  [...subjects].map(subject =>
                    trySendNatsSocketCommand(name, { action: 'delete-durable', subject })
                  ),
                )
                for (const r of results) {
                  if (r.status === 'fulfilled' && r.value) {
                    log.warn('delete', `nats cleanup left durable orphaned for ${name}: ${r.value.code} ${r.value.subject}`)
                  }
                }
              }

              await tmuxBackend.deleteTmuxSession(cfg, session)
              if (session.port) tmuxBackend.releasePort(session.port)


            }
          } catch (err) {
            log.warn('delete', `background cleanup for ${name}: ${(err as Error).message}`)
          }

          // Remove session dir AFTER backend cleanup (bind mounts released)
          if (!deleteSession(sessDir, name)) {
            log.warn('delete', `failed to remove session dir for ${name}, retrying...`)
            setTimeout(() => deleteSession(sessDir, name), 2000)
          }
        })()

        return true
      }
    }

    // GET /api/config — read the full user config (defaults + on-disk, deep-merged)
    if (method === 'GET' && url === '/api/config') {
      try {
        const data = loadConfigMerged(ctx.sessionConfig?.dirs.root)
        ok(res, data)
      } catch (err) {
        log.warn('config', `GET /api/config failed: ${(err as Error).message}`)
        fail(res, 'INTERNAL', 'failed to load config')
      }
      return true
    }

    // PATCH /api/config — deep-merge keys into user config and persist
    if (method === 'PATCH' && url === '/api/config') {
      readBody(req).then((body) => {
        let patch: Record<string, unknown>
        try { patch = JSON.parse(body) } catch {
          return fail(res, 'BAD_REQUEST', 'invalid JSON')
        }
        // Validate uploadMaxBytes if present
        if ('uploadMaxBytes' in patch) {
          const v = patch.uploadMaxBytes
          if (!Number.isInteger(v) || (v as number) < 1024 * 1024) {
            return fail(res, 'INVALID_PARAMS', 'uploadMaxBytes must be an integer >= 1 MB')
          }
        }
        let data: Record<string, unknown> = {}
        try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no existing config */ }
        const merged = deepMerge(data, patch)
        writeFileSync(cfg.files.config, JSON.stringify(merged, null, 2))
        ok(res, loadConfigMerged(ctx.sessionConfig?.dirs.root))
      })
      return true
    }

    // POST /api/editor/open — open a file in the configured editor
    if (method === 'POST' && url === '/api/editor/open') {
      readBody(req).then((body) => {
        const { path: filePath, sessionId } = JSON.parse(body)
        if (!filePath) return fail(res, 'BAD_REQUEST', 'path is required')

        // Resolve relative paths against the session's workspace directory
        let resolvedPath = filePath
        if (sessionId && !filePath.startsWith('/')) {
          const session = getSession(sessDir, sessionId)
          if (session?.workspace?.path) {
            resolvedPath = join(session.workspace.path, filePath)
          }
        }

        // Read editor command fresh from config file (survives server restarts)
        let editorCmd = cfg.editor
        try {
          const raw = JSON.parse(readFileSync(cfg.files.config, 'utf-8'))
          if (typeof raw.editor === 'string') editorCmd = raw.editor
        } catch { /* use default */ }

        const cmd = editorCmd.replace(/\{\{path\}\}/g, resolvedPath)
        const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [cmd]
        const [bin, ...args] = parts.map(p => p.replace(/^["']|["']$/g, ''))

        log.info('editor', `opening: ${bin} ${args.join(' ')}`)

        // Resolve the latest VS Code / Cursor IPC socket so the CLI can
        // connect even if the server was started before the current editor.
        const env = { ...process.env }
        try {
          const socks = readdirSync('/run/user/1000')
            .filter(f => f.startsWith('vscode-ipc-') && f.endsWith('.sock'))
            .map(f => ({ name: f, mtime: statSync(`/run/user/1000/${f}`).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
          if (socks.length > 0) {
            env.VSCODE_IPC_HOOK_CLI = `/run/user/1000/${socks[0]!.name}`
          }
        } catch { /* non-Linux or no sockets — use inherited env */ }

        // Discover Remote-SSH `code` binaries (VS Code / Cursor / Windsurf install
        // them under ~/.<flavor>-server/bin/<arch>/<commit>/bin/remote-cli/). The
        // systemd unit's PATH doesn't include these dirs, so spawn would ENOENT.
        const home = process.env.HOME
        if (home) {
          const cliDirs: { dir: string; mtime: number }[] = []
          for (const flavor of ['.vscode-server', '.cursor-server', '.windsurf-server']) {
            const base = `${home}/${flavor}/bin`
            try {
              for (const arch of readdirSync(base)) {
                const archDir = `${base}/${arch}`
                try {
                  for (const commit of readdirSync(archDir)) {
                    const cli = `${archDir}/${commit}/bin/remote-cli`
                    try {
                      const st = statSync(`${cli}/code`)
                      cliDirs.push({ dir: cli, mtime: st.mtimeMs })
                    } catch { /* no code binary in this install */ }
                  }
                } catch { /* unreadable arch dir */ }
              }
            } catch { /* flavor not installed */ }
          }
          if (cliDirs.length > 0) {
            cliDirs.sort((a, b) => b.mtime - a.mtime)
            env.PATH = `${cliDirs[0]!.dir}:${env.PATH ?? ''}`
          }
        }

        import('node:child_process').then(({ spawn }) => {
          const child = spawn(bin!, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env })
          child.stderr?.on('data', (d: Buffer) => log.warn('editor', `stderr: ${d.toString().trim()}`))
          child.on('error', (err) => log.error('editor', `spawn error: ${err.message}`))
          child.on('exit', (code) => { if (code) log.warn('editor', `exited with code ${code}`) })
          child.unref()
          ok(res, null)
        })
      })
      return true
    }

    // POST /api/sessions/:name/spawn — spawn a companion hand on the same task
    if (method === 'POST' && url.startsWith('/api/sessions/') && url.endsWith('/spawn')) {
      const parentName = extractSessionName(url, '/api/sessions/')?.replace('/spawn', '')
      if (!parentName) return fail(res, 'BAD_REQUEST', 'Session name required')

      const parentSession = getSession(sessDir, parentName)
      if (!parentSession) return fail(res, 'NOT_FOUND', `Session '${parentName}' not found`)

      const body = await readBody(req)
      const { hand: handName, prompt: promptOverride, orchestrator, repo: repoOverride, worktreePath: worktreePathOverride } = JSON.parse(body) as {
        hand: string
        prompt?: string
        orchestrator?: boolean
        repo?: string          // Override parent's project/repo
        worktreePath?: string  // Override parent's worktree path
      }

      if (!handName) {
        return fail(res, 'BAD_REQUEST', 'hand field is required')
      }

      const hand = getHandByName(handName)
      if (!hand) {
        return fail(res, 'NOT_FOUND', `Hand '${handName}' not found`)
      }

      // Generate unique session name
      const spawnedName = `${parentName}-${handName}-${randomUUID().slice(0, 8)}`

      // Build the prompt: hand base + optional override
      let fullPrompt = hand.prompt
      if (promptOverride) {
        fullPrompt = `${hand.prompt}\n\n---\n\n${promptOverride}`
      }

      // Resolve the parent's run to get taskId for NATS subject computation
      const parentRun = ctx.docStore.getAllRuns().find(r => r.sessionId === parentName)
      const taskId = parentRun?.taskId

      // Inherit workspace from parent session, unless overridden
      const workspace = worktreePathOverride
        ? { path: worktreePathOverride, worktree: true, branch: null, basePath: null }
        : parentSession.workspace

      // Build NATS subscriptions for the spawned session
      // Inherit NATS from parent regardless of taskId — use whatever hierarchy is available
      let natsConfig: { enabled: boolean; subscriptions: string[] } | null = null
      if (parentSession.nats?.enabled) {
        const natsCtx = {
          sessionName: spawnedName,
          spaceId: ctx.docStore.activeSpaceId || null,
          taskId: taskId || null,
          epicId: parentRun?.epic || null,
          initiativeId: parentRun?.initiative || null,
        }
        const subscriptions = computeNatsSubscriptions(natsCtx, ctx.docStore)
        natsConfig = { enabled: true, subscriptions }
      }

      // Generate a breakout room for parent-child communication
      const breakoutRoom = natsConfig?.enabled
        ? `${BREAKOUT_PREFIX}${randomUUID().slice(0, 8)}`
        : undefined

      // Pre-flight: subscribe parent to the breakout room BEFORE we start the
      // child, so the child's system prompt can point at a subject the parent
      // actually hears. If the parent's control socket is unreachable/orphaned
      // (common symptom of an upstream MCP-restart collision — see the
      // NATS_SOCKET_ORPHANED docs on classifyNatsSocketError), fall back to
      // the parent's persistent direct subject, which was subscribed at the
      // parent's startup and is still live.
      const parentDirectSubject = natsConfig?.enabled
        ? buildNatsSubject(
            parentName,
            ctx.docStore,
            parentRun?.taskId,
            parentRun?.epic || undefined,
            parentRun?.initiative || undefined,
          )
        : undefined

      let breakoutWarning: NatsSocketWarning | null = null
      let effectiveRoom = breakoutRoom
      let breakoutFallback = false
      if (breakoutRoom) {
        breakoutWarning = await trySendNatsSocketCommand(parentName, {
          action: 'subscribe',
          subject: breakoutRoom,
        })
        if (breakoutWarning) {
          // Parent can't receive on the new subject. Use the parent's
          // persistent direct subject instead — it's been subscribed since
          // parent startup and is unaffected by the control-socket orphan.
          effectiveRoom = parentDirectSubject
          breakoutFallback = true
          if (breakoutWarning.code === 'NATS_SOCKET_ORPHANED') {
            // Record orphan state on the session record so the dashboard can
            // surface it. Clear it on next successful session restart.
            const orphanedAt = new Date().toISOString()
            updateSession(sessDir, parentName, { natsControlOrphanedAt: orphanedAt })
            {
              const run = ctx.docStore.getRun(parentName)
              if (run) ctx.docStore.upsertRun(parentName, { ...run, natsControlOrphanedAt: orphanedAt })
            }
            emitSessionEvent('managed_session.nats_orphaned', {
              name: parentName,
              orphanedAt,
              reason: breakoutWarning.code,
              restartRecommended: true,
            })
          }
        }
      }

      // Add the effective room (breakout or fallback) to child's subscriptions
      // so it can address the parent. Skip if fallback — the parent's direct
      // subject is already covered by the child-end NATS hierarchy as an
      // ancestor wildcard when the child's nats subscriptions are computed.
      if (breakoutRoom && !breakoutFallback && natsConfig) {
        natsConfig.subscriptions.push(breakoutRoom)
      }

      // Resolve CLI template from hand definition
      const cliTemplate = hand.cliTemplate

      // Resolve effective repo (override or inherit)
      const effectiveRepo = repoOverride ?? parentSession.project

      // Create the spawned session
      const spawnedSession = createSession(sessDir, {
        name: spawnedName,
        backend: 'tmux',
        project: effectiveRepo,
        workspace: {
          path: workspace?.path ?? null,
          worktree: workspace?.worktree ?? false,
          branch: workspace?.branch ?? null,
          basePath: workspace?.basePath ?? null,
        },
        profile: parentSession.profile,
        skipPermissions: parentSession.skipPermissions,
        cliTemplate: cliTemplate ?? null,
        adapter: parentSession.adapter,
        nats: natsConfig,
      })

      emitSessionEvent('managed_session.created', { name: spawnedSession.name, state: spawnedSession.state })

      // Start the session with the combined prompt
      const enriched = spawnedSession as Session & { _stateDir?: string; initialPrompt?: string }
      enriched._stateDir = claudeStateDir(sessDir, spawnedName)
      const sec = secrets()

      const resolvedTemplate = cliTemplate
        ? cfg.cliTemplates.find(t => t.name === cliTemplate) ?? null
        : null

      try {
        const port = await tmuxBackend.findPort(cfg.ports.hostStart)
        if (fullPrompt) enriched.initialPrompt = fullPrompt

        // Build hand system prompt pointing at the effective parent-child
        // room. When fallback kicked in (parent's control socket was orphan/
        // unreachable), effectiveRoom is the parent's persistent direct
        // subject rather than the fresh breakout room.
        const handSystemPrompt = hand.prompt
          ? effectiveRoom
            ? `${hand.prompt}\n\n## Your Parent\n\nYou were spawned by **${parentName}**.\nTalk to your parent on: \`${effectiveRoom}\`\n\nYour FIRST action must be to introduce yourself to your parent:\n\`\`\`\nreply(to="${effectiveRoom}", text="${handName} online. <your one-line capability>. Ready.")\n\`\`\``
            : `${hand.prompt}\n\n## Your Parent\n\nYou were spawned by **${parentName}**.`
          : null

        const result = await tmuxBackend.createTmuxSession(cfg, { session: enriched, secrets: sec, port, template: resolvedTemplate, appendSystemPrompt: handSystemPrompt })
        const sessionPort = result.port
        updateSession(sessDir, spawnedName, { port: sessionPort, ttydPid: result.ttydPid ?? null, state: 'running' })
        tmuxBackend.onTtydRestart(spawnedName, (newPid) => {
          updateSession(sessDir, spawnedName, { ttydPid: newPid })
        })

        emitSessionEvent('managed_session.state_changed', { name: spawnedName, state: 'running' })

        // NOTE: the hot-subscribe to the breakout room happens BEFORE child
        // creation now, so we can fall back to the parent's persistent direct
        // subject when the parent's control socket is orphaned. See above.

        // Build NATS subject for the run
        const natsSubject = natsConfig?.enabled
          ? buildNatsSubject(spawnedName, ctx.docStore, taskId, parentRun?.epic || undefined, parentRun?.initiative || undefined)
          : undefined

        // Create a run entity linked to the same task and worktree as the parent (unless overridden)
        const runId = spawnedName
        ctx.docStore.upsertRun(runId, {
          id: runId,
          color: parentRun?.color,
          status: 'running',
          sessionId: spawnedName,
          initiative: parentRun?.initiative ?? '',
          epic: parentRun?.epic ?? '',
          task: taskId ?? '',
          repo: effectiveRepo ?? '',
          worktree: worktreePathOverride ?? parentRun?.worktree ?? '',
          touchedFiles: [],
          recapEntries: [],
          rawLogs: '',
          port: sessionPort ?? null,
          backend: 'tmux',
          backendInfo: `tmux session: ${spawnedName}`,
          natsEnabled: natsConfig?.enabled ?? false,
          natsSubject,
          natsSubscriptions: natsConfig?.enabled ? natsConfig.subscriptions : undefined,
          natsControlOrphanedAt: spawnedSession.natsControlOrphanedAt ?? null,
          // Only record the breakout room if it was actually live (parent is
          // subscribed to it). On fallback, the child uses the parent's
          // direct subject so there's no separate room to track.
          breakoutRooms: breakoutRoom && !breakoutFallback ? [breakoutRoom] : undefined,
          taskId: taskId ?? '',
          worktreeId: worktreePathOverride ? '' : (parentRun?.worktreeId ?? ''),  // Clear if using custom worktree
          createdAt: new Date().toISOString(),
          spaceId: ctx.docStore.activeSpaceId,
          parentId: parentRun?.id,  // Track who spawned this hand
        })

        // Mirror the child's subscription list into the traffic bridge so the
        // Saloon window-event stream sees messages on its breakout room.
        registerSaloonSubs(ctx.natsTraffic, spawnedName, natsConfig?.enabled ? natsConfig.subscriptions : [])
        bootstrapHierarchicalTopicMetadata(natsConfig?.subscriptions ?? [], spawnedName, ctx.docStore)
        if (natsConfig?.enabled) ctx.natsHealth?.trackSession(spawnedName)

        // Add breakout room to parent's run record — but only if the parent
        // is actually subscribed to it. On fallback, there's no live room.
        // upsertRun is a full replacement, so spread the existing run first.
        if (breakoutRoom && !breakoutFallback && parentRun) {
          const parentRooms = parentRun.breakoutRooms ?? []
          ctx.docStore.upsertRun(parentRun.id, {
            ...parentRun,
            breakoutRooms: [...parentRooms, breakoutRoom],
          })
        }

        // Persist the breakout subscription on the parent's session record so
        // it survives stop/resume. The hot socket-subscribe above only lives
        // in the running channel-server's memory; on resume we regenerate
        // .mcp.json from session.nats.subscriptions, so without this the
        // resumed parent goes deaf on every breakout room it was in.
        if (breakoutRoom && !breakoutFallback) {
          const latest = getSession(sessDir, parentName)
          if (latest?.nats?.enabled) {
            const existing = latest.nats.subscriptions ?? []
            if (!existing.includes(breakoutRoom)) {
              const nextSubs = [...existing, breakoutRoom]
              updateSession(sessDir, parentName, {
                nats: {
                  ...latest.nats,
                  subscriptions: nextSubs,
                },
              })
              // Mirror the parent's expanded subscription list into the traffic bridge.
              registerSaloonSubs(ctx.natsTraffic, parentName, nextSubs)
            }
          }
          if (!ctx.docStore.getTopicMetadata(breakoutRoom)) {
            ctx.docStore.upsertTopicMetadata(breakoutRoom, {
              subject: breakoutRoom,
              name: `${handName} with ${parentName}`,
              kind: 'breakout',
              createdAt: new Date().toISOString(),
              createdBy: parentName,
            })
          }
        }

        return ok(res, {
          session: spawnedName,
          hand: handName,
          parentSession: parentName,
          orchestrator: orchestrator ?? false,
          // `room` is the subject the child was actually told to use. When
          // the breakout subscribe failed and we fell back, this is the
          // parent's persistent direct subject rather than a fresh room.
          room: effectiveRoom ?? null,
          // `breakoutRoom` is what we would have used if the parent's
          // control socket were healthy. Kept for observability.
          breakoutRoom: breakoutRoom ?? null,
          breakoutFallback,
          ...(breakoutFallback
            ? {
                fallbackReason: breakoutWarning?.code ?? 'NATS_SOCKET_ERROR',
                restartRecommended: breakoutWarning?.restartRecommended ?? false,
              }
            : {}),
          natsWarning: breakoutWarning ?? undefined,
        }, { status: 201 })
      } catch (err) {
        // Clean up on failure
        deleteSession(sessDir, spawnedName)
        return fail(res, 'INTERNAL', (err as Error).message)
      }
      return true
    }

    // POST /api/sessions/:name/send-keys — send raw tmux keys to a session
    if (method === 'POST' && url.endsWith('/send-keys') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const body = JSON.parse(await readBody(req))
        const keys: string[] = body.keys
        if (!Array.isArray(keys) || keys.length === 0) {
          fail(res, 'BAD_REQUEST', 'keys must be a non-empty array of strings')
          return true
        }
        const session = getSession(sessDir, name)
        if (!session) { fail(res, 'NOT_FOUND', 'Session not found'); return true }
        try {
          await tmuxBackend.sendKeys(cfg, name, keys)
          ok(res, null)
        } catch (err) {
          fail(res, 'INTERNAL', (err as Error).message)
        }
        return true
      }
    }

    // POST /api/sessions/:name/enter-prompt — type text then submit with Enter
    if (method === 'POST' && url.endsWith('/enter-prompt') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const body = JSON.parse(await readBody(req))
        const prompt: string = body.prompt
        if (!prompt || typeof prompt !== 'string') {
          fail(res, 'BAD_REQUEST', 'prompt must be a non-empty string')
          return true
        }
        const session = getSession(sessDir, name)
        if (!session) { fail(res, 'NOT_FOUND', 'Session not found'); return true }
        try {
          await tmuxBackend.sendPrompt(cfg, name, prompt)
          ok(res, null)
        } catch (err) {
          fail(res, 'INTERNAL', (err as Error).message)
        }
        return true
      }
    }

    // GET /api/sessions/:name/nats-status — observed NATS truth, probed live
    // from the channel-server control socket: the actual connection state plus
    // the subjects it's actually subscribed to. This is the SSOT the Saloon
    // dot/topics read — independent of session.nats config, CLI flags, or which
    // .mcp.json is on disk. Cheap (one socket round-trip); safe to call on
    // panel-open and on dot-click. A session with no live channel-server
    // resolves to { connection: 'down' } — that's the truth, not an error.
    if (method === 'GET' && url.endsWith('/nats-status') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const status = await probeNatsLiveStatus(natsControlSocketPath(name))
        ok(res, status)
        return true
      }
    }

    // GET /api/sessions/:name/subscriptions — list NATS subscriptions for a session
    if (method === 'GET' && url.endsWith('/subscriptions') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session) { fail(res, 'NOT_FOUND', 'Session not found'); return true }
        ok(res, { subscriptions: session.nats?.subscriptions ?? [] })
        return true
      }
    }

    // POST /api/sessions/:name/subscriptions — add a NATS subscription
    if (method === 'POST' && url.endsWith('/subscriptions') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        readBody(req).then(async (body) => {
          const { subject } = JSON.parse(body)
          if (!subject || typeof subject !== 'string') {
            return fail(res, 'BAD_REQUEST', 'subject must be a non-empty string')
          }
          const session = getSession(sessDir, name)
          if (!session) { return fail(res, 'NOT_FOUND', 'Session not found') }
          if (!session.nats?.enabled) { return fail(res, 'BRIDGE_UNAVAILABLE', 'NATS is not enabled for this session') }

          // Add to subscriptions if not already present
          const subs = session.nats.subscriptions
          let natsWarning: NatsSocketWarning | null = null
          if (!subs.includes(subject)) {
            subs.push(subject)
            updateSession(sessDir, name, { nats: { ...session.nats, subscriptions: subs } })

            // Send to channel server via Unix socket. Persisted state is
            // the source of truth (already written above); if the socket
            // hot-apply fails we surface it in the response instead of
            // silently logging so callers can show the error.
            natsWarning = await trySendNatsSocketCommand(name, { action: 'subscribe', subject })

            // Keep the run's natsSubscriptions in sync
            const run = ctx.docStore.getRun(name)
            if (run) ctx.docStore.upsertRun(name, { ...run, natsSubscriptions: subs })

            // Mirror the updated subscription list into the traffic bridge.
            registerSaloonSubs(ctx.natsTraffic, name, subs)
          }
          ok(res, { subscriptions: subs }, natsWarning ? { warnings: { nats: [natsWarning] } } : undefined)
        }).catch(() => fail(res, 'BAD_REQUEST', 'Invalid JSON'))
        return true
      }
    }

    // DELETE /api/sessions/:name/subscriptions — remove a NATS subscription
    if (method === 'DELETE' && url.endsWith('/subscriptions') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        readBody(req).then(async (body) => {
          const { subject } = JSON.parse(body)
          if (!subject || typeof subject !== 'string') {
            return fail(res, 'BAD_REQUEST', 'subject must be a non-empty string')
          }
          const session = getSession(sessDir, name)
          if (!session) { return fail(res, 'NOT_FOUND', 'Session not found') }
          if (!session.nats?.enabled) { return fail(res, 'BRIDGE_UNAVAILABLE', 'NATS is not enabled for this session') }

          // Remove from subscriptions
          const subs = session.nats.subscriptions.filter(s => s !== subject)
          updateSession(sessDir, name, { nats: { ...session.nats, subscriptions: subs } })

          // Send to channel server via Unix socket. See POST sibling for
          // the rationale on surfacing warnings instead of swallowing them.
          const natsWarning = await trySendNatsSocketCommand(name, { action: 'unsubscribe', subject })

          // Keep the run's natsSubscriptions in sync
          const run = ctx.docStore.getRun(name)
          if (run) ctx.docStore.upsertRun(name, { ...run, natsSubscriptions: subs })

          // Mirror the updated subscription list into the traffic bridge.
          registerSaloonSubs(ctx.natsTraffic, name, subs)

          ok(res, { subscriptions: subs }, natsWarning ? { warnings: { nats: [natsWarning] } } : undefined)
        }).catch(() => fail(res, 'BAD_REQUEST', 'Invalid JSON'))
        return true
      }
    }

    // GET /api/cli-templates — configured CLI templates for agent backends
    if (method === 'GET' && url === '/api/cli-templates') {
      ok(res, cfg.cliTemplates)
      return true
    }

    // POST /api/cli-templates — add or update a CLI template
    if (method === 'POST' && url === '/api/cli-templates') {
      readBody(req).then((body) => {
        const { name, icon, adapter, telemetry, startCmd, resumeCmd } = JSON.parse(body)
        if (!name || !startCmd || !resumeCmd) return fail(res, 'BAD_REQUEST', 'name, startCmd, and resumeCmd are required')

        let data: Record<string, unknown> = {}
        try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no config */ }
        const templates: Array<{ name: string; icon?: string; adapter?: string; telemetry?: boolean; startCmd: string; resumeCmd: string }> = Array.isArray(data.cliTemplates) ? data.cliTemplates : []
        const entry = { name, startCmd, resumeCmd, ...(icon ? { icon } : {}), ...(adapter ? { adapter } : {}), ...(telemetry === false ? { telemetry: false } : {}) }
        const idx = templates.findIndex(t => t.name === name)
        if (idx >= 0) templates[idx] = entry
        else templates.push(entry)
        data.cliTemplates = templates
        writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
        ok(res, entry)
      }).catch(() => fail(res, 'BAD_REQUEST', 'Invalid JSON'))
      return true
    }

    // PUT /api/cli-templates/:name — update a CLI template (supports renaming)
    if (method === 'PUT' && url.startsWith('/api/cli-templates/')) {
      const oldName = decodeURIComponent(url.slice('/api/cli-templates/'.length))
      readBody(req).then((body) => {
        const { name, icon, adapter, telemetry, startCmd, resumeCmd } = JSON.parse(body)
        if (!name || !startCmd || !resumeCmd) return fail(res, 'BAD_REQUEST', 'name, startCmd, and resumeCmd are required')

        // Check if template exists in merged config (includes defaults)
        const existsInMerged = cfg.cliTemplates.some(t => t.name === oldName)
        if (!existsInMerged) return fail(res, 'NOT_FOUND', `Template "${oldName}" not found`)

        let data: Record<string, unknown> = {}
        try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no config */ }
        const templates: Array<{ name: string; icon?: string; adapter?: string; telemetry?: boolean; startCmd: string; resumeCmd: string }> = Array.isArray(data.cliTemplates) ? data.cliTemplates : []
        const entry = { name, startCmd, resumeCmd, ...(icon ? { icon } : {}), ...(adapter ? { adapter } : {}), ...(telemetry === false ? { telemetry: false } : {}) }
        const idx = templates.findIndex(t => t.name === oldName)
        if (idx >= 0) {
          templates[idx] = entry
        } else {
          // Template exists as a default — add override to user config
          templates.push(entry)
        }
        data.cliTemplates = templates
        writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
        ok(res, entry)
      }).catch(() => fail(res, 'BAD_REQUEST', 'Invalid JSON'))
      return true
    }

    // DELETE /api/cli-templates/:name — remove a CLI template
    if (method === 'DELETE' && url.startsWith('/api/cli-templates/')) {
      const name = decodeURIComponent(url.slice('/api/cli-templates/'.length))
      let data: Record<string, unknown> = {}
      try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no config */ }
      const templates: Array<{ name: string }> = Array.isArray(data.cliTemplates) ? data.cliTemplates : []
      const idx = templates.findIndex(t => t.name === name)
      if (idx === -1) return fail(res, 'NOT_FOUND', `Template "${name}" not found`), true
      templates.splice(idx, 1)
      data.cliTemplates = templates
      writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
      ok(res, null)
      return true
    }

    // GET /api/hands
    if (method === 'GET' && url === '/api/hands') {
      const hands = discoverHands()
      const data = hands.map(h => ({
        name: h.name,
        description: h.description,
        cliTemplate: h.cliTemplate,
      }))
      return ok(res, data)
    }

    // GET /api/hands/:name — get full hand definition including prompt
    const handsMatch = url.match(/^\/api\/hands\/([^/]+)$/)
    if (method === 'GET' && handsMatch) {
      const handName = decodeURIComponent(handsMatch[1]!)
      const hand = getHandByName(handName)
      if (!hand) {
        return fail(res, 'NOT_FOUND', `Hand '${handName}' not found`)
      }
      return ok(res, hand)
    }

    // --- Projects ---

    // GET /api/projects
    if (method === 'GET' && url === '/api/projects') {
      ok(res, listProjects(cfg.files.projects))
      return true
    }

    // POST /api/projects
    if (method === 'POST' && url === '/api/projects') {
      readBody(req).then((body) => {
        const { name, path } = JSON.parse(body)
        if (!name || !path) return fail(res, 'BAD_REQUEST', 'Name and path required')
        registerProject(cfg.files.projects, name, path)
        ctx.sse.broadcastEvent('projects_changed', { action: 'register', name })
        ok(res, null, { status: 201 })
      })
      return true
    }

    // GET /api/projects/:name/worktrees
    if (method === 'GET' && url.includes('/worktrees') && url.startsWith('/api/projects/')) {
      const rest = url.slice('/api/projects/'.length)
      const rawName = rest.split('/')[0]
      const name = rawName ? decodeURIComponent(rawName) : ''
      if (name) {
        const projectPath = getProject(cfg.files.projects, name)
        if (!projectPath) {
          fail(res, 'NOT_FOUND', `Project '${name}' not found`)
        } else {
          listWorktrees(projectPath)
            .then(wts => ok(res, wts))
            .catch(err => fail(res, 'LIST_FAILED', (err as Error).message))
        }
        return true
      }
    }

    // DELETE /api/projects/:name
    if (method === 'DELETE' && url.startsWith('/api/projects/')) {
      const rawName = url.slice('/api/projects/'.length)
      const name = decodeURIComponent(rawName)
      if (name) {
        const removed = unregisterProject(cfg.files.projects, name)
        if (!removed) {
          fail(res, 'NOT_FOUND', `Project '${name}' not found`)
        } else {
          ok(res, null)
        }
        return true
      }
    }

    // POST /api/sessions/:id/prompt
    const promptMatch = method === 'POST' && url.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
    if (promptMatch) {
      const sessionId = promptMatch[1]!
      const session = getSession(sessDir, sessionId)
      if (!session) {
        fail(res, 'SESSION_NOT_FOUND', `Session '${sessionId}' not found`)
        return true
      }
      readBody(req).then(async (body) => {
        const { text, force } = JSON.parse(body) as { text: string; force?: boolean }
        if (!force && session.state !== 'idle') {
          fail(res, 'CONFLICT', 'session-not-ready')
          return
        }
        if (!text) { fail(res, 'BAD_REQUEST', 'missing text'); return }
        try {
          await tmuxBackend.sendPrompt(cfg, sessionId, text)
          // Track slash usage (fire-and-forget; never blocks response).
          const slashName = extractLeadingSlashName(text)
          if (slashName) {
            ctx.slashUsage?.increment(slashName)
            ctx.otlpExporter?.pushMetric({
              name: 'tinstar_slash_use_total',
              type: 'counter',
              value: 1,
              labels: { name: slashName },
              timestamp: new Date().toISOString(),
            })
          }
          ok(res, null)
        } catch (err) {
          fail(res, 'INTERNAL', (err as Error).message)
        }
      })
      return true
    }

    // POST /api/marshal/ensure — return (and create on first call) the global marshal session.
    // The marshal is the user's persistent in-app copilot that lives in the canvas sidebar.
    if (method === 'POST' && url === '/api/marshal/ensure') {
      ensureMarshalSession(ctx)
        .then(result => result.ok
          ? ok(res, result.data)
          : fail(res, result.error.code === 'NO_CONFIG' ? 'CONFIG_UNAVAILABLE' : 'INTERNAL', result.error.message))
        .catch(err => fail(res, 'INTERNAL', (err as Error).message))
      return true
    }

    // POST /api/marshal/restart — tear down the existing marshal session and
    // create a fresh one. Used by the sidebar's restart button when the
    // marshal has crashed or wedged and refresh-iframe alone won't recover.
    if (method === 'POST' && url === '/api/marshal/restart') {
      restartMarshalSession(ctx)
        .then(result => result.ok
          ? ok(res, result.data)
          : fail(res, result.error.code === 'NO_CONFIG' ? 'CONFIG_UNAVAILABLE' : 'INTERNAL', result.error.message))
        .catch(err => fail(res, 'INTERNAL', (err as Error).message))
      return true
    }
  }

  // POST /api/canvas/viewport — push a viewport directive to all connected clients.
  // The frontend listens for the 'canvas:viewport' SSE event and updates the camera.
  // Used by the marshal to drive the user's view (and potentially other automation).
  if (method === 'POST' && url === '/api/canvas/viewport') {
    readBody(req).then(body => {
      let payload: Record<string, unknown>
      try { payload = JSON.parse(body) } catch {
        return fail(res, 'BAD_REQUEST', 'Invalid JSON')
      }
      const action = payload.action
      if (action !== 'set' && action !== 'focus' && action !== 'reset' && action !== 'fit') {
        return fail(res, 'INVALID_PARAMS', "action must be one of: set, focus, reset, fit")
      }
      ctx.sse.broadcastEvent('canvas:viewport', { ...payload, ts: Date.now() })
      return ok(res, null)
    }).catch(err => fail(res, 'INTERNAL', (err as Error).message))
    return true
  }

  return false
}

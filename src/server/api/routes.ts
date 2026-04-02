import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { log } from '../logger'
import type { DocumentStore } from '../stores/document-store'
import type { OTelStore } from '../stores/otel-store'
import type { SSEBroadcaster } from './sse'
import type { EventBus } from '../event-bus'
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
  dockerBackend,
  tmuxBackend,
} from '../sessions'
import { resolveEntitySettings } from '../sessions/entity-settings'
import type { Run, EditorWidget, ImageWidget } from '../../domain/types'
import { saveActiveSpaceId } from '../sessions/config'
import { getSkills, bustSkillCache, parseFrontmatter } from '../sessions/skill-discovery'
import { saveDraft, discardDraft, DRAFTS_DIR, ensureDraftsDir } from '../sessions/skill-drafts'
import type { SkillDTO } from '../../types'
import { spec as openapiSpec } from './openapi'
import { ReadyQueue } from '../sessions/ReadyQueue'
import { buildCommitRecord, reconcileGitHistory } from '../commits'
import { shortId } from '../utils/shortId'
import { imageSize } from 'image-size'
import { computeNatsSubscriptions } from '../sessions/nats-subscriptions'

/** Build a hierarchical NATS subject for a session: tinstar.<space>.<init>.<epic>.<task>.<session> */
function buildNatsSubject(
  sessionName: string,
  docStore: DocumentStore,
  taskId?: string,
  epicId?: string,
  initiativeId?: string,
): string {
  const BLANK = '_'
  const sanitize = (s: string) => s.replace(/\s+/g, '-').replace(/[.>*]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()

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

  return `tinstar.${spaceName}.${initName}.${epicName}.${taskName}.${sanitize(sessionName)}`
}
import { discoverPatterns, getPatternByName, interpolateSessionConfig, buildOrchestrationPlan, type TemplateVars } from '../patterns'
import { discoverHands, getHandByName } from '../hands'

// ─── NATS socket communication ─────────────────────────────────────────

/**
 * Send a command to the channel server's Unix socket for hot subscription management.
 * The socket path is /tmp/tinstar-nats-<sessionName>.sock
 */
function sendNatsSocketCommand(sessionName: string, cmd: { action: 'subscribe' | 'unsubscribe'; subject: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socketPath = `/tmp/tinstar-nats-${sessionName}.sock`
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
  backend: 'docker' | 'tmux'
  project?: string
  worktree?: boolean
  worktreePath?: string
  profile?: string
  prompt?: string
  skipPermissions?: boolean
  cliTemplate?: string
  taskId?: string
  epicId?: string
  initiativeId?: string
  color?: string
  nats?: { enabled: boolean; subscriptions?: string[] }
}

interface CreateSessionContext {
  cfg: TinstarConfig
  sessDir: string
  docStore: DocumentStore
  readyQueue: ReadyQueue
  sse: SSEBroadcaster
  emitSessionEvent: (event: string, payload: Record<string, unknown>) => void
  secrets: () => Record<string, string>
  dashboardUrl: string
}

async function createSessionInternal(
  params: CreateSessionParams,
  ctx: CreateSessionContext
): Promise<{ ok: true; session: Session } | { ok: false; error: { code: string; message: string } }> {
  const {
    name, backend, project, worktree = false, worktreePath,
    profile, prompt, skipPermissions = true, cliTemplate: cliTemplateName,
    taskId, epicId, initiativeId, color: colorParam, nats
  } = params

  const { cfg, sessDir, docStore, readyQueue, sse, emitSessionEvent, secrets, dashboardUrl } = ctx

  if (!name) return { ok: false, error: { code: 'MISSING_NAME', message: 'Session name is required' } }
  if (!['docker', 'tmux'].includes(backend)) return { ok: false, error: { code: 'INVALID_BACKEND', message: 'Backend must be "docker" or "tmux"' } }

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
  let resolvedNats = nats ?? null
  const natsCtx = {
    sessionName: name,
    spaceId: docStore.activeSpaceId || null,
    taskId: taskId || null,
    epicId: epicId || null,
    initiativeId: initiativeId || null,
  }
  if (!nats && (taskId || epicId || initiativeId)) {
    resolvedNats = { enabled: true, subscriptions: computeNatsSubscriptions(natsCtx, docStore) }
  } else if (nats?.enabled && !nats.subscriptions) {
    resolvedNats = { enabled: true, subscriptions: computeNatsSubscriptions(natsCtx, docStore) }
  }

  const session = createSession(sessDir, {
    name,
    backend: resolvedTemplate ? 'tmux' : backend,
    project,
    workspace: {
      path: workspacePath,
      worktree: isWorktree,
      branch,
      basePath: isWorktree ? projectPath : null,
    },
    profile,
    // Note: oneshot intentionally not supported in createSessionInternal - pattern sessions are always persistent
    oneshot: false,
    skipPermissions,
    cliTemplate: cliTemplateName ?? null,
    adapter: resolvedTemplate?.adapter ?? null,
    nats: resolvedNats,
  })

  const enriched = session as Session & { _stateDir?: string; initialPrompt?: string }
  enriched._stateDir = claudeStateDir(sessDir, name)

  const sec = secrets()
  let sessionPort: number | undefined

  if (backend === 'docker') {
    sessionPort = await tmuxBackend.findPort(cfg.ports.hostStart)
    await dockerBackend.createContainer(cfg, { session: enriched, secrets: sec, port: sessionPort, dashboardUrl, initialPrompt: prompt || undefined })
    updateSession(sessDir, name, { port: sessionPort, state: 'running' })
  } else {
    const port = await tmuxBackend.findPort(cfg.ports.hostStart)
    if (prompt) enriched.initialPrompt = prompt

    const result = await tmuxBackend.createTmuxSession(cfg, { session: enriched, secrets: sec, port, template: resolvedTemplate })
    sessionPort = result.port
    updateSession(sessDir, name, { port: sessionPort, ttydPid: result.ttydPid ?? null, state: 'running' })
    tmuxBackend.onTtydRestart(name, (newPid) => {
      updateSession(sessDir, name, { ttydPid: newPid })
    })
  }

  // Create Run entry
  const runId = name
  const initialStatus = prompt ? 'running' : 'idle'
  let backendInfo: string | undefined
  if (backend === 'docker') {
    const container = dockerBackend.containerName(cfg, name)
    const imageProfile = profile ? cfg.profiles.find(p => p.name === profile) : undefined
    const image = imageProfile?.image ?? cfg.container.defaultImage
    backendInfo = `container: ${container}\nimage: ${image}`
  } else {
    backendInfo = `tmux session: ${name}`
  }

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
    backend,
    backendInfo,
    agentIcon: resolvedTemplate?.icon ?? undefined,
    natsEnabled: resolvedNats?.enabled ?? false,
    natsSubject,
    taskId: taskId ?? '',
    worktreeId: worktreeEntityId,
    createdAt: new Date().toISOString(),
    spaceId: docStore.activeSpaceId,
  })

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
  readinessTracker?: import('../sessions/readiness').SessionReadinessTracker
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  // Some routes respond asynchronously (e.g. readBody(...).then(...)).
  // If the client disconnects or another codepath already responded, avoid crashing
  // with ERR_HTTP_HEADERS_SENT.
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(data))
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

export async function handleRequest(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? ''
  const method = req.method ?? 'GET'

  // CORS preflight
  if (method === 'OPTIONS' && url.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return true
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

  // GET /api/state
  if (method === 'GET' && url === '/api/state') {
    // Include sessions from disk alongside document store snapshot
    const sessDir = ctx.sessionConfig?.dirs.sessions
    const sessions = sessDir ? await listSessions(sessDir) : []
    json(res, { ...ctx.docStore.snapshot(), sessions })
    return true
  }

  // GET /api/events (SSE)
  if (method === 'GET' && url === '/api/events') {
    ctx.sse.addClient(res)
    return true
  }

  // GET /api/otel/spans
  if (method === 'GET' && url.startsWith('/api/otel/spans')) {
    const parsed = new URL(url, 'http://localhost')
    const traceId = parsed.searchParams.get('traceId')
    const spans = traceId ? ctx.otelStore.getSpansByTrace(traceId) : ctx.otelStore.getAllSpans()
    json(res, spans)
    return true
  }

  // GET /api/otel/metrics
  if (method === 'GET' && url.startsWith('/api/otel/metrics')) {
    const parsed = new URL(url, 'http://localhost')
    const name = parsed.searchParams.get('name')
    const metrics = name ? ctx.otelStore.getMetricsByName(name) : ctx.otelStore.getAllMetrics()
    json(res, metrics)
    return true
  }

  // POST /api/simulator/start
  if (method === 'POST' && url === '/api/simulator/start') {
    ctx.startSimulator()
    json(res, { status: 'started' })
    return true
  }

  // POST /api/simulator/reset
  if (method === 'POST' && url === '/api/simulator/reset') {
    ctx.resetSimulator()
    json(res, { status: 'reset' })
    return true
  }

  // POST /api/simulator/patch-run — test-only: set any field on a run and broadcast delta
  if (method === 'POST' && url === '/api/simulator/patch-run') {
    const body = await readBody(req)
    const { id, ...patch } = JSON.parse(body) as { id: string } & Record<string, unknown>
    const run = ctx.docStore.getRun(id)
    if (!run) { json(res, { ok: false, error: 'run not found' }, 404); return true }
    const updated = { ...run, ...patch }
    ctx.docStore.upsertRun(id, updated)
    json(res, { ok: true })
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
        if (!ctx.sessionConfig) return json(res, { error: 'session config unavailable' }, 503)
        if (!payload.sha || !payload.message) return json(res, { error: 'invalid payload' }, 400)
        const record = buildCommitRecord(payload, 'hook', ctx.sessionConfig.git.taskMarkerRegex)
        const inserted = ctx.docStore.upsertCommit(record)
        json(res, { ok: true, inserted })
      } catch {
        json(res, { error: 'invalid json' }, 400)
      }
    })
    return true
  }

  // POST /api/git/reconcile
  if (method === 'POST' && url === '/api/git/reconcile') {
    if (!ctx.sessionConfig) {
      json(res, { error: 'session config unavailable' }, 503)
      return true
    }
    const result = reconcileGitHistory(ctx.docStore, ctx.sessionConfig)
    json(res, { ok: true, ...result })
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
    json(res, commits)
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
    json(res, { grouped, unassigned })
    return true
  }

  // POST /api/commit/:sha/assign-task
  if (method === 'POST' && /^\/api\/commit\/[^/]+\/assign-task$/.test(url)) {
    const sha = url.split('/')[3] ?? ''
    readBody(req).then(body => {
      try {
        const { taskTag } = JSON.parse(body) as { taskTag: string }
        if (!taskTag) return json(res, { error: 'taskTag is required' }, 400)
        const updated = ctx.docStore.assignTaskTag(sha, taskTag)
        if (!updated) return json(res, { error: 'not found' }, 404)
        json(res, { ok: true, commit: updated })
      } catch {
        json(res, { error: 'invalid json' }, 400)
      }
    })
    return true
  }

  // --- Spaces ---

  // GET /api/spaces
  if (method === 'GET' && url === '/api/spaces') {
    json(res, ctx.docStore.getAllSpaces())
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
      json(res, space, 201)
    })
    return true
  }

  // POST /api/spaces/:id/activate
  if (method === 'POST' && /^\/api\/spaces\/[^/]+\/activate$/.test(url)) {
    const id = url.split('/')[3]!
    const space = ctx.docStore.getSpace(id)
    if (!space) { json(res, { error: 'not found' }, 404); return true }
    ctx.docStore.activeSpaceId = id
    if (ctx.sessionConfig) {
      saveActiveSpaceId(ctx.sessionConfig.dirs.root, id)
    }
    ctx.sse.broadcastSnapshot()
    json(res, { ok: true, activeSpaceId: id })
    return true
  }

  // PATCH /api/spaces/:id
  if (method === 'PATCH' && url.startsWith('/api/spaces/') && !url.includes('/activate')) {
    const id = url.slice('/api/spaces/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getSpace(id)
      if (!existing) return json(res, { error: 'not found' }, 404)
      const patch = JSON.parse(body)

      // Validate labelConfig if present
      if (patch.labelConfig !== undefined) {
        const levels = patch.labelConfig?.levels
        if (!Array.isArray(levels) || levels.length < 1 || levels.length > 3) {
          return json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'labelConfig.levels must be an array of length 1–3' } }, 400)
        }
        for (const lvl of levels) {
          if (typeof lvl.label !== 'string' || !lvl.label.trim()) {
            return json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'Each level must have a non-empty label' } }, 400)
          }
          if (typeof lvl.icon !== 'string' || !lvl.icon.trim()) {
            return json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'Each level must have a non-empty icon' } }, 400)
          }
        }
      }

      ctx.docStore.upsertSpace(id, { ...existing, ...patch })
      json(res, { ok: true, data: ctx.docStore.getSpace(id) })
    })
    return true
  }

  // DELETE /api/spaces/:id
  if (method === 'DELETE' && url.startsWith('/api/spaces/') && !url.includes('/activate')) {
    const id = url.slice('/api/spaces/'.length)
    if (id === ctx.docStore.activeSpaceId) {
      json(res, { error: 'Cannot delete the active space. Switch to another space first.' }, 400)
      return true
    }
    if (ctx.docStore.getAllSpaces().length <= 1) {
      json(res, { error: 'Cannot delete the last space.' }, 400)
      return true
    }
    const orphanedRuns = ctx.docStore.getAllRuns().filter(r =>
      (r as Run).spaceId === id &&
      (r.status === 'running' || r.status === 'idle' || r.status === 'needs_attention')
    )
    ctx.docStore.clearSpace(id)
    ctx.docStore.deleteSpace(id)
    json(res, {
      ok: true,
      warning: orphanedRuns.length > 0
        ? `${orphanedRuns.length} session(s) are still running. Use \`tmux ls\` or \`docker ps\` to manage them.`
        : undefined,
    })
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
      json(res, entity, 201)
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
      json(res, entity, 201)
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

      json(res, entity, 201)
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
      json(res, entity, 201)
    })
    return true
  }

  // GET /api/initiatives/:id
  if (method === 'GET' && /^\/api\/initiatives\/[^/]+$/.test(url)) {
    const id = url.slice('/api/initiatives/'.length)
    const entity = ctx.docStore.getInitiative(id)
    if (!entity) { json(res, { error: 'not found' }, 404); return true }
    json(res, { ok: true, data: entity })
    return true
  }

  // GET /api/epics/:id
  if (method === 'GET' && /^\/api\/epics\/[^/]+$/.test(url)) {
    const id = url.slice('/api/epics/'.length)
    const entity = ctx.docStore.getEpic(id)
    if (!entity) { json(res, { error: 'not found' }, 404); return true }
    json(res, { ok: true, data: entity })
    return true
  }

  // GET /api/tasks/:id
  if (method === 'GET' && /^\/api\/tasks\/[^/]+$/.test(url)) {
    const id = url.slice('/api/tasks/'.length)
    const entity = ctx.docStore.getTask(id)
    if (!entity) { json(res, { error: 'not found' }, 404); return true }
    json(res, { ok: true, data: entity })
    return true
  }

  // GET /api/initiatives/:id/settings
  if (method === 'GET' && /^\/api\/initiatives\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/initiatives/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'initiative', ctx.docStore)
    if (!result) { json(res, { error: 'not found' }, 404); return true }
    json(res, { ok: true, data: result })
    return true
  }

  // GET /api/epics/:id/settings
  if (method === 'GET' && /^\/api\/epics\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/epics/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'epic', ctx.docStore)
    if (!result) { json(res, { error: 'not found' }, 404); return true }
    json(res, { ok: true, data: result })
    return true
  }

  // GET /api/tasks/:id/settings
  if (method === 'GET' && /^\/api\/tasks\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/tasks/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'task', ctx.docStore)
    if (!result) { json(res, { error: 'not found' }, 404); return true }
    json(res, { ok: true, data: result })
    return true
  }

  // PATCH /api/initiatives/:id
  if (method === 'PATCH' && url.startsWith('/api/initiatives/')) {
    const id = url.slice('/api/initiatives/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getInitiative(id)
      if (!existing) return json(res, { error: 'not found' }, 404)
      const patch = JSON.parse(body) as Record<string, unknown>
      const merged = deepMergeEntity(existing as unknown as Record<string, unknown>, patch) as unknown as typeof existing
      ctx.docStore.upsertInitiative(id, merged)
      json(res, { ok: true, data: ctx.docStore.getInitiative(id) })
    })
    return true
  }

  // PATCH /api/epics/:id
  if (method === 'PATCH' && url.startsWith('/api/epics/')) {
    const id = url.slice('/api/epics/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getEpic(id)
      if (!existing) return json(res, { error: 'not found' }, 404)
      const patch = JSON.parse(body) as Record<string, unknown>
      const merged = deepMergeEntity(existing as unknown as Record<string, unknown>, patch) as unknown as typeof existing
      ctx.docStore.upsertEpic(id, merged)
      json(res, { ok: true, data: ctx.docStore.getEpic(id) })
    })
    return true
  }

  // PATCH /api/tasks/:id
  if (method === 'PATCH' && url.startsWith('/api/tasks/')) {
    const id = url.slice('/api/tasks/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getTask(id)
      if (!existing) return json(res, { error: 'not found' }, 404)
      const patch = JSON.parse(body) as Record<string, unknown>
      const merged = deepMergeEntity(existing as unknown as Record<string, unknown>, patch) as unknown as typeof existing
      ctx.docStore.upsertTask(id, merged)
      json(res, { ok: true, data: ctx.docStore.getTask(id) })
    })
    return true
  }

  // PATCH /api/worktrees/:id
  if (method === 'PATCH' && url.startsWith('/api/worktrees/')) {
    const id = url.slice('/api/worktrees/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getWorktree(id)
      if (!existing) return json(res, { error: 'not found' }, 404)
      const patch = JSON.parse(body)
      ctx.docStore.upsertWorktree(id, { ...existing, ...patch })
      json(res, { ok: true, data: ctx.docStore.getWorktree(id) })
    })
    return true
  }

  // DELETE /api/initiatives/:id
  if (method === 'DELETE' && url.startsWith('/api/initiatives/')) {
    const id = url.slice('/api/initiatives/'.length)
    ctx.docStore.deleteInitiative(id)
    json(res, { ok: true })
    return true
  }

  // DELETE /api/epics/:id
  if (method === 'DELETE' && url.startsWith('/api/epics/')) {
    const id = url.slice('/api/epics/'.length)
    ctx.docStore.deleteEpic(id)
    json(res, { ok: true })
    return true
  }

  // DELETE /api/tasks/:id
  if (method === 'DELETE' && url.startsWith('/api/tasks/')) {
    const id = url.slice('/api/tasks/'.length)
    ctx.docStore.deleteTask(id)
    json(res, { ok: true })
    return true
  }

  // DELETE /api/worktrees/:id
  if (method === 'DELETE' && url.startsWith('/api/worktrees/')) {
    const id = url.slice('/api/worktrees/'.length)
    ctx.docStore.deleteWorktree(id)
    json(res, { ok: true })
    return true
  }

  // POST /api/editor-widgets
  if (method === 'POST' && url === '/api/editor-widgets') {
    readBody(req).then(body => {
      const { sessionId, filePath } = JSON.parse(body) as { sessionId?: string; filePath?: string }
      if (!sessionId || !filePath) {
        json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'sessionId and filePath required' } }, 400)
        return
      }
      const run = ctx.docStore.getAllRuns().find(r => r.sessionId === sessionId)
      if (!run) {
        json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `No run with sessionId ${sessionId}` } }, 404)
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
      json(res, { ok: true, data: widget })
    })
    return true
  }

  // DELETE /api/editor-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/editor-widgets/')) {
    const id = url.slice('/api/editor-widgets/'.length)
    const existing = ctx.docStore.getAllEditorWidgets().find(w => w.id === id)
    if (!existing) {
      json(res, { ok: false, error: { code: 'NOT_FOUND', message: `EditorWidget ${id} not found` } }, 404)
      return true
    }
    ctx.docStore.deleteEditorWidget(id)
    json(res, { ok: true })
    return true
  }

  // POST /api/image-widgets
  if (method === 'POST' && url === '/api/image-widgets') {
    readBody(req).then(body => {
      try {
      const { sessionId, filePath } = JSON.parse(body) as { sessionId?: string; filePath?: string }
      if (!sessionId || !filePath) {
        json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'sessionId and filePath required' } }, 400)
        return
      }
      const run = ctx.docStore.getAllRuns().find(r => r.sessionId === sessionId)
      if (!run) {
        json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `No run with sessionId ${sessionId}` } }, 404)
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
        json(res, { ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE', message: 'filePath must be inside the session workspace' } }, 403)
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
      json(res, { ok: true, data: widget })
      } catch {
        json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request body' } }, 400)
      }
    })
    return true
  }

  // DELETE /api/image-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/image-widgets/')) {
    const id = url.slice('/api/image-widgets/'.length)
    const existing = ctx.docStore.getAllImageWidgets().find(w => w.id === id)
    if (!existing) {
      json(res, { ok: false, error: { code: 'NOT_FOUND', message: `ImageWidget ${id} not found` } }, 404)
      return true
    }
    ctx.docStore.deleteImageWidget(id)
    json(res, { ok: true })
    return true
  }

  // GET /api/image-file?session=SESSION_ID&path=FILE_PATH
  if (method === 'GET' && url.startsWith('/api/image-file')) {
    const qs = new URL(url, 'http://localhost').searchParams
    const sessionId = qs.get('session')
    const filePath = qs.get('path')

    if (!sessionId || !filePath) {
      json(res, { error: 'session and path required' }, 400)
      return true
    }

    let absolutePath: string
    if (filePath.startsWith('/') && existsSync(filePath)) {
      absolutePath = filePath
    } else {
      const sessDir = ctx.sessionConfig?.dirs.sessions
      if (!sessDir) { json(res, { error: 'session config unavailable' }, 503); return true }
      const session = getSession(sessDir, sessionId)
      if (!session) { json(res, { error: 'session not found' }, 404); return true }
      const workspacePath = session.workspace?.path ?? null
      if (!workspacePath) { json(res, { error: 'session workspace unavailable' }, 400); return true }
      absolutePath = filePath.startsWith('/')
        ? resolve(workspacePath, filePath.replace(/^\/+/, ''))
        : resolve(workspacePath, filePath)
      if (!absolutePath.startsWith(workspacePath + '/')) {
        json(res, { error: 'path outside workspace' }, 403)
        return true
      }
    }

    if (!existsSync(absolutePath)) {
      json(res, { error: 'file not found' }, 404)
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

  // POST /api/nats-traffic-widgets — create a NATS traffic monitor widget
  if (method === 'POST' && url === '/api/nats-traffic-widgets') {
    readBody(req).then(body => {
      try {
        const { sessionId, subscriptions, color } = JSON.parse(body) as { sessionId?: string; subscriptions?: string[]; color?: string }
        const widget = {
          id: shortId('nats'),
          spaceId: ctx.docStore.activeSpaceId || undefined,
          sessionId: sessionId ?? '',
          subscriptions: subscriptions ?? ['tinstar.>'],  // Default to all tinstar traffic
          color,
        }
        ctx.docStore.upsertNatsTrafficWidget(widget.id, widget)
        // Update NATS bridge subscriptions
        ctx.natsTraffic?.updateWidgetSubscriptions(widget.id, widget.subscriptions)
        ctx.sse.broadcastSnapshot()
        json(res, { ok: true, data: widget })
      } catch {
        json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request body' } }, 400)
      }
    })
    return true
  }

  // POST /api/nats-traffic-widgets/:id/subscribe — add subscription
  if (method === 'POST' && url.match(/^\/api\/nats-traffic-widgets\/[^/]+\/subscribe$/)) {
    const id = url.split('/')[3]
    readBody(req).then(body => {
      try {
        const { subject } = JSON.parse(body) as { subject: string }
        if (!subject) {
          json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'subject required' } }, 400)
          return
        }
        const existing = ctx.docStore.getAllNatsTrafficWidgets().find(w => w.id === id)
        if (!existing) {
          json(res, { ok: false, error: { code: 'NOT_FOUND', message: `Widget ${id} not found` } }, 404)
          return
        }
        const subs = new Set(existing.subscriptions || [])
        subs.add(subject)
        const updated = { ...existing, subscriptions: [...subs] }
        ctx.docStore.upsertNatsTrafficWidget(id, updated)
        ctx.natsTraffic?.updateWidgetSubscriptions(id, updated.subscriptions)
        ctx.sse.broadcastSnapshot()
        json(res, { ok: true, data: updated })
      } catch {
        json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request body' } }, 400)
      }
    })
    return true
  }

  // DELETE /api/nats-traffic-widgets/:id/subscribe — remove subscription
  if (method === 'DELETE' && url.match(/^\/api\/nats-traffic-widgets\/[^/]+\/subscribe$/)) {
    const id = url.split('/')[3]
    readBody(req).then(body => {
      try {
        const { subject } = JSON.parse(body) as { subject: string }
        if (!subject) {
          json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'subject required' } }, 400)
          return
        }
        const existing = ctx.docStore.getAllNatsTrafficWidgets().find(w => w.id === id)
        if (!existing) {
          json(res, { ok: false, error: { code: 'NOT_FOUND', message: `Widget ${id} not found` } }, 404)
          return
        }
        const subs = (existing.subscriptions || []).filter(s => s !== subject)
        const updated = { ...existing, subscriptions: subs }
        ctx.docStore.upsertNatsTrafficWidget(id, updated)
        ctx.natsTraffic?.updateWidgetSubscriptions(id, updated.subscriptions)
        ctx.sse.broadcastSnapshot()
        json(res, { ok: true, data: updated })
      } catch {
        json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request body' } }, 400)
      }
    })
    return true
  }

  // POST /api/nats-traffic-widgets/:id/publish — publish a message
  if (method === 'POST' && url.match(/^\/api\/nats-traffic-widgets\/[^/]+\/publish$/)) {
    const id = url.split('/')[3]
    readBody(req).then(body => {
      try {
        const { subject, message } = JSON.parse(body) as { subject: string; message: string }
        if (!subject || !message) {
          json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'subject and message required' } }, 400)
          return
        }
        const existing = ctx.docStore.getAllNatsTrafficWidgets().find(w => w.id === id)
        if (!existing) {
          json(res, { ok: false, error: { code: 'NOT_FOUND', message: `Widget ${id} not found` } }, 404)
          return
        }
        ctx.natsTraffic?.publish(subject, message, 'tinstar-ui')
        json(res, { ok: true })
      } catch {
        json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request body' } }, 400)
      }
    })
    return true
  }

  // DELETE /api/nats-traffic-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/nats-traffic-widgets/') && !url.includes('/subscribe')) {
    const id = url.slice('/api/nats-traffic-widgets/'.length)
    const existing = ctx.docStore.getAllNatsTrafficWidgets().find(w => w.id === id)
    if (!existing) {
      json(res, { ok: false, error: { code: 'NOT_FOUND', message: `NatsTrafficWidget ${id} not found` } }, 404)
      return true
    }
    ctx.natsTraffic?.removeWidget(id)
    ctx.docStore.deleteNatsTrafficWidget(id)
    json(res, { ok: true })
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
          json(res, { error: 'sessionId, filePath, and subscriberId required' }, 400)
          return
        }

        let absolutePath: string
        if (filePath.startsWith('/') && existsSync(filePath)) {
          absolutePath = filePath
        } else {
          const sessDir = ctx.sessionConfig?.dirs.sessions
          if (!sessDir) { json(res, { error: 'session config unavailable' }, 503); return }
          const session = getSession(sessDir, sessionId)
          if (!session) { json(res, { error: 'session not found' }, 404); return }
          const workspacePath = session.workspace?.path ?? null
          if (!workspacePath) { json(res, { error: 'session workspace unavailable' }, 400); return }
          absolutePath = filePath.startsWith('/')
            ? resolve(workspacePath, filePath.replace(/^\/+/, ''))
            : resolve(workspacePath, filePath)
          if (!absolutePath.startsWith(workspacePath + '/')) {
            json(res, { error: 'path outside workspace' }, 403)
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
            json(res, { ok: true, absolutePath, content })
          }).catch(() => {
            json(res, { ok: true, absolutePath })
          })
        } else {
          json(res, { ok: true, absolutePath })
        }
      } catch {
        json(res, { error: 'invalid request body' }, 400)
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
          json(res, { error: 'absolutePath and subscriberId required' }, 400)
          return
        }
        removeFileWatchSubscriber(absolutePath, subscriberId)
        json(res, { ok: true })
      } catch {
        json(res, { error: 'invalid request body' }, 400)
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
      const { sessionId, url: widgetUrl = '', headers: widgetHeaders } = JSON.parse(body) as { sessionId?: string; url?: string; headers?: Record<string, string> }
      if (!sessionId) {
        json(res, { ok: false, error: { code: 'INVALID_PARAMS', message: 'sessionId required' } }, 400)
        return
      }
      const run = ctx.docStore.getAllRuns().find(r => r.sessionId === sessionId)
      if (!run) {
        json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `No run with sessionId ${sessionId}` } }, 404)
        return
      }
      const widget: import('../../domain/types').BrowserWidget = {
        id: shortId('browser'),
        spaceId: ctx.docStore.activeSpaceId || undefined,
        sessionId,
        url: widgetUrl,
        color: run.color,
        ...(widgetHeaders && Object.keys(widgetHeaders).length > 0 ? { headers: widgetHeaders } : {}),
      }
      ctx.docStore.upsertBrowserWidget(widget.id, widget)
      json(res, { ok: true, data: widget })
    })
    return true
  }

  // PATCH /api/browser-widgets/:id
  if (method === 'PATCH' && url.startsWith('/api/browser-widgets/')) {
    const id = url.slice('/api/browser-widgets/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getAllBrowserWidgets().find(w => w.id === id)
      if (!existing) {
        json(res, { ok: false, error: { code: 'NOT_FOUND', message: `BrowserWidget ${id} not found` } }, 404)
        return
      }
      const patch = JSON.parse(body) as { url?: string; title?: string; headers?: Record<string, string> }
      const updated = { ...existing, ...patch }
      ctx.docStore.upsertBrowserWidget(id, updated)
      json(res, { ok: true, data: updated })
    })
    return true
  }

  // DELETE /api/browser-widgets/:id
  if (method === 'DELETE' && url.startsWith('/api/browser-widgets/')) {
    const id = url.slice('/api/browser-widgets/'.length)
    const existing = ctx.docStore.getAllBrowserWidgets().find(w => w.id === id)
    if (!existing) {
      json(res, { ok: false, error: { code: 'NOT_FOUND', message: `BrowserWidget ${id} not found` } }, 404)
      return true
    }
    ctx.docStore.deleteBrowserWidget(id)
    json(res, { ok: true })
    return true
  }

  // NOTE: GET /api/file-watch SSE endpoint removed — file watching now goes
  // through POST /api/file-watch/subscribe and the main SSE connection.

  // PATCH /api/runs/:id
  if (method === 'PATCH' && url.startsWith('/api/runs/')) {
    const id = url.slice('/api/runs/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getRun(id)
      if (!existing) return json(res, { ok: false, error: 'not found' }, 404)
      const patch = JSON.parse(body)
      ctx.docStore.upsertRun(id, { ...existing, ...patch })
      json(res, { ok: true, data: ctx.docStore.getRun(id) })
    })
    return true
  }

  // --- Skills ---

  // GET /api/skills
  if (method === 'GET' && url === '/api/skills') {
    const skills = getSkills()
    const dtos: SkillDTO[] = skills.map(({ name, description, source }) => ({ name, description, source }))
    json(res, { skills: dtos })
    return true
  }

  // POST /api/skills/save
  if (method === 'POST' && url === '/api/skills/save') {
    readBody(req).then(async (body) => {
      const { draftId, location, sessionId } = JSON.parse(body) as {
        draftId: string
        location: 'system' | 'repo'
        sessionId?: string
      }
      if (!draftId || !['system', 'repo'].includes(location)) {
        json(res, { error: 'invalid-params' }, 400)
        return
      }

      // Resolve projectRoot for repo-level saves
      let projectRoot: string | undefined
      if (location === 'repo' && sessionId && ctx.sessionConfig) {
        const sess = getSession(ctx.sessionConfig.dirs.sessions, sessionId)
        if (sess?.workspace?.path) {
          projectRoot = sess.workspace.path
        }
      }

      try {
        // Read skillName from draft frontmatter BEFORE moving the file
        const draftPath = join(DRAFTS_DIR, `${draftId}.md`)
        let skillName = draftId  // fallback
        try {
          const content = readFileSync(draftPath, 'utf-8')
          const fm = parseFrontmatter(content)
          if (fm.name) skillName = fm.name
        } catch { /* use fallback */ }

        saveDraft(draftId, location, projectRoot)
        bustSkillCache()

        const dto: SkillDTO = {
          name: skillName,
          source: location === 'system' ? 'system' : 'repo',
        }
        // Try to get description from the refreshed cache
        const freshSkills = getSkills()
        const saved = freshSkills.find(s => s.name === skillName)
        if (saved?.description) dto.description = saved.description

        ctx.sse.broadcastEvent('skill.saved', { skill: dto })
        json(res, { skill: dto })
      } catch (err) {
        const e = err as Error & { existingPath?: string }
        if (e.message === 'skill-name-conflict') {
          json(res, { error: 'skill-name-conflict', existingPath: e.existingPath }, 409)
        } else {
          json(res, { error: e.message }, 500)
        }
      }
    })
    return true
  }

  // POST /api/skills/discard
  if (method === 'POST' && url === '/api/skills/discard') {
    readBody(req).then((body) => {
      const { draftId } = JSON.parse(body) as { draftId: string }
      if (!draftId) { json(res, { error: 'missing draftId' }, 400); return }
      discardDraft(draftId)
      json(res, { ok: true })
    })
    return true
  }

  // POST /api/skills/create-draft — create a skeleton skill draft without agent involvement.
  // The file watcher in watchDrafts() picks this up and emits skill.drafted to the client.
  if (method === 'POST' && url === '/api/skills/create-draft') {
    readBody(req).then((body) => {
      const { draftId, name } = JSON.parse(body) as { draftId: string; name: string }
      if (!draftId || !name) { json(res, { error: 'missing draftId or name' }, 400); return }
      ensureDraftsDir()
      const filePath = join(DRAFTS_DIR, `${draftId}.md`)
      writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`)
      json(res, { ok: true, draftId })
    })
    return true
  }

  // --- Session management routes (only active when sessionConfig is set) ---

  if (ctx.sessionConfig) {
    const cfg = ctx.sessionConfig
    const sessDir = cfg.dirs.sessions
    const secrets = () => loadSecrets(cfg.dirs.secrets)
    const dashboardUrl = `http://localhost:${process.env.TINSTAR_DASHBOARD_PORT ?? 5273}`

    function emitSessionEvent(type: 'managed_session.created' | 'managed_session.state_changed' | 'managed_session.deleted', payload: Record<string, unknown>) {
      ctx.bus.emit({ type, timestamp: new Date().toISOString(), payload } as unknown as Parameters<typeof ctx.bus.emit>[0])
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
        getContainerState: (name) => dockerBackend.getContainerState(cfg, name),
        getTmuxSessionState: (name) => tmuxBackend.getTmuxSessionState(cfg, name),
        onStateChanged: (name, state) => {
          emitSessionEvent('managed_session.state_changed', { name, state })
        },
      }).then(sessions => json(res, { ok: true, data: sessions }))
        .catch(err => json(res, { ok: false, error: { code: 'LIST_FAILED', message: (err as Error).message } }, 500))
      return true
    }

    // GET /api/sessions/:name (exact match, no trailing path)
    if (method === 'GET' && url.startsWith('/api/sessions/') && !url.includes('/start') && !url.includes('/stop') && !url.includes('/files')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session) {
          json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `Session '${name}' not found` } }, 404)
        } else {
          json(res, { ok: true, data: session })
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
          json(res, { ok: false, error: { code: 'NO_WORKSPACE', message: 'Session has no workspace' } }, 404)
          return true
        }
        const wsRoot = session.workspace.path
        const params = new URL(url, 'http://localhost').searchParams
        const relPath = params.get('path') || '.'
        const absPath = join(wsRoot, relPath)

        // Safety: ensure we don't escape the workspace
        if (!absPath.startsWith(wsRoot)) {
          json(res, { ok: false, error: { code: 'INVALID_PATH', message: 'Path escapes workspace' } }, 400)
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
          json(res, { ok: true, data: entries })
        } catch (err) {
          json(res, { ok: false, error: { code: 'READ_FAILED', message: (err as Error).message } }, 500)
        }
        return true
      }
    }

    // POST /api/sessions
    if (method === 'POST' && url === '/api/sessions') {
      readBody(req).then(async (body) => {
        const { name, backend = 'docker', project, worktree = false, worktreePath, profile, prompt, oneshot = false, skipPermissions = true, cliTemplate: cliTemplateName, taskId, epicId, initiativeId, color: colorParam, nats, pattern: patternName } = JSON.parse(body)
        log.info('sessions', `creating session: ${name}`, { backend, project, worktree, oneshot, cliTemplate: cliTemplateName, taskId, epicId, initiativeId, color: colorParam })

        if (!name) return json(res, { ok: false, error: { code: 'MISSING_NAME', message: 'Session name is required' } }, 400)
        if (!['docker', 'tmux'].includes(backend)) return json(res, { ok: false, error: { code: 'INVALID_BACKEND', message: 'Backend must be "docker" or "tmux"' } }, 400)
        if (oneshot && !prompt) return json(res, { ok: false, error: { code: 'MISSING_PROMPT', message: 'oneshot sessions require a prompt' } }, 400)
        if (oneshot && backend !== 'docker') return json(res, { ok: false, error: { code: 'INVALID_BACKEND', message: 'oneshot is only supported for docker backend' } }, 400)

        if (getSession(sessDir, name)) {
          return json(res, { ok: false, error: { code: 'SESSION_EXISTS', message: `Session '${name}' already exists` } }, 409)
        }

        // Handle pattern-based session creation with k8s-style orchestration
        if (patternName) {
          const pattern = getPatternByName(patternName)
          if (!pattern) {
            return json(res, { ok: false, error: { code: 'PATTERN_NOT_FOUND', message: `Pattern '${patternName}' not found` } }, 404)
          }

          if (!pattern.sessions.some(s => s.role === 'orchestrator')) {
            return json(res, { ok: false, error: { code: 'INVALID_PATTERN', message: 'Pattern must have an orchestrator session' } }, 400)
          }

          // Build orchestration plan (handles replicas, topological sort)
          const plan = buildOrchestrationPlan(pattern, name)
          log.info('patterns', `orchestration plan for ${patternName}:`, {
            spawnOrder: plan.spawnOrder.map(s => s.sessionName),
            readinessRequired: [...plan.readinessRequired],
          })

          // Build NATS subjects for template interpolation
          const sessionNames: Record<string, string> = {}
          for (const entry of plan.spawnOrder) {
            if (!sessionNames[entry.role]) {
              sessionNames[entry.role] = entry.sessionName
            }
          }

          const templateVars: TemplateVars = {
            task: taskId ?? name,
            taskId: taskId ?? '',
          }
          templateVars.orchestrator = buildNatsSubject(sessionNames.orchestrator, ctx.docStore, taskId, epicId, initiativeId)
          templateVars.worker = sessionNames.worker ? buildNatsSubject(sessionNames.worker, ctx.docStore, taskId, epicId, initiativeId) : ''

          const createCtx: CreateSessionContext = {
            cfg,
            sessDir,
            docStore: ctx.docStore,
            readyQueue: ctx.readyQueue,
            sse: ctx.sse,
            emitSessionEvent,
            secrets,
            dashboardUrl,
          }

          // Check if any session needs a worktree — if so, create ONE shared worktree for all
          const needsWorktree = pattern.sessions.some(s => s.config.worktree)
          let sharedWorktreePath: string | null = null

          if (needsWorktree && project) {
            const projectPath = getProject(cfg.files.projects, project)
            if (projectPath) {
              try {
                sharedWorktreePath = await createWorktree(projectPath, name)
                log.info('patterns', `created shared worktree for pattern: ${sharedWorktreePath}`)
              } catch (err) {
                log.warn('patterns', `failed to create shared worktree: ${(err as Error).message}`)
              }
            }
          }

          const createdSessions: string[] = []
          const errors: string[] = []
          const startedSessions = new Set<string>()

          // Spawn sessions in order, waiting for readiness where required
          for (const entry of plan.spawnOrder) {
            const { sessionName, role, config } = entry
            templateVars.sessionId = sessionName

            // Check if we need to wait for any dependencies to be ready
            const depRoles = plan.dependencies.get(sessionName) ?? []
            for (const depRole of depRoles) {
              const depConfig = pattern.sessions.find(s => s.role === depRole)?.config
              const condition = config.dependsOn?.[depRole]?.condition ?? 'started'

              if (condition === 'ready') {
                // Wait for all sessions with this role to signal ready
                const depSessions = plan.spawnOrder.filter(s => s.role === depRole).map(s => s.sessionName)
                log.info('patterns', `${sessionName} waiting for ${depSessions.join(', ')} to be ready`)

                if (ctx.readinessTracker) {
                  const ready = await ctx.readinessTracker.waitForAllReady(depSessions, 60000)
                  if (!ready) {
                    errors.push(`${sessionName}: timed out waiting for ${depRole} to be ready`)
                    continue
                  }
                  log.info('patterns', `${sessionName} dependencies ready, spawning`)
                }
              }
            }

            const interpolatedConfig = interpolateSessionConfig(config, templateVars)

            // Resolve hand reference if present
            let sessionPrompt: string | undefined
            if (interpolatedConfig.hand) {
              const hand = getHandByName(interpolatedConfig.hand)
              if (!hand) {
                errors.push(`${sessionName}: hand '${interpolatedConfig.hand}' not found`)
                continue
              }
              // Use hand's prompt and cliTemplate
              sessionPrompt = hand.prompt
              if (interpolatedConfig.prompt) {
                sessionPrompt = `${hand.prompt}\n\n---\n\n${interpolatedConfig.prompt}`
              }
              // Override cliTemplate if not explicitly set
              if (!interpolatedConfig.cliTemplate) {
                interpolatedConfig.cliTemplate = hand.cliTemplate
              }
            } else if (role === 'orchestrator') {
              const patternPrompt = interpolatedConfig.prompt ?? ''
              sessionPrompt = prompt ? `${prompt}\n\n---\n\n${patternPrompt}` : patternPrompt
            } else {
              sessionPrompt = interpolatedConfig.prompt
            }

            // Mark session as started for readiness tracking
            ctx.readinessTracker?.markStarted(sessionName)

            // Use shared worktree for all pattern sessions (don't create individual worktrees)
            const result = await createSessionInternal({
              name: sessionName,
              backend: (interpolatedConfig.backend ?? backend) as 'docker' | 'tmux',
              project: interpolatedConfig.project ?? project,
              worktree: false,  // Don't create new worktree — use shared one
              worktreePath: sharedWorktreePath ?? interpolatedConfig.worktreePath,
              profile: interpolatedConfig.profile ?? profile,
              skipPermissions: interpolatedConfig.skipPermissions ?? skipPermissions,
              cliTemplate: interpolatedConfig.cliTemplate ?? cliTemplateName,
              prompt: sessionPrompt,
              taskId,
              epicId,
              initiativeId,
              color: colorParam,
              nats: { enabled: true },
            }, createCtx)

            if (result.ok) {
              createdSessions.push(sessionName)
              startedSessions.add(sessionName)

              // For sessions with readiness.nats: auto, publish ready signal
              if (config.readiness?.nats === 'auto' && ctx.readinessTracker) {
                // Fire and forget — don't block on the delay
                ctx.readinessTracker.publishReady(sessionName).catch(err => {
                  log.warn('patterns', `failed to publish ready for ${sessionName}: ${(err as Error).message}`)
                })
              }
            } else {
              errors.push(`${sessionName}: ${result.error.message}`)
            }
          }

          if (createdSessions.length === 0) {
            return json(res, { ok: false, error: { code: 'PATTERN_SPAWN_FAILED', message: `All pattern sessions failed: ${errors.join(', ')}` } }, 500)
          }

          if (errors.length > 0) {
            log.warn('patterns', `some pattern sessions failed: ${errors.join(', ')}`)
          }

          log.info('patterns', `created pattern sessions: ${createdSessions.join(', ')}`)
          return json(res, { ok: true, data: { pattern: patternName, sessions: createdSessions, errors: errors.length > 0 ? errors : undefined } }, 201)
        }

        try {
          // Resolve project
          let projectPath: string | null = null
          if (project) {
            projectPath = getProject(cfg.files.projects, project)
            if (!projectPath) return json(res, { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: `Project '${project}' not found` } }, 404)
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
            ctx.docStore.upsertWorktree(worktreeEntityId, {
              id: worktreeEntityId,
              name,
              branch: branch ?? name,
              repo: project ?? '',
              worktreePath: workspacePath,
              spaceId: ctx.docStore.activeSpaceId,
            })
          }

          // Resolve run color: explicit param > task > epic > initiative > undefined
          const color = colorParam
            ?? (taskId ? ctx.docStore.getTask(taskId)?.settings?.defaultRunColor : undefined)
            ?? (epicId ? ctx.docStore.getEpic(epicId)?.settings?.defaultRunColor : undefined)
            ?? (initiativeId ? ctx.docStore.getInitiative(initiativeId)?.settings?.defaultRunColor : undefined)

          // Resolve CLI template
          const resolvedTemplate = cliTemplateName
            ? cfg.cliTemplates.find(t => t.name === cliTemplateName) ?? null
            : null

          // Compute NATS subscriptions from entity hierarchy if not explicitly provided
          let resolvedNats = nats ?? null
          if (!nats && (taskId || epicId || initiativeId)) {
            const natsCtx = {
              sessionName: name,
              spaceId: ctx.docStore.activeSpaceId || null,
              taskId: taskId || null,
              epicId: epicId || null,
              initiativeId: initiativeId || null,
            }
            const subscriptions = computeNatsSubscriptions(natsCtx, ctx.docStore)
            resolvedNats = { enabled: true, subscriptions }
          }

          const session = createSession(sessDir, {
            name,
            backend: resolvedTemplate ? 'tmux' : backend,
            project,
            workspace: {
              path: workspacePath,
              worktree: isWorktree,
              branch,
              basePath: isWorktree ? projectPath : null,
            },
            profile,
            oneshot,
            skipPermissions,
            cliTemplate: cliTemplateName ?? null,
            adapter: resolvedTemplate?.adapter ?? null,
            nats: resolvedNats,
          })

          // Enrich session with state dir for Docker backend
          const enriched = session as Session & { _stateDir?: string; initialPrompt?: string }
          enriched._stateDir = claudeStateDir(sessDir, name)

          const sec = secrets()
          let sessionPort: number | undefined

          if (backend === 'docker' && oneshot) {
            await dockerBackend.createOneShotContainer(cfg, {
              session: enriched,
              secrets: sec,
              prompt,
              onComplete: (exitCode: number) => {
                setState(sessDir, name, 'idle')
                emitSessionEvent('managed_session.state_changed', { name, state: 'idle' })
                log.info('oneshot', `${name} exited`, { exitCode })
              },
            })
            updateSession(sessDir, name, { state: 'running' })
          } else if (backend === 'docker') {
            sessionPort = await tmuxBackend.findPort(cfg.ports.hostStart)
            await dockerBackend.createContainer(cfg, { session: enriched, secrets: sec, port: sessionPort, dashboardUrl, initialPrompt: prompt || undefined })
            updateSession(sessDir, name, { port: sessionPort, state: 'running' })
          } else {
            const port = await tmuxBackend.findPort(cfg.ports.hostStart)
            if (prompt) enriched.initialPrompt = prompt

            const result = await tmuxBackend.createTmuxSession(cfg, { session: enriched, secrets: sec, port, template: resolvedTemplate })
            sessionPort = result.port
            updateSession(sessDir, name, { port: sessionPort, ttydPid: result.ttydPid ?? null, state: 'running' })
            tmuxBackend.onTtydRestart(name, (newPid) => {
              updateSession(sessDir, name, { ttydPid: newPid })
            })
          }

          const updated = getSession(sessDir, name)

          // Create a Run in the document store so it appears on the canvas
          // If a prompt was given, Claude is immediately executing — 'running'.
          // If not, Claude opens at the REPL waiting for input — 'idle'.
          const runId = name
          const initialStatus = prompt ? 'running' : 'idle'
          // Build backend info for tooltip
          let backendInfo: string | undefined
          if (backend === 'docker') {
            const container = dockerBackend.containerName(cfg, name)
            const imageProfile = profile ? cfg.profiles.find(p => p.name === profile) : undefined
            const image = imageProfile?.image ?? cfg.container.defaultImage
            backendInfo = `container: ${container}\nimage: ${image}`
          } else {
            backendInfo = `tmux session: ${name}`
          }

          // Build NATS subject for this session
          const natsSubject = resolvedNats?.enabled
            ? buildNatsSubject(name, ctx.docStore, taskId, epicId, initiativeId)
            : undefined

          ctx.docStore.upsertRun(runId, {
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
            backend,
            backendInfo,
            agentIcon: resolvedTemplate?.icon ?? undefined,
            natsEnabled: resolvedNats?.enabled ?? false,
            natsSubject,
            taskId: taskId ?? '',
            worktreeId: worktreeEntityId,
            createdAt: new Date().toISOString(),
            spaceId: ctx.docStore.activeSpaceId,
          })

          ctx.readyQueue.onStatusChange(name, initialStatus)
          ctx.sse.setReadyQueue(ctx.readyQueue.getQueue())
          ctx.sse.broadcastReadyQueueUpdate()
          emitSessionEvent('managed_session.created', { name, state: 'running' })
          log.info('sessions', `session created: ${name}`, { backend, port: sessionPort, state: 'running' })

          json(res, { ok: true, data: updated }, 201)
        } catch (err) {
          log.error('sessions', `session creation failed: ${name}`, { error: (err as Error).message })
          json(res, { ok: false, error: { code: 'CREATE_FAILED', message: (err as Error).message } }, 500)
        }
      })
      return true
    }

    // POST /api/sessions/:name/stop
    if (method === 'POST' && url.endsWith('/stop') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        readBody(req).then(async () => {
          const session = getSession(sessDir, name)
          if (!session) return json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `Session '${name}' not found` } }, 404)

          try {
            if (session.backend === 'docker') {
              await dockerBackend.stopContainer(cfg, session)
            } else {
              await tmuxBackend.stopTmuxSession(cfg, session)
              if (session.port) tmuxBackend.releasePort(session.port)
            }

            setState(sessDir, session.name, 'stopped')
            ctx.docStore.updateRunStatus(session.name, 'stopped')
            emitSessionEvent('managed_session.state_changed', { name: session.name, state: 'stopped' })
            json(res, { ok: true, data: getSession(sessDir, session.name) })
          } catch (err) {
            json(res, { ok: false, error: { code: 'STOP_FAILED', message: (err as Error).message } }, 500)
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
          if (!session) return json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `Session '${name}' not found` } }, 404)

          // Verify workspace directory still exists
          const wsPath = session.workspace?.path
          if (wsPath && !existsSync(wsPath)) {
            return json(res, { ok: false, error: { code: 'WORKSPACE_MISSING', message: `Workspace directory no longer exists: ${wsPath}` } }, 400)
          }

          // Require a conversation ID to resume — sessions created before this change won't have one
          if (!session.conversation?.id) {
            return json(res, { ok: false, error: { code: 'NO_SESSION_ID', message: `Session '${name}' has no conversation ID. Delete and recreate it.` } }, 400)
          }

          try {
            const sec = secrets()

            if (session.backend === 'docker') {
              const port = session.port ?? await tmuxBackend.findPort(cfg.ports.hostStart)
              await dockerBackend.startContainer(cfg, { session: session as Session & { _stateDir?: string }, secrets: sec, port, dashboardUrl })
              updateSession(sessDir, session.name, { port })
            } else {
              const port = session.port ?? await tmuxBackend.findPort(cfg.ports.hostStart)
              const resumeTemplate = session.cliTemplate
                ? cfg.cliTemplates.find(t => t.name === session.cliTemplate) ?? null
                : null
              const result = await tmuxBackend.startTmuxSession(cfg, { session, secrets: sec, port, template: resumeTemplate })
              updateSession(sessDir, session.name, { port: result.port, ttydPid: result.ttydPid ?? null })
              tmuxBackend.onTtydRestart(session.name, (newPid) => {
                updateSession(sessDir, session.name, { ttydPid: newPid })
              })
            }

            // Re-read session to get updated port
            const updated = getSession(sessDir, session.name)
            const resumePort = updated?.port ?? session.port
            setState(sessDir, session.name, 'running')
            ctx.docStore.updateRunStatus(session.name, 'running')
            // Also update port on the run in case it changed
            if (resumePort) {
              const run = ctx.docStore.getRun(session.name)
              if (run && run.port !== resumePort) {
                ctx.docStore.upsertRun(session.name, { ...run, port: resumePort })
              }
            }
            emitSessionEvent('managed_session.state_changed', { name: session.name, state: 'running' })
            json(res, { ok: true, data: updated })
          } catch (err) {
            json(res, { ok: false, error: { code: 'START_FAILED', message: (err as Error).message } }, 500)
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
        emitSessionEvent('managed_session.deleted', { name })
        ctx.readyQueue.onDelete(name)
        ctx.sse.setReadyQueue(ctx.readyQueue.getQueue())
        ctx.sse.broadcastReadyQueueUpdate()
        json(res, { ok: true })

        // Cleanup: stop backend first (releases bind mounts), then remove session dir
        ;(async () => {
          try {
            if (session) {
              if (session.backend === 'docker') {
                await dockerBackend.deleteContainer(cfg, session)
              } else {
                await tmuxBackend.deleteTmuxSession(cfg, session)
                if (session.port) tmuxBackend.releasePort(session.port)
              }


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

    // GET /api/config — read the full user config
    if (method === 'GET' && url === '/api/config') {
      try {
        const data = JSON.parse(readFileSync(cfg.files.config, 'utf-8'))
        json(res, { ok: true, data })
      } catch {
        json(res, { ok: true, data: {} })
      }
      return true
    }

    // PATCH /api/config — merge keys into user config and persist
    if (method === 'PATCH' && url === '/api/config') {
      readBody(req).then((body) => {
        const patch = JSON.parse(body)
        let data: Record<string, unknown> = {}
        try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no existing config */ }
        Object.assign(data, patch)
        writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
        json(res, { ok: true, data })
      })
      return true
    }

    // POST /api/editor/open — open a file in the configured editor
    if (method === 'POST' && url === '/api/editor/open') {
      readBody(req).then((body) => {
        const { path: filePath, sessionId } = JSON.parse(body)
        if (!filePath) return json(res, { ok: false, error: { code: 'MISSING_PATH', message: 'path is required' } }, 400)

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

        import('node:child_process').then(({ spawn }) => {
          const child = spawn(bin!, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env })
          child.stderr?.on('data', (d: Buffer) => log.warn('editor', `stderr: ${d.toString().trim()}`))
          child.on('error', (err) => log.error('editor', `spawn error: ${err.message}`))
          child.on('exit', (code) => { if (code) log.warn('editor', `exited with code ${code}`) })
          child.unref()
          json(res, { ok: true })
        })
      })
      return true
    }

    // POST /api/sessions/:name/spawn — spawn a companion hand on the same task
    if (method === 'POST' && url.startsWith('/api/sessions/') && url.endsWith('/spawn')) {
      const parentName = extractSessionName(url, '/api/sessions/')?.replace('/spawn', '')
      if (!parentName) return json(res, { ok: false, error: { code: 'INVALID_REQUEST', message: 'Session name required' } }, 400)

      const parentSession = getSession(sessDir, parentName)
      if (!parentSession) return json(res, { ok: false, error: { code: 'NOT_FOUND', message: `Session '${parentName}' not found` } }, 404)

      const body = await readBody(req)
      const { hand: handName, prompt: promptOverride, orchestrator } = JSON.parse(body) as {
        hand: string
        prompt?: string
        orchestrator?: boolean
      }

      if (!handName) {
        return json(res, { ok: false, error: { code: 'MISSING_HAND', message: 'hand field is required' } }, 400)
      }

      const hand = getHandByName(handName)
      if (!hand) {
        return json(res, { ok: false, error: { code: 'HAND_NOT_FOUND', message: `Hand '${handName}' not found` } }, 404)
      }

      // Generate unique session name
      const spawnedName = `${parentName}-${handName}-${shortId()}`

      // Build the prompt: hand base + optional override
      let fullPrompt = hand.prompt
      if (promptOverride) {
        fullPrompt = `${hand.prompt}\n\n---\n\n${promptOverride}`
      }

      // Resolve the parent's run to get taskId for NATS subject computation
      const parentRun = ctx.docStore.getAllRuns().find(r => r.sessionId === parentName)
      const taskId = parentRun?.taskId

      // Inherit workspace from parent session
      const workspace = parentSession.workspace

      // Build NATS subscriptions for the spawned session
      let natsConfig: { enabled: boolean; subscriptions: string[] } | null = null
      if (parentSession.nats?.enabled && taskId) {
        const natsCtx = {
          sessionName: spawnedName,
          spaceId: ctx.docStore.activeSpaceId || null,
          taskId: taskId || null,
          epicId: null,
          initiativeId: null,
        }
        const subscriptions = computeNatsSubscriptions(natsCtx, ctx.docStore)
        natsConfig = { enabled: true, subscriptions }
      }

      // Resolve CLI template from hand definition
      const cliTemplate = hand.cliTemplate

      // Create the spawned session
      const spawnedSession = createSession(sessDir, {
        name: spawnedName,
        backend: parentSession.backend,
        project: parentSession.project,
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

      emitSessionEvent('managed_session.created', { session: spawnedSession })

      // Start the session with the combined prompt
      const enriched = spawnedSession as Session & { _stateDir?: string; initialPrompt?: string }
      enriched._stateDir = claudeStateDir(sessDir, spawnedName)
      const sec = secrets()

      const resolvedTemplate = cliTemplate
        ? cfg.cliTemplates.find(t => t.name === cliTemplate) ?? null
        : null

      try {
        let sessionPort: number | undefined

        if (parentSession.backend === 'docker') {
          sessionPort = await tmuxBackend.findPort(cfg.ports.hostStart)
          await dockerBackend.createContainer(cfg, { session: enriched, secrets: sec, port: sessionPort, dashboardUrl, initialPrompt: fullPrompt || undefined })
          updateSession(sessDir, spawnedName, { port: sessionPort, state: 'running' })
        } else {
          const port = await tmuxBackend.findPort(cfg.ports.hostStart)
          if (fullPrompt) enriched.initialPrompt = fullPrompt
          const result = await tmuxBackend.createTmuxSession(cfg, { session: enriched, secrets: sec, port, template: resolvedTemplate })
          sessionPort = result.port
          updateSession(sessDir, spawnedName, { port: sessionPort, ttydPid: result.ttydPid ?? null, state: 'running' })
          tmuxBackend.onTtydRestart(spawnedName, (newPid) => {
            updateSession(sessDir, spawnedName, { ttydPid: newPid })
          })
        }

        emitSessionEvent('managed_session.state_changed', { name: spawnedName, state: 'running' })

        // Build NATS subject for the run
        const natsSubject = natsConfig?.enabled
          ? buildNatsSubject(spawnedName, ctx.docStore, taskId)
          : undefined

        // Create a run entity linked to the same task as the parent
        const runId = spawnedName
        ctx.docStore.upsertRun(runId, {
          id: runId,
          color: parentRun?.color,
          status: 'running',
          sessionId: spawnedName,
          initiative: '',
          epic: '',
          task: taskId ?? '',
          repo: parentSession.project ?? '',
          worktree: '',
          touchedFiles: [],
          recapEntries: [],
          rawLogs: '',
          port: sessionPort ?? null,
          backend: parentSession.backend,
          backendInfo: parentSession.backend === 'docker'
            ? `container: ${dockerBackend.containerName(cfg, spawnedName)}`
            : `tmux session: ${spawnedName}`,
          natsEnabled: natsConfig?.enabled ?? false,
          natsSubject,
          taskId: taskId ?? '',
          worktreeId: '',
          createdAt: new Date().toISOString(),
          spaceId: ctx.docStore.activeSpaceId,
        })

        return json(res, {
          ok: true,
          data: {
            session: spawnedName,
            hand: handName,
            parentSession: parentName,
            orchestrator: orchestrator ?? false,
          },
        }, 201)
      } catch (err) {
        // Clean up on failure
        deleteSession(sessDir, spawnedName)
        return json(res, {
          ok: false,
          error: { code: 'SPAWN_FAILED', message: (err as Error).message },
        }, 500)
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
          json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'keys must be a non-empty array of strings' } }, 400)
          return true
        }
        const session = getSession(sessDir, name)
        if (!session) { json(res, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404); return true }
        try {
          if (session.backend === 'docker') {
            await dockerBackend.sendKeys(cfg, name, keys)
          } else {
            await tmuxBackend.sendKeys(cfg, name, keys)
          }
          json(res, { ok: true })
        } catch (err) {
          json(res, { ok: false, error: { code: 'SEND_FAILED', message: (err as Error).message } }, 500)
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
          json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'prompt must be a non-empty string' } }, 400)
          return true
        }
        const session = getSession(sessDir, name)
        if (!session) { json(res, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404); return true }
        try {
          if (session.backend === 'docker') {
            await dockerBackend.sendPrompt(cfg, name, prompt)
          } else {
            await tmuxBackend.sendPrompt(cfg, name, prompt)
          }
          json(res, { ok: true })
        } catch (err) {
          json(res, { ok: false, error: { code: 'SEND_FAILED', message: (err as Error).message } }, 500)
        }
        return true
      }
    }

    // GET /api/sessions/:name/subscriptions — list NATS subscriptions for a session
    if (method === 'GET' && url.endsWith('/subscriptions') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session) { json(res, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404); return true }
        json(res, { ok: true, data: { subscriptions: session.nats?.subscriptions ?? [] } })
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
            return json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'subject must be a non-empty string' } }, 400)
          }
          const session = getSession(sessDir, name)
          if (!session) { return json(res, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404) }
          if (!session.nats?.enabled) { return json(res, { ok: false, error: { code: 'NATS_DISABLED', message: 'NATS is not enabled for this session' } }, 400) }

          // Add to subscriptions if not already present
          const subs = session.nats.subscriptions
          if (!subs.includes(subject)) {
            subs.push(subject)
            updateSession(sessDir, name, { nats: { ...session.nats, subscriptions: subs } })

            // Send to channel server via Unix socket
            try {
              await sendNatsSocketCommand(name, { action: 'subscribe', subject })
            } catch (err) {
              log.warn('nats', `Failed to send subscribe to socket for ${name}: ${(err as Error).message}`)
            }
          }
          json(res, { ok: true, data: { subscriptions: subs } })
        }).catch(() => json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400))
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
            return json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'subject must be a non-empty string' } }, 400)
          }
          const session = getSession(sessDir, name)
          if (!session) { return json(res, { ok: false, error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404) }
          if (!session.nats?.enabled) { return json(res, { ok: false, error: { code: 'NATS_DISABLED', message: 'NATS is not enabled for this session' } }, 400) }

          // Remove from subscriptions
          const subs = session.nats.subscriptions.filter(s => s !== subject)
          updateSession(sessDir, name, { nats: { ...session.nats, subscriptions: subs } })

          // Send to channel server via Unix socket
          try {
            await sendNatsSocketCommand(name, { action: 'unsubscribe', subject })
          } catch (err) {
            log.warn('nats', `Failed to send unsubscribe to socket for ${name}: ${(err as Error).message}`)
          }
          json(res, { ok: true, data: { subscriptions: subs } })
        }).catch(() => json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400))
        return true
      }
    }

    // GET /api/cli-templates — configured CLI templates for agent backends
    if (method === 'GET' && url === '/api/cli-templates') {
      json(res, { ok: true, data: cfg.cliTemplates })
      return true
    }

    // POST /api/cli-templates — add or update a CLI template
    if (method === 'POST' && url === '/api/cli-templates') {
      readBody(req).then((body) => {
        const { name, icon, adapter, startCmd, resumeCmd } = JSON.parse(body)
        if (!name || !startCmd || !resumeCmd) return json(res, { ok: false, error: { code: 'MISSING_FIELDS', message: 'name, startCmd, and resumeCmd are required' } }, 400)

        let data: Record<string, unknown> = {}
        try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no config */ }
        const templates: Array<{ name: string; icon?: string; adapter?: string; startCmd: string; resumeCmd: string }> = Array.isArray(data.cliTemplates) ? data.cliTemplates : []
        const entry = { name, startCmd, resumeCmd, ...(icon ? { icon } : {}), ...(adapter ? { adapter } : {}) }
        const idx = templates.findIndex(t => t.name === name)
        if (idx >= 0) templates[idx] = entry
        else templates.push(entry)
        data.cliTemplates = templates
        writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
        json(res, { ok: true, data: { name, startCmd, resumeCmd } })
      }).catch(() => json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400))
      return true
    }

    // PUT /api/cli-templates/:name — update a CLI template (supports renaming)
    if (method === 'PUT' && url.startsWith('/api/cli-templates/')) {
      const oldName = decodeURIComponent(url.slice('/api/cli-templates/'.length))
      readBody(req).then((body) => {
        const { name, icon, adapter, startCmd, resumeCmd } = JSON.parse(body)
        if (!name || !startCmd || !resumeCmd) return json(res, { ok: false, error: { code: 'MISSING_FIELDS', message: 'name, startCmd, and resumeCmd are required' } }, 400)

        // Check if template exists in merged config (includes defaults)
        const existsInMerged = cfg.cliTemplates.some(t => t.name === oldName)
        if (!existsInMerged) return json(res, { ok: false, error: { code: 'NOT_FOUND', message: `Template "${oldName}" not found` } }, 404)

        let data: Record<string, unknown> = {}
        try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no config */ }
        const templates: Array<{ name: string; icon?: string; adapter?: string; startCmd: string; resumeCmd: string }> = Array.isArray(data.cliTemplates) ? data.cliTemplates : []
        const entry = { name, startCmd, resumeCmd, ...(icon ? { icon } : {}), ...(adapter ? { adapter } : {}) }
        const idx = templates.findIndex(t => t.name === oldName)
        if (idx >= 0) {
          templates[idx] = entry
        } else {
          // Template exists as a default — add override to user config
          templates.push(entry)
        }
        data.cliTemplates = templates
        writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
        json(res, { ok: true, data: entry })
      }).catch(() => json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400))
      return true
    }

    // DELETE /api/cli-templates/:name — remove a CLI template
    if (method === 'DELETE' && url.startsWith('/api/cli-templates/')) {
      const name = decodeURIComponent(url.slice('/api/cli-templates/'.length))
      let data: Record<string, unknown> = {}
      try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no config */ }
      const templates: Array<{ name: string }> = Array.isArray(data.cliTemplates) ? data.cliTemplates : []
      const idx = templates.findIndex(t => t.name === name)
      if (idx === -1) return json(res, { ok: false, error: { code: 'NOT_FOUND', message: `Template "${name}" not found` } }, 404), true
      templates.splice(idx, 1)
      data.cliTemplates = templates
      writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
      json(res, { ok: true })
      return true
    }

    // GET /api/patterns
    if (method === 'GET' && url === '/api/patterns') {
      const patterns = discoverPatterns()
      // Return pattern info with session details for UI
      const data = patterns.map(p => ({
        name: p.name,
        description: p.description,
        sessions: p.sessions.map(s => ({
          role: s.role,
          cliTemplate: s.config.cliTemplate,
          backend: s.config.backend,
          worktree: s.config.worktree,
        })),
      }))
      return json(res, { ok: true, data })
    }

    // GET /api/hands
    if (method === 'GET' && url === '/api/hands') {
      const hands = discoverHands()
      const data = hands.map(h => ({
        name: h.name,
        description: h.description,
        cliTemplate: h.cliTemplate,
      }))
      return json(res, { ok: true, data })
    }

    // GET /api/docker/profiles — configured image profiles (read from disk for freshness)
    if (method === 'GET' && url === '/api/docker/profiles') {
      let profiles = cfg.profiles
      try {
        const data = JSON.parse(readFileSync(cfg.files.config, 'utf-8'))
        if (Array.isArray(data.profiles)) profiles = data.profiles
      } catch { /* use frozen default */ }
      json(res, { ok: true, data: profiles })
      return true
    }

    // GET /api/docker/images — list local Docker images
    if (method === 'GET' && url === '/api/docker/images') {
      import('node:child_process').then(({ execFile }) => {
        execFile('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf-8' }, (err, stdout) => {
          if (err) {
            json(res, { ok: false, error: { code: 'DOCKER_ERROR', message: err.message } }, 500)
            return
          }
          const images = stdout.trim().split('\n').filter(Boolean).filter(i => i !== '<none>:<none>')
          json(res, { ok: true, data: images })
        })
      })
      return true
    }

    // POST /api/docker/profiles — add a new image profile
    if (method === 'POST' && url === '/api/docker/profiles') {
      readBody(req).then((body) => {
        const { name, image, home } = JSON.parse(body)
        if (!name || !image) return json(res, { ok: false, error: { code: 'MISSING_FIELDS', message: 'name and image are required' } }, 400)

        // Read current config, update profiles array, persist
        let data: Record<string, unknown> = {}
        try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no config yet */ }
        const profiles: Array<{ name: string; image: string; home?: string }> = Array.isArray(data.profiles) ? data.profiles : []
        if (profiles.some(p => p.name === name)) return json(res, { ok: false, error: { code: 'DUPLICATE', message: `Profile "${name}" already exists` } }, 409)

        const profile: { name: string; image: string; home?: string } = { name, image }
        if (home) profile.home = home
        profiles.push(profile)
        data.profiles = profiles
        writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
        json(res, { ok: true, data: profile })
      }).catch(() => json(res, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400))
      return true
    }

    // DELETE /api/docker/profiles/:name — remove an image profile
    if (method === 'DELETE' && url.startsWith('/api/docker/profiles/')) {
      const name = decodeURIComponent(url.slice('/api/docker/profiles/'.length))
      let data: Record<string, unknown> = {}
      try { data = JSON.parse(readFileSync(cfg.files.config, 'utf-8')) } catch { /* no config */ }
      const profiles: Array<{ name: string; image: string; home?: string }> = Array.isArray(data.profiles) ? data.profiles : []
      const idx = profiles.findIndex(p => p.name === name)
      if (idx === -1) return json(res, { ok: false, error: { code: 'NOT_FOUND', message: `Profile "${name}" not found` } }, 404), true
      profiles.splice(idx, 1)
      data.profiles = profiles
      writeFileSync(cfg.files.config, JSON.stringify(data, null, 2))
      json(res, { ok: true })
      return true
    }

    // --- Projects ---

    // GET /api/projects
    if (method === 'GET' && url === '/api/projects') {
      json(res, { ok: true, data: listProjects(cfg.files.projects) })
      return true
    }

    // POST /api/projects
    if (method === 'POST' && url === '/api/projects') {
      readBody(req).then((body) => {
        const { name, path } = JSON.parse(body)
        if (!name || !path) return json(res, { ok: false, error: { code: 'MISSING_FIELDS', message: 'Name and path required' } }, 400)
        registerProject(cfg.files.projects, name, path)
        json(res, { ok: true }, 201)
      })
      return true
    }

    // GET /api/projects/:name/worktrees
    if (method === 'GET' && url.includes('/worktrees') && url.startsWith('/api/projects/')) {
      const rest = url.slice('/api/projects/'.length)
      const name = rest.split('/')[0]
      if (name) {
        const projectPath = getProject(cfg.files.projects, name)
        if (!projectPath) {
          json(res, { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: `Project '${name}' not found` } }, 404)
        } else {
          listWorktrees(projectPath)
            .then(wts => json(res, { ok: true, data: wts }))
            .catch(err => json(res, { ok: false, error: { code: 'WORKTREE_LIST_FAILED', message: (err as Error).message } }, 500))
        }
        return true
      }
    }

    // DELETE /api/projects/:name
    if (method === 'DELETE' && url.startsWith('/api/projects/')) {
      const name = url.slice('/api/projects/'.length)
      if (name) {
        const removed = unregisterProject(cfg.files.projects, name)
        if (!removed) {
          json(res, { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: `Project '${name}' not found` } }, 404)
        } else {
          json(res, { ok: true })
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
        json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `Session '${sessionId}' not found` } }, 404)
        return true
      }
      readBody(req).then(async (body) => {
        const { text, force } = JSON.parse(body) as { text: string; force?: boolean }
        if (!force && session.state !== 'idle') {
          json(res, { error: 'session-not-ready' }, 400)
          return
        }
        if (!text) { json(res, { error: 'missing text' }, 400); return }
        try {
          if (session.backend === 'docker') {
            await dockerBackend.sendPrompt(cfg, sessionId, text)
          } else if (session.backend === 'tmux') {
            await tmuxBackend.sendPrompt(cfg, sessionId, text)
          } else {
            json(res, { error: 'input-unavailable' }, 503)
            return
          }
          json(res, { ok: true })
        } catch (err) {
          json(res, { error: (err as Error).message }, 500)
        }
      })
      return true
    }
  }

  // POST /api/dev/restart — rebuild and restart the server
  if (method === 'POST' && url === '/api/dev/restart') {
    // process.cwd() is the project root — tinstar is always launched from there
    const projectRoot = process.cwd()
    const portArgs = process.argv.slice(2)
    const portIdx = portArgs.indexOf('--port')
    const port = portIdx !== -1 ? portArgs[portIdx + 1] : '5273'

    json(res, { ok: true, message: 'Rebuilding and restarting...' })
    log.info('dev', `restart requested — rebuilding in ${projectRoot} then starting on port ${port}`)

    // Spawn a detached process that waits for us to die, rebuilds, and restarts
    const child = spawn('bash', ['-c',
      `sleep 1 && npm run build:all && node bin/tinstar.js --no-open --port ${port}`,
    ], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    // Give the response time to flush, then exit
    setTimeout(() => process.exit(0), 200)
    return true
  }

  return false
}

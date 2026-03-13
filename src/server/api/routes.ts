import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { log } from '../logger'
import type { DocumentStore } from '../stores/document-store'
import type { OTelStore } from '../stores/otel-store'
import type { SSEBroadcaster } from './sse'
import type { EventBus } from '../event-bus'
import type { TinstarConfig } from '../sessions/config'
import type { Session } from '../sessions/session'
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listSessions,
  setState,
  claudeStateDir,
  getProject,
  listProjects,
  registerProject,
  unregisterProject,
  createWorktree,
  deleteWorktree,
  listWorktrees,
  reconcileSessionStates,
  loadSecrets,
  dockerBackend,
  tmuxBackend,
  addRoute,
  removeRoute,
} from '../sessions'
import { resolveEntitySettings } from '../sessions/entity-settings'
import { parseNewEntries } from '../sessions/transcript-parser'
import { getGitDiffFiles } from '../sessions/git-diff'
import type { EntitySettings, GroupingDimension, Run } from '../../domain/types'
import { saveActiveSpaceId } from '../sessions/config'
import type { FileKind, TouchedFile } from '../../types'

function inferFileKind(filePath: string): FileKind {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const name = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (name.includes('.test.') || name.includes('.spec.') || name.startsWith('test_') || filePath.includes('__tests__') || filePath.includes('/e2e/')) return 'test'
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'].includes(ext)) return 'script'
  if (['md', 'txt', 'rst', 'adoc'].includes(ext)) return 'doc'
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'cfg', 'conf'].includes(ext) || name.startsWith('.')) return 'config'
  return 'code'
}

export interface RouteContext {
  docStore: DocumentStore
  otelStore: OTelStore
  sse: SSEBroadcaster
  bus: EventBus
  startSimulator: () => void
  resetSimulator: () => void
  sessionConfig: TinstarConfig | null
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(data))
}

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
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

export function handleRequest(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): boolean {
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

  // GET /api/state
  if (method === 'GET' && url === '/api/state') {
    json(res, ctx.docStore.snapshot())
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
      const { name, color, status, summary } = JSON.parse(body)
      const entity = {
        id: shortId('init'),
        name: name ?? 'Untitled Initiative',
        color: color ?? '#00f0ff',
        status: status ?? 'active',
        summary: summary ?? '',
        spaceId: ctx.docStore.activeSpaceId,
      }
      ctx.docStore.upsertInitiative(entity.id, entity)
      json(res, entity, 201)
    })
    return true
  }

  // POST /api/epics
  if (method === 'POST' && url === '/api/epics') {
    readBody(req).then(body => {
      const { name, initiativeId, status, summary } = JSON.parse(body)
      const entity = {
        id: shortId('epic'),
        name: name ?? 'Untitled Epic',
        initiativeId: initiativeId ?? '',
        status: status ?? 'active',
        summary: summary ?? '',
        spaceId: ctx.docStore.activeSpaceId,
      }
      ctx.docStore.upsertEpic(entity.id, entity)
      json(res, entity, 201)
    })
    return true
  }

  // POST /api/tasks
  if (method === 'POST' && url === '/api/tasks') {
    readBody(req).then(body => {
      const { name, epicId, initiativeId, status, summary } = JSON.parse(body)
      const entity = {
        id: shortId('task'),
        name: name ?? 'Untitled Task',
        epicId: epicId ?? '',
        initiativeId: initiativeId ?? '',
        status: status ?? 'active',
        summary: summary ?? '',
        spaceId: ctx.docStore.activeSpaceId,
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

  // GET /api/initiatives/:id/settings
  if (method === 'GET' && /^\/api\/initiatives\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/initiatives/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'initiative', ctx.docStore)
    if (!result) return json(res, { error: 'not found' }, 404)
    json(res, { ok: true, data: result })
    return true
  }

  // GET /api/epics/:id/settings
  if (method === 'GET' && /^\/api\/epics\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/epics/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'epic', ctx.docStore)
    if (!result) return json(res, { error: 'not found' }, 404)
    json(res, { ok: true, data: result })
    return true
  }

  // GET /api/tasks/:id/settings
  if (method === 'GET' && /^\/api\/tasks\/[^/]+\/settings$/.test(url)) {
    const id = url.slice('/api/tasks/'.length, url.lastIndexOf('/settings'))
    const result = resolveEntitySettings(id, 'task', ctx.docStore)
    if (!result) return json(res, { error: 'not found' }, 404)
    json(res, { ok: true, data: result })
    return true
  }

  // PATCH /api/initiatives/:id
  if (method === 'PATCH' && url.startsWith('/api/initiatives/')) {
    const id = url.slice('/api/initiatives/'.length)
    readBody(req).then(body => {
      const existing = ctx.docStore.getInitiative(id)
      if (!existing) return json(res, { error: 'not found' }, 404)
      const patch = JSON.parse(body)
      const merged = deepMergeEntity(existing, patch)
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
      const patch = JSON.parse(body)
      const merged = deepMergeEntity(existing, patch)
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
      const patch = JSON.parse(body)
      const merged = deepMergeEntity(existing, patch)
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

  // --- Session management routes (only active when sessionConfig is set) ---

  if (ctx.sessionConfig) {
    const cfg = ctx.sessionConfig
    const sessDir = cfg.dirs.sessions
    const secrets = () => loadSecrets(cfg.dirs.secrets)
    const dashboardUrl = `http://localhost:${process.env.TINSTAR_DASHBOARD_PORT ?? 5273}`

    function emitSessionEvent(type: 'managed_session.created' | 'managed_session.state_changed' | 'managed_session.deleted', payload: Record<string, unknown>) {
      ctx.bus.emit({ type, timestamp: new Date().toISOString(), payload } as Parameters<typeof ctx.bus.emit>[0])
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
        const { name, backend = 'docker', project, worktree = false, worktreePath, profile, prompt, oneshot = false, skipPermissions = true, taskId, epicId, initiativeId } = JSON.parse(body)
        log.info('sessions', `creating session: ${name}`, { backend, project, worktree, oneshot, taskId, epicId, initiativeId })

        if (!name) return json(res, { ok: false, error: { code: 'MISSING_NAME', message: 'Session name is required' } }, 400)
        if (!['docker', 'tmux'].includes(backend)) return json(res, { ok: false, error: { code: 'INVALID_BACKEND', message: 'Backend must be "docker" or "tmux"' } }, 400)
        if (oneshot && !prompt) return json(res, { ok: false, error: { code: 'MISSING_PROMPT', message: 'oneshot sessions require a prompt' } }, 400)
        if (oneshot && backend !== 'docker') return json(res, { ok: false, error: { code: 'INVALID_BACKEND', message: 'oneshot is only supported for docker backend' } }, 400)

        if (getSession(sessDir, name)) {
          return json(res, { ok: false, error: { code: 'SESSION_EXISTS', message: `Session '${name}' already exists` } }, 409)
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
          } else if (worktree && projectPath) {
            workspacePath = await createWorktree(projectPath, name)
            branch = name
          }

          const isWorktree = !!(worktreePath || worktree)

          const session = createSession(sessDir, {
            name,
            backend,
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
                console.log(`[oneshot] ${name} exited (code ${exitCode})`)
              },
            })
            updateSession(sessDir, name, { state: 'running' })
          } else if (backend === 'docker') {
            sessionPort = await tmuxBackend.findPort(cfg.ports.hostStart)
            await dockerBackend.createContainer(cfg, { session: enriched, secrets: sec, port: sessionPort, dashboardUrl })
            updateSession(sessDir, name, { port: sessionPort, state: 'running' })
          } else {
            const port = await tmuxBackend.findPort(cfg.ports.hostStart)
            if (prompt) enriched.initialPrompt = prompt

            // Install state-detection hooks for tmux sessions
            if (session.workspace?.path) {
              await tmuxBackend.installHooks(session.workspace.path, session.name, dashboardUrl)
            }

            const result = await tmuxBackend.createTmuxSession(cfg, { session: enriched, secrets: sec, port })
            sessionPort = result.port
            updateSession(sessDir, name, { port: sessionPort, ttydPid: result.ttydPid ?? null, state: 'running' })
            tmuxBackend.onTtydRestart(name, (newPid) => {
              updateSession(sessDir, name, { ttydPid: newPid })
            })
          }

          const updated = getSession(sessDir, name)

          // Create a Run in the document store so it appears on the canvas
          // Start as 'creating' — hooks will update to 'running'/'idle' once Claude is live
          const runId = name
          ctx.docStore.upsertRun(runId, {
            id: runId,
            status: 'creating',
            sessionId: name,
            initiative: initiativeId ?? '',
            epic: epicId ?? '',
            task: taskId ?? '',
            repo: project ?? '',
            worktree: isWorktree ? name : '',
            touchedFiles: [],
            recapEntries: [],
            rawLogs: '',
            procedures: [],
            port: sessionPort ?? null,
            backend,
            taskId: taskId ?? '',
            worktreeId: '',
            createdAt: new Date().toISOString(),
            spaceId: ctx.docStore.activeSpaceId,
          })

          // Register Caddy route for terminal proxy
          if (sessionPort) {
            addRoute(name, sessionPort, cfg.caddy.adminPort).catch(err => {
              log.warn('sessions', `caddy addRoute failed for ${name}: ${(err as Error).message}`)
            })
          }

          emitSessionEvent('managed_session.created', { name, state: 'running' })
          log.info('sessions', `session created: ${name}`, { backend, port: sessionPort, state: 'running' })

          if (prompt && backend === 'docker' && !oneshot) {
            setTimeout(async () => {
              try {
                await dockerBackend.sendPrompt(cfg, name, prompt)
              } catch (err) {
                log.error('sessions', `failed to send initial prompt to ${name}`, { error: (err as Error).message })
              }
            }, 5000)
          }

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
              const result = await tmuxBackend.startTmuxSession(cfg, { session, secrets: sec, port })
              updateSession(sessDir, session.name, { port: result.port, ttydPid: result.ttydPid ?? null })
              tmuxBackend.onTtydRestart(session.name, (newPid) => {
                updateSession(sessDir, session.name, { ttydPid: newPid })
              })
              if (session.workspace?.path) {
                await tmuxBackend.installHooks(session.workspace.path, session.name, dashboardUrl)
              }
            }

            // Re-read session to get updated port
            const updated = getSession(sessDir, session.name)
            const resumePort = updated?.port ?? session.port
            if (resumePort) {
              addRoute(session.name, resumePort, cfg.caddy.adminPort).catch(() => {})
            }

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

        // Respond immediately — UI removal is instant
        ctx.docStore.deleteRun(name)
        emitSessionEvent('managed_session.deleted', { name })
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

              if (session.backend === 'tmux' && session.workspace?.path) {
                try { await tmuxBackend.removeHooks(session.workspace.path) } catch { /* best effort */ }
              }

              if (session.workspace?.worktree && session.workspace?.basePath) {
                await deleteWorktree(session.workspace.basePath, session.name)
              }

              removeRoute(session.name, cfg.caddy.adminPort).catch(() => {})
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

    // POST /api/sessions/:name/refresh-route — re-register Caddy route for a session
    if (method === 'POST' && url.endsWith('/refresh-route') && url.startsWith('/api/sessions/')) {
      const name = extractSessionName(url, '/api/sessions/')
      if (name) {
        const session = getSession(sessDir, name)
        if (!session?.port) {
          json(res, { ok: false, error: { code: 'NO_PORT', message: 'Session has no port' } }, 400)
        } else {
          addRoute(name, session.port, cfg.caddy.adminPort)
            .then(() => json(res, { ok: true }))
            .catch(() => json(res, { ok: true })) // route may already exist
        }
        return true
      }
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

    // --- Hooks (called by Claude Code inside sessions) ---

    // POST /api/hooks/idle
    if (method === 'POST' && url === '/api/hooks/idle') {
      readBody(req).then((body) => {
        const { session: name, conversationId } = JSON.parse(body)
        if (!name) return json(res, { ok: false, error: { code: 'MISSING_SESSION', message: 'Session name required' } }, 400)

        setState(sessDir, name, 'idle')
        ctx.docStore.updateRunStatus(name, 'idle')
        emitSessionEvent('managed_session.state_changed', { name, state: 'idle' })
        json(res, { ok: true })

        // Async transcript parsing (fire-and-forget, after response)
        try {
          const session = getSession(sessDir, name)
          const workdir = session?.workspace?.path
          // Use conversationId from hook payload, or fall back to session file
          const convId = conversationId || session?.conversation?.id
          if (workdir && convId) {
            // Docker sessions store claude-state in the session's state dir
            const stateDir = session?.backend === 'docker'
              ? join(sessDir, name, 'claude-state')
              : undefined
            const entries = parseNewEntries(name, workdir, convId, stateDir)
            for (const entry of entries) {
              ctx.docStore.addRecapEntry(name, entry)
            }
          }
        } catch (err) {
          log.warn('transcript-parse', `Failed to parse transcript for ${name}: ${err}`)
        }
      })
      return true
    }

    // POST /api/hooks/active
    if (method === 'POST' && url === '/api/hooks/active') {
      readBody(req).then((body) => {
        const { session: name } = JSON.parse(body)
        if (!name) return json(res, { ok: false, error: { code: 'MISSING_SESSION', message: 'Session name required' } }, 400)

        const prev = getSession(sessDir, name)
        setState(sessDir, name, 'running')
        ctx.docStore.updateRunStatus(name, 'running')
        if (!prev || prev.state !== 'running') {
          emitSessionEvent('managed_session.state_changed', { name, state: 'running' })
        }
        json(res, { ok: true })
      })
      return true
    }

    // POST /api/hooks/file-touched
    if (method === 'POST' && url === '/api/hooks/file-touched') {
      readBody(req).then(async (body) => {
        const { session: name } = JSON.parse(body)
        if (!name) return json(res, { ok: false, error: { code: 'MISSING_SESSION', message: 'Session name required' } }, 400)

        // Respond immediately, then reconcile git state async
        json(res, { ok: true })

        // Reconcile: get real git diff stats for the session's workdir
        try {
          const session = getSession(sessDir, name)
          const workdir = session?.workspace?.path
          if (workdir) {
            const files = await getGitDiffFiles(workdir)
            ctx.docStore.reconcileFiles(name, files)
          }
        } catch (err) {
          log.warn('file-touched', `git diff failed for ${name}: ${(err as Error).message}`)
        }
      })
      return true
    }

    // POST /api/hooks/file-read — record a read-only file access (no git diff trigger)
    if (method === 'POST' && url === '/api/hooks/file-read') {
      readBody(req).then((body) => {
        const { session: name, path: filePath } = JSON.parse(body)
        if (!name || !filePath) return json(res, { ok: true })

        const fileName = filePath.split('/').pop() ?? filePath
        const kind = inferFileKind(filePath)
        const file: TouchedFile = {
          id: filePath,
          name: fileName,
          path: filePath,
          additions: 0,
          deletions: 0,
          kind,
          readOnly: true,
        }
        ctx.docStore.addFileTouched(name, file)
        json(res, { ok: true })
      })
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
  }

  return false
}

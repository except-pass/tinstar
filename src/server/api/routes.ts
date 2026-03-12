import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
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
import type { EntitySettings, GroupingDimension } from '../../domain/types'
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
    if (method === 'GET' && url.startsWith('/api/sessions/') && !url.includes('/start') && !url.includes('/stop')) {
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
        (async () => {
          const session = getSession(sessDir, name)
          if (!session) return json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `Session '${name}' not found` } }, 404)

          try {
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

            // Remove Caddy route
            removeRoute(session.name, cfg.caddy.adminPort).catch(() => {})

            deleteSession(sessDir, session.name)
            ctx.docStore.deleteRun(session.name)
            emitSessionEvent('managed_session.deleted', { name: session.name })
            json(res, { ok: true })
          } catch (err) {
            json(res, { ok: false, error: { code: 'DELETE_FAILED', message: (err as Error).message } }, 500)
          }
        })()
        return true
      }
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
        if (conversationId) {
          try {
            const session = getSession(sessDir, name)
            const workdir = session?.workspace?.path
            if (workdir) {
              const entries = parseNewEntries(name, workdir, conversationId)
              for (const entry of entries) {
                ctx.docStore.addRecapEntry(name, entry)
              }
            }
          } catch (err) {
            log.warn('transcript-parse', `Failed to parse transcript for ${name}: ${err}`)
          }
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
      readBody(req).then((body) => {
        const { session: name, path: filePath } = JSON.parse(body)
        if (!name) return json(res, { ok: false, error: { code: 'MISSING_SESSION', message: 'Session name required' } }, 400)
        if (!filePath) return json(res, { ok: true }) // no path, nothing to do

        const fileName = filePath.split('/').pop() ?? filePath
        const kind = inferFileKind(filePath)
        const file: TouchedFile = {
          id: filePath,
          name: fileName,
          path: filePath,
          additions: 0,
          deletions: 0,
          kind,
          pending: true,
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

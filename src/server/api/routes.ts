import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
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
  ensureResumeReady,
  reconcileSessionStates,
  loadSecrets,
  dockerBackend,
  tmuxBackend,
} from '../sessions'

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
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

  // --- Session management routes (only active when sessionConfig is set) ---

  if (ctx.sessionConfig) {
    const cfg = ctx.sessionConfig
    const sessDir = cfg.dirs.sessions
    const secrets = () => loadSecrets(cfg.dirs.secrets)
    const dashboardUrl = `http://localhost:${5173}` // Vite dev port; overridden via env in prod

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
        const { name, backend = 'docker', project, worktree = false, worktreePath, profile, prompt, oneshot = false, skipPermissions = true } = JSON.parse(body)

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
          emitSessionEvent('managed_session.created', { name, state: 'running' })

          if (prompt && backend === 'docker' && !oneshot) {
            setTimeout(async () => {
              try {
                await dockerBackend.sendPrompt(cfg, name, prompt)
              } catch (err) {
                console.error(`Failed to send initial prompt to ${name}:`, (err as Error).message)
              }
            }, 5000)
          }

          json(res, { ok: true, data: updated }, 201)
        } catch (err) {
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
            ensureResumeReady(sessDir, session.name, claudeStateDir(sessDir, session.name))

            if (session.backend === 'docker') {
              await dockerBackend.stopContainer(cfg, session)
            } else {
              await tmuxBackend.stopTmuxSession(cfg, session)
              if (session.port) tmuxBackend.releasePort(session.port)
            }

            setState(sessDir, session.name, 'stopped')
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

          try {
            const enriched = session as Session & { _stateDir?: string }
            enriched._stateDir = claudeStateDir(sessDir, session.name)
            ensureResumeReady(sessDir, session.name, claudeStateDir(sessDir, session.name))
            // Re-read to pick up conversation ID
            Object.assign(session, getSession(sessDir, session.name))
            const sec = secrets()

            if (session.backend === 'docker') {
              const port = session.port ?? await tmuxBackend.findPort(cfg.ports.hostStart)
              await dockerBackend.startContainer(cfg, { session: enriched, secrets: sec, port, dashboardUrl })
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

            setState(sessDir, session.name, 'running')
            emitSessionEvent('managed_session.state_changed', { name: session.name, state: 'running' })
            json(res, { ok: true, data: getSession(sessDir, session.name) })
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

            deleteSession(sessDir, session.name)
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
        const { session: name } = JSON.parse(body)
        if (!name) return json(res, { ok: false, error: { code: 'MISSING_SESSION', message: 'Session name required' } }, 400)

        setState(sessDir, name, 'idle')
        emitSessionEvent('managed_session.state_changed', { name, state: 'idle' })
        json(res, { ok: true })
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
        if (!prev || prev.state !== 'running') {
          emitSessionEvent('managed_session.state_changed', { name, state: 'running' })
        }
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

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { fail, ok } from '../../api/envelope'
import { isRecord } from '../../../v6/contract/result'
import { defaultProjectionFile, readProjection, updateProjection, type StoredIdentity } from './projection'
import { resolveFmBinDir, resolveV6FmHome, type FmCommandRunner } from './fmExec'
import { listWorkerDescriptors, readTaskDescriptor } from './snapshot'
import { readReceipts, readReady, submitIntent } from './submitIntent'
import { descriptorChanged, proxyTerminalHttp, proxyTerminalUpgrade, V6Views } from './views'

const HEX_COLOR = /^#[0-9a-f]{6}$/
const WORKER_ID = /^[A-Za-z0-9._-]+$/

export interface V6RouteDeps {
  views: V6Views
  runner?: FmCommandRunner
  projectionFile?: string
  home?: string
  configured?: boolean
  binDir?: string | null
}

let viewsSingleton: V6Views | null = null
let depsOverride: Partial<V6RouteDeps> | null = null

export function setV6RouteDepsForTests(deps: Partial<V6RouteDeps> | null): void {
  depsOverride = deps
  if (deps?.views) viewsSingleton = deps.views
}

function views(): V6Views {
  if (depsOverride?.views) return depsOverride.views
  if (!viewsSingleton) viewsSingleton = new V6Views()
  return viewsSingleton
}

function projectionFile(): string {
  return depsOverride?.projectionFile ?? defaultProjectionFile()
}

function homeConfig(): { home: string; configured: boolean; binDir: string | null } {
  const resolved = resolveV6FmHome()
  return {
    home: depsOverride?.home ?? resolved.home,
    configured: depsOverride?.configured ?? resolved.configured,
    binDir: depsOverride && 'binDir' in depsOverride ? (depsOverride.binDir ?? null) : resolveFmBinDir(),
  }
}

export function isV6Path(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? ''
  return path === '/api/v6' || path.startsWith('/api/v6/') || path.startsWith('/s/v6term/')
}

function pathname(url: string): string {
  return url.split('?')[0] ?? url
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function jsonContent(req: IncomingMessage): boolean {
  const header = req.headers['content-type']
  const value = Array.isArray(header) ? header[0] : header
  return typeof value === 'string' && value.split(';')[0]?.trim() === 'application/json'
}

export async function handleV6Http(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '/'
  if (!isV6Path(url)) return false
  const path = pathname(url)
  const method = req.method ?? 'GET'

  if (method === 'OPTIONS' && path.startsWith('/api/v6')) {
    res.writeHead(204)
    res.end()
    return true
  }

  const term = path.match(/^\/s\/v6term\/([^/]+)(\/.*)?$/)
  if (term) {
    const workerId = decodeURIComponent(term[1]!)
    if (!WORKER_ID.test(workerId)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return true
    }
    const port = views().portOf(workerId)
    if (!port) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('terminal is not open')
      return true
    }
    proxyTerminalHttp(req, res, port, term[2] || '/')
    return true
  }

  try {
    if (method === 'GET' && path === '/api/v6/workers') return await getWorkers(res)
    if (method === 'GET' && path === '/api/v6/ready') return await getReady(res)
    if (method === 'POST' && path === '/api/v6/intents') return await postIntent(req, res)
    if (method === 'POST' && path === '/api/v6/identity') return await postIdentity(req, res)
    const intent = path.match(/^\/api\/v6\/intents\/([^/]+)$/)
    if (method === 'GET' && intent) return await getIntent(res, decodeURIComponent(intent[1]!))
    const terminal = path.match(/^\/api\/v6\/workers\/([^/]+)\/terminal$/)
    if (terminal && WORKER_ID.test(decodeURIComponent(terminal[1]!))) {
      const id = decodeURIComponent(terminal[1]!)
      if (method === 'POST') return await postTerminal(req, res, id)
      if (method === 'DELETE') {
        views().close(id)
        return ok(res, { closed: true, workerKilled: false })
      }
    }
  } catch (err) {
    if (err instanceof SyntaxError) return fail(res, 'BAD_REQUEST', 'Invalid JSON body')
    return fail(res, 'INTERNAL', (err as Error).message)
  }

  return fail(res, 'NOT_FOUND', 'not found')
}

export function handleV6Upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = req.url ?? '/'
  const term = pathname(url).match(/^\/s\/v6term\/([^/]+)(\/.*)?$/)
  if (!term) {
    socket.destroy()
    return
  }
  const workerId = decodeURIComponent(term[1]!)
  const port = WORKER_ID.test(workerId) ? views().portOf(workerId) : null
  if (!port) {
    socket.destroy()
    return
  }
  proxyTerminalUpgrade(req, socket, head, port, term[2] || '/')
}

async function getWorkers(res: ServerResponse): Promise<true> {
  const cfg = homeConfig()
  const list = await listWorkerDescriptors({
    home: cfg.home,
    configured: cfg.configured,
    binDir: cfg.binDir,
    runner: depsOverride?.runner,
  })
  const identities = readProjection(projectionFile()).identities
  return ok(res, {
    configured: list.configured,
    workers: list.workers,
    identities,
    diagnostics: list.diagnostics,
  })
}

async function getReady(res: ServerResponse): Promise<true> {
  const cfg = homeConfig()
  if (!cfg.configured || !cfg.binDir) {
    return ok(res, { canReceive: 'unknown', detail: 'First Mate home is not configured' })
  }
  const ready = await readReady({
    home: cfg.home,
    binDir: cfg.binDir,
    runner: depsOverride?.runner,
    projectionFile: projectionFile(),
  })
  return ok(res, ready)
}

async function postIntent(req: IncomingMessage, res: ServerResponse): Promise<true> {
  if (!jsonContent(req)) return fail(res, 'BAD_REQUEST', 'Content-Type must be application/json', { status: 415 })
  const raw = JSON.parse(await readBody(req)) as unknown
  const cfg = homeConfig()
  const submission = await submitIntent(raw, {
    home: cfg.configured ? cfg.home : '',
    binDir: cfg.binDir ?? '',
    runner: depsOverride?.runner,
    projectionFile: projectionFile(),
  })
  return ok(res, submission)
}

async function getIntent(res: ServerResponse, requestId: string): Promise<true> {
  const stored = readProjection(projectionFile()).intents[requestId] ?? null
  const cfg = homeConfig()
  if (!cfg.configured || !cfg.binDir) {
    return ok(res, { intent: stored, reply: null, applied: false })
  }
  const { reply } = await readReceipts({
    home: cfg.home,
    binDir: cfg.binDir,
    runner: depsOverride?.runner,
    projectionFile: projectionFile(),
  }, requestId)
  return ok(res, {
    intent: stored,
    reply,
    applied: reply?.appliedOutcome === 'applied',
  })
}

async function postIdentity(req: IncomingMessage, res: ServerResponse): Promise<true> {
  if (!jsonContent(req)) return fail(res, 'BAD_REQUEST', 'Content-Type must be application/json', { status: 415 })
  const raw = JSON.parse(await readBody(req)) as unknown
  if (!isRecord(raw) || typeof raw.id !== 'string' || !WORKER_ID.test(raw.id)) {
    return fail(res, 'BAD_REQUEST', 'id is required')
  }
  if (typeof raw.color !== 'string' || !HEX_COLOR.test(raw.color.toLowerCase())) {
    return fail(res, 'BAD_REQUEST', 'color must be a #rrggbb palette color')
  }
  if (raw.alias !== undefined && typeof raw.alias !== 'string') {
    return fail(res, 'BAD_REQUEST', 'alias must be a string')
  }
  const color = raw.color.toLowerCase()
  const alias = typeof raw.alias === 'string' ? raw.alias : undefined
  const identity = await updateProjection(projectionFile(), doc => {
    const existing = doc.identities[raw.id as string]
    const next: StoredIdentity = existing ? { color: existing.color } : { color }
    if (existing?.alias) next.alias = existing.alias
    if (alias !== undefined) {
      if (alias.trim()) next.alias = alias.trim()
      else delete next.alias
    }
    doc.identities[raw.id as string] = next
    return next
  })
  return ok(res, identity)
}

async function postTerminal(req: IncomingMessage, res: ServerResponse, id: string): Promise<true> {
  if (!jsonContent(req)) return fail(res, 'BAD_REQUEST', 'Content-Type must be application/json', { status: 415 })
  const raw = JSON.parse(await readBody(req)) as unknown
  if (!isRecord(raw) || !('spawnGen' in raw) || !('target' in raw)) {
    return ok(res, { state: 'unavailable', reason: 'the open request did not name the descriptor it showed' })
  }
  if (raw.spawnGen !== null && typeof raw.spawnGen !== 'string') {
    return ok(res, { state: 'unavailable', reason: 'spawnGen is not a string' })
  }
  if (raw.target !== null && typeof raw.target !== 'string') {
    return ok(res, { state: 'unavailable', reason: 'target is not a string' })
  }
  if ('command' in raw || 'shell' in raw) {
    return fail(res, 'BAD_REQUEST', 'command and shell fields are not accepted')
  }
  const cfg = homeConfig()
  if (!cfg.configured || !cfg.binDir) {
    return ok(res, { state: 'unavailable', reason: 'First Mate home is not configured' })
  }
  const fresh = await readTaskDescriptor({
    home: cfg.home,
    binDir: cfg.binDir,
    id,
    runner: depsOverride?.runner,
    fixture: process.env.TINSTAR_V6_FIXTURE === '1',
  })
  if (!fresh.taskSupported) {
    return ok(res, { state: 'unavailable', reason: 'snapshot --task is not available' })
  }
  if (!fresh.descriptor) {
    return ok(res, { state: 'unavailable', reason: fresh.diagnostic ?? 'worker is unavailable' })
  }
  if (descriptorChanged({ spawnGen: raw.spawnGen, target: raw.target }, fresh.descriptor)) {
    views().close(id)
    return ok(res, { state: 'unavailable', reason: 'worker changed or is unavailable' })
  }
  const opened = await views().open(fresh.descriptor)
  return ok(res, opened)
}

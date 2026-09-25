import type { IncomingMessage, ServerResponse } from 'node:http'
import { fail, ok } from '../../api/envelope'
import { readBody } from '../../api/readBody'
import { isRecord } from '../../../v6/contract/result'
import {
  resolveFmBinDir,
  resolveV6FmHome,
  type FmCommandRunner,
} from '../shell/fmExec'
import type { InboxClientOptions } from '../shell/submitIntent'
import {
  getThread,
  listThreads,
  postThreadMessage,
  projectionFileFor,
  refreshThreadReceipts,
  reportPresence,
  type ThreadResult,
  type ThreadServiceOptions,
} from './service'
import { defaultThreadStoreFile } from './store'

export interface ThreadListener {
  on(event: 'request', listener: (req: IncomingMessage, res: ServerResponse) => void): unknown
}

export interface ThreadRoutesOptions {
  storeFile?: string
  projectionFile?: string
  home?: string
  binDir?: string
  runner?: FmCommandRunner
  now?: () => string
  newThreadId?: () => string
  newRequestId?: () => string
  /**
   * When true (default), paths outside /api/v6/threads receive a JSON 404.
   * A shared server passes false and uses the boolean handler instead.
   */
  exclusive?: boolean
}

const PREFIX = '/api/v6/threads'

function serviceOptions(options: ThreadRoutesOptions): ThreadServiceOptions {
  const resolved = options.home ? { home: options.home, configured: true } : resolveV6FmHome()
  const binDir = options.binDir ?? resolveFmBinDir() ?? ''
  const inbox: InboxClientOptions = {
    home: resolved.configured ? resolved.home : '',
    binDir,
    projectionFile: projectionFileFor(options.projectionFile),
    runner: options.runner,
    now: options.now,
  }
  return {
    storeFile: options.storeFile ?? defaultThreadStoreFile(),
    inbox,
    now: options.now,
    newThreadId: options.newThreadId,
    newRequestId: options.newRequestId,
  }
}

function pathnameOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  return { path: url.pathname, query: url.searchParams }
}

function isJson(req: IncomingMessage): boolean {
  const value = req.headers['content-type']
  return typeof value === 'string' && value.toLowerCase().startsWith('application/json')
}

function sendResult(res: ServerResponse, result: ThreadResult): true {
  if (!result.ok) return fail(res, result.status, result.message)
  return ok(res, { thread: result.thread })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | string> {
  if (!isJson(req)) return 'Content-Type must be application/json'
  let text = ''
  try {
    text = await readBody(req)
  } catch (err) {
    return err instanceof Error ? err.message : 'body could not be read'
  }
  try {
    const raw = JSON.parse(text) as unknown
    if (!isRecord(raw)) return 'body must be a JSON object'
    return raw
  } catch {
    return 'body must be JSON'
  }
}

function splitIds(raw: string | null): string[] | null {
  if (!raw) return null
  const ids = raw.split(',').filter(part => part.length > 0)
  return ids.length > 0 ? ids : null
}

/**
 * Boolean handler for a shared server. Returns false when the path is not a thread route.
 * Every message is delivered by submitIntent.
 */
export function createThreadHandler(options: ThreadRoutesOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const opts = serviceOptions(options)
  return async (req, res) => {
    const method = req.method ?? 'GET'
    const { path, query } = pathnameOf(req)
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false

    if (method === 'GET' && path === PREFIX) {
      const ids = splitIds(query.get('ids'))
      sendResult(res, await listThreads(opts, query.get('type'), ids))
      return true
    }

    if (method === 'POST' && path === PREFIX) {
      const body = await readJson(req)
      if (typeof body === 'string') {
        fail(res, 'BAD_REQUEST', body)
        return true
      }
      sendResult(res, await postThreadMessage(opts, body))
      return true
    }

    if (method === 'POST' && path === `${PREFIX}/presence`) {
      const body = await readJson(req)
      if (typeof body === 'string') {
        fail(res, 'BAD_REQUEST', body)
        return true
      }
      sendResult(res, await reportPresence(opts, body))
      return true
    }

    const receipts = path.match(/^\/api\/v6\/threads\/([^/]+)\/receipts$/)
    if (method === 'POST' && receipts) {
      const id = decodeURIComponent(receipts[1] ?? '')
      sendResult(res, await refreshThreadReceipts(opts, id))
      return true
    }

    const presence = path.match(/^\/api\/v6\/threads\/([^/]+)\/presence$/)
    if (method === 'POST' && presence) {
      const body = await readJson(req)
      if (typeof body === 'string') {
        fail(res, 'BAD_REQUEST', body)
        return true
      }
      const id = decodeURIComponent(presence[1] ?? '')
      sendResult(res, await reportPresence(opts, { ...body, threadId: id }))
      return true
    }

    const one = path.match(/^\/api\/v6\/threads\/([^/]+)$/)
    if (method === 'GET' && one) {
      const id = decodeURIComponent(one[1] ?? '')
      if (id === 'presence') return false
      sendResult(res, await getThread(opts, id))
      return true
    }

    return false
  }
}

/** Attach thread routes to a throwaway listener. Tests call this, not a shared process. */
export function registerThreadRoutes(listener: ThreadListener, options: ThreadRoutesOptions = {}): void {
  const handle = createThreadHandler(options)
  const exclusive = options.exclusive !== false
  listener.on('request', (req, res) => {
    void handle(req, res).then(handled => {
      if (handled || res.headersSent) return
      if (exclusive) fail(res, 'NOT_FOUND', 'not found')
    }).catch((err: unknown) => {
      if (res.headersSent) return
      const message = err instanceof Error ? err.message : 'thread route failed'
      fail(res, 'INTERNAL', message)
    })
  })
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { getSession } from '../sessions/session'
import { fail } from './envelope'

interface Ctx { sessDir: string }

const URL_RE = /^\/api\/sessions\/([^/]+)\/files\/download\/?$/

function getSessionWorkspace(sessDir: string, name: string): string | null {
  return getSession(sessDir, name)?.workspace?.path ?? null
}

/**
 * GET /api/sessions/:name/files/download?path=<workspace-relative-file>
 *
 * Streams a single file as an attachment. Lives in its own handler (wired ahead
 * of handleRequest in standalone.ts) because the JSON GET /files listing route
 * matches any url containing '/files' — routing here first avoids that shadow,
 * and a raw stream can't use the ok()/fail() JSON envelope anyway.
 */
export async function handleFileDownload(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if (!req.url || req.method !== 'GET') return false
  const m = req.url.split('?')[0]!.match(URL_RE)
  if (!m || m[1] === undefined) return false

  const sessionName = decodeURIComponent(m[1])
  const wsRoot = getSessionWorkspace(ctx.sessDir, sessionName)
  if (!wsRoot) {
    fail(res, 'SESSION_NOT_FOUND', `Session '${sessionName}' not found`)
    return true
  }

  const params = new URL(req.url, 'http://localhost').searchParams
  const rel = params.get('path')
  if (!rel) {
    fail(res, 'INVALID_PARAMS', 'path is required')
    return true
  }

  const abs = resolve(wsRoot, rel)
  if (!abs.startsWith(wsRoot + '/') && abs !== wsRoot) {
    fail(res, 'PATH_OUTSIDE_WORKSPACE', 'Path escapes workspace')
    return true
  }

  let stat
  try {
    stat = statSync(abs)
  } catch {
    fail(res, 'NOT_FOUND', `'${rel}' not found`)
    return true
  }
  if (!stat.isFile()) {
    fail(res, 'INVALID_PARAMS', 'Path is not a file')
    return true
  }

  // Quote the filename and strip CR/LF to keep the header well-formed.
  const safeName = basename(abs).replace(/["\r\n]/g, '')
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${safeName}"`,
  })
  createReadStream(abs).pipe(res)
  return true
}

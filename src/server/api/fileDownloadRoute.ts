import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { resolveWorkspaceFile } from './workspaceFile'
import { fail } from './envelope'

interface Ctx { sessDir: string }

const URL_RE = /^\/api\/sessions\/([^/]+)\/files\/download\/?$/

/**
 * GET /api/sessions/:name/files/download?path=<workspace-relative-file>
 *
 * Streams a single file as an attachment. Lives in its own handler (wired ahead
 * of handleRequest in standalone.ts) because the JSON GET /files listing route
 * matches any url containing '/files' — routing here first avoids that shadow,
 * and a raw stream can't use the ok()/fail() JSON envelope anyway.
 *
 * Path resolution + the workspace-containment guard are shared with the
 * file-push route via resolveWorkspaceFile().
 */
export async function handleFileDownload(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if (!req.url || req.method !== 'GET') return false
  const m = req.url.split('?')[0]!.match(URL_RE)
  if (!m || m[1] === undefined) return false

  const sessionName = decodeURIComponent(m[1])
  const rel = new URL(req.url, 'http://localhost').searchParams.get('path')

  const resolved = resolveWorkspaceFile(ctx.sessDir, sessionName, rel)
  if (!resolved.ok) {
    fail(res, resolved.code, resolved.message)
    return true
  }

  // Quote the filename and strip CR/LF to keep the header well-formed.
  const safeName = resolved.filename.replace(/["\r\n]/g, '')
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': resolved.size,
    'Content-Disposition': `attachment; filename="${safeName}"`,
  })
  // pipe() doesn't forward source errors; without this an open/read failure
  // after writeHead (file deleted between stat and open, or EACCES) escalates to
  // uncaughtException and leaves the client hanging on already-sent 200 headers.
  createReadStream(resolved.abs).on('error', () => res.destroy()).pipe(res)
  return true
}

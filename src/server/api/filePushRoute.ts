import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SSEBroadcaster } from './sse'
import { resolveWorkspaceFile } from './workspaceFile'
import { readBody } from './readBody'
import { ok, fail } from './envelope'

interface Ctx { sessDir: string; sse: SSEBroadcaster }

const URL_RE = /^\/api\/sessions\/([^/]+)\/files\/push-download\/?$/

/**
 * POST /api/sessions/:name/files/push-download   body: { path }
 *
 * Pushes a workspace file to every connected dashboard so the browser
 * auto-downloads it. This handler only *announces* — it validates the path with
 * the shared workspace guard, then broadcasts a `download:push` SSE event
 * carrying the URL of the existing GET .../files/download route, which streams
 * the actual bytes. Returns a synchronous ok()/fail() so the calling agent
 * learns immediately whether the push was accepted.
 *
 * Wired ahead of handleRequest in standalone.ts (like handleFileDownload), but
 * additionally given the SSEBroadcaster to broadcast with.
 */
export async function handleFilePush(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if (!req.url || req.method !== 'POST') return false
  const m = req.url.split('?')[0]!.match(URL_RE)
  if (!m || m[1] === undefined) return false

  const sessionName = decodeURIComponent(m[1])

  // Reuse the shared readBody helper (5s read timeout + 1MB cap + decode-once)
  // rather than hand-rolling body reading.
  let body: unknown
  try {
    const raw = await readBody(req)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    fail(res, 'BAD_REQUEST', 'Invalid or oversized JSON body')
    return true
  }
  const rel = body && typeof (body as { path?: unknown }).path === 'string'
    ? (body as { path: string }).path
    : null

  const resolved = resolveWorkspaceFile(ctx.sessDir, sessionName, rel)
  if (!resolved.ok) {
    fail(res, resolved.code, resolved.message)
    return true
  }

  // Point at the existing download route; encode both segments so names/paths
  // with spaces or special chars produce a valid link (the download route
  // decodeURIComponent()s the session name and reads `path` via URLSearchParams).
  const url = `/api/sessions/${encodeURIComponent(sessionName)}/files/download?path=${encodeURIComponent(resolved.rel)}`
  ctx.sse.broadcastEvent('download:push', { url, filename: resolved.filename })

  ok(res, { pushed: true, filename: resolved.filename })
  return true
}

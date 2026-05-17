import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadServerPrefs, saveServerPrefs } from '../serverPrefs'

interface Ctx { configRoot: string }

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

function json(res: ServerResponse, payload: unknown, status = 200) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

export async function handleServerPrefs(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if (!req.url || !req.url.startsWith('/api/server-prefs')) return false

  if (req.method === 'GET') {
    json(res, { ok: true, data: loadServerPrefs(ctx.configRoot) })
    return true
  }

  if (req.method === 'PUT') {
    const raw = await readBody(req)
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      json(res, { ok: false, error: { code: 'INVALID_JSON', message: 'Body must be JSON' } }, 400)
      return true
    }
    try {
      const merged = saveServerPrefs(ctx.configRoot, parsed as Partial<{ uploadMaxBytes: number }>)
      json(res, { ok: true, data: merged })
    } catch (err) {
      json(res, { ok: false, error: { code: 'INVALID_PREFS', message: (err as Error).message } }, 400)
    }
    return true
  }

  json(res, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: req.method } }, 405)
  return true
}

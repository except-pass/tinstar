import type { IncomingMessage, ServerResponse } from 'node:http'
import { readPluginsConfig } from '../../core/pluginHost/pluginsConfig'
import { writePluginsConfig } from '../../core/pluginHost/writePluginsConfig'
import { invalidateWidgetRegistryCache } from './pluginWidgetRegistry'

export interface PluginsConfigRouteOptions { configRoot: string }

export async function handlePluginsConfig(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PluginsConfigRouteOptions,
): Promise<boolean> {
  if (req.url !== '/api/plugins-config') return false

  if (req.method === 'GET') {
    try {
      const cfg = readPluginsConfig(opts.configRoot)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(cfg))
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[plugin-host] /api/plugins-config GET failed', e)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'config read failed' }))
    }
    return true
  }

  if (req.method === 'PUT') {
    let body: string
    try { body = await readBody(req) }
    catch (e) {
      res.statusCode = 400
      res.end(`body read failed: ${e instanceof Error ? e.message : 'unknown'}`)
      return true
    }
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch {
      res.statusCode = 400
      res.end('malformed JSON')
      return true
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      res.statusCode = 400
      res.end('expected an object')
      return true
    }
    const obj = parsed as Record<string, unknown>
    const disabled = Array.isArray(obj.disabled)
      ? obj.disabled.filter((x): x is string => typeof x === 'string')
      : []
    const external = Array.isArray(obj.external)
      ? obj.external.filter((e): e is { name: string; path?: string; npm?: string } => {
          if (!e || typeof e !== 'object') return false
          const r = e as Record<string, unknown>
          return typeof r.name === 'string' && r.name !== '' && (typeof r.path === 'string' || typeof r.npm === 'string')
        })
      : []
    try {
      writePluginsConfig(opts.configRoot, { disabled, external })
      invalidateWidgetRegistryCache()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[plugin-host] /api/plugins-config PUT write failed', e)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'config write failed' }))
      return true
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ disabled, external }))
    return true
  }

  res.statusCode = 405
  res.end('method not allowed')
  return true
}

const MAX_BODY_BYTES = 1_000_000  // 1MB — plugins.json is tiny
const READ_TIMEOUT_MS = 5_000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      try { req.destroy() } catch { /* ignore */ }
      reject(new Error('body read timeout'))
    }, READ_TIMEOUT_MS)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer)
        try { req.destroy() } catch { /* ignore */ }
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

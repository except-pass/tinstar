import type { IncomingMessage, ServerResponse } from 'node:http'
import { readPluginsConfig } from '../../core/pluginHost/pluginsConfig'
import { writePluginsConfig } from '../../core/pluginHost/writePluginsConfig'

export interface PluginsConfigRouteOptions { configRoot: string }

export async function handlePluginsConfig(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PluginsConfigRouteOptions,
): Promise<boolean> {
  if (req.url !== '/api/plugins-config') return false

  if (req.method === 'GET') {
    const cfg = readPluginsConfig(opts.configRoot)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(cfg))
    return true
  }

  if (req.method === 'PUT') {
    const body = await readBody(req)
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
    writePluginsConfig(opts.configRoot, { disabled, external })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ disabled, external }))
    return true
  }

  res.statusCode = 405
  res.end('method not allowed')
  return true
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

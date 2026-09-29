import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CcQuotaService } from '../cc-quota/service'
import type { ProviderCurrentObservationStores } from '../providers/observation-stores'
import { getReachCoordinator } from '../reach'
import { isUpgradeOriginAllowed } from '../sessionProxy'
import { resolveCorsHeaders } from './cors'
import { ok, fail } from './envelope'
import { currentOriginAllowlist } from './originAllowlist'
import { readBody } from './readBody'
import type { SSEBroadcaster } from './sse'
import type { TelemetryRoutes } from './telemetry'

export interface CoreApiDeps {
  quota: CcQuotaService
  observations: ProviderCurrentObservationStores
  sse: SSEBroadcaster
  telemetry: TelemetryRoutes
  /** The port the server actually bound; reach must front what is listening. */
  boundPort: () => number
}

function rawJson(res: ServerResponse, value: unknown, headers: Record<string, string>) {
  res.writeHead(200, { ...headers, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

export async function handleCoreApi(deps: CoreApiDeps, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url?.split('?')[0] ?? '/'
  const method = req.method ?? 'GET'
  const headers = resolveCorsHeaders({ origin: req.headers.origin, allowlist: currentOriginAllowlist() }) as Record<string, string>
  if (method === 'OPTIONS' && url.startsWith('/api/')) { res.writeHead(204, headers); res.end(); return true }
  if (url.startsWith('/api/telemetry/') && await deps.telemetry.handle(req, res, url, headers)) return true
  if (method === 'GET' && url === '/api/cc-quota') { rawJson(res, deps.quota.getSnapshot(), headers); return true }
  if (method === 'POST' && url === '/api/cc-quota/ingest') {
    let payload: unknown
    try { payload = JSON.parse(await readBody(req)) } catch { return fail(res, 'BAD_REQUEST', 'malformed_json', { headers }) }
    rawJson(res, deps.quota.ingest(payload), headers)
    return true
  }
  if (method === 'GET' && url === '/api/provider-observations') {
    rawJson(res, deps.observations.toWire(), headers); return true
  }
  if (method === 'GET' && url === '/api/provider-observation-view') {
    rawJson(res, { version: 1, observations: deps.observations.toWire(), managedSessions: [] }, headers)
    return true
  }
  if (method === 'GET' && url === '/api/reach') { return ok(res, await getReachCoordinator().status(), { headers }) }
  if (method === 'POST' && url === '/api/reach') {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (contentType !== 'application/json') return fail(res, 'BAD_REQUEST', 'Content-Type must be application/json', { status: 415, headers })
    const origin = req.headers.origin
    if (!isUpgradeOriginAllowed(origin, currentOriginAllowlist())) return fail(res, 'FORBIDDEN', `origin ${origin ?? '(none)'} may not change reach`, { headers })
    let body: { enabled?: unknown } | null = null
    try { body = JSON.parse(await readBody(req)) as { enabled?: unknown } } catch { /* invalid */ }
    if (typeof body?.enabled !== 'boolean') return fail(res, 'BAD_REQUEST', 'body must be {"enabled": true|false}', { headers })
    const coordinator = getReachCoordinator()
    const status = body.enabled ? await coordinator.enable(deps.boundPort()) : await coordinator.disable()
    if (status.state === 'refused') return fail(res, 'BAD_REQUEST', status.detail ?? 'reach refused', { headers })
    return ok(res, status, { headers })
  }
  if (method === 'GET' && url === '/api/events') { deps.sse.addClient(res, headers); return true }
  return false
}

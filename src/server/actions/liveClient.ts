import { request } from 'node:http'
import { z } from 'zod'

export const liveActionsEnabled = () => process.env.TINSTAR_ACTIONS_LIVE === 'reader-repair'
export async function brokerRequest(path: string, body?: unknown, actor?: string, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; body: unknown }> {
  const socketPath = process.env.TINSTAR_ACTION_BROKER_SOCKET || '/run/tinstar-action-broker/broker.sock'
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { 'X-Tinstar-UI': '1', ...(actor ? { 'Tailscale-User-Login': actor } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, timeout: 35_000 }, response => {
      let bytes = 0; const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) req.destroy(); else chunks.push(chunk) })
      response.on('error', () => reject(new Error('Live action broker unavailable')))
      response.on('end', () => { try { resolve({ status: response.statusCode ?? 503, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) } catch { reject(new Error('Live action broker response invalid')) } })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => reject(new Error('Live Reader/Repair not provisioned: action broker socket unavailable')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
export async function brokerData(path: string, body?: unknown) {
  const response = await brokerRequest(path, body)
  const parsed = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ message: z.string() }).optional() }).parse(response.body)
  if (!parsed.ok || response.status !== 200) throw new Error(parsed.error?.message ?? 'Live Reader/Repair unavailable')
  return parsed.data
}
export const liveReaderJson = (path: string, _projection = '.') => brokerData('/reader', { path })
export const liveReaderIdentity = async () => z.object({ account: z.string(), owners: z.array(z.string()), repositories: z.array(z.string()), authenticatedActor: z.string(), credentialProfile: z.literal('Reader') }).parse(await brokerData('/identity'))

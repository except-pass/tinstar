import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { secretEquals } from './sessions'

const reads = ['list_ui_sessions', 'get_scene', 'read_record', 'get_card_context', 'get_queue', 'get_worker_link_report', 'get_command']
const views = ['present_view', 'next_queue_item']
export interface TunnelOptions {
  upstreamPort: number
  installToken: string
  caller: { id: string; token: string; allowView: boolean }
}
/** A separate bearer authorizes one owner-configured caller. Never inject it in
 * tunnel-client: doing so would authorize every caller of the tunnel alike. */
export function createTunnelFacade(options: TunnelOptions) {
  const { caller, installToken, upstreamPort } = options
  // Missing/ambiguous caller policy must not turn the private install token into
  // ambient authority for an Internet tunnel or another local HTTP proxy.
  if (!caller.id.trim() || caller.token.length < 32 || /\s/.test(caller.token) || !installToken || secretEquals(caller.token, installToken) || typeof caller.allowView !== 'boolean') throw new Error('Explicit separate caller credential and scope required')
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('Invalid local upstream port')
  const allowed = new Set([...reads, ...(caller.allowView ? views : [])])
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store')
    // Discovery must honestly report no OAuth server; a bearer credential must be
    // configured in the calling client. No browser origin or forwarded identity
    // headers grant authority, and no UI bridge is exposed here.
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
    const authorizationHeaders = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'authorization').length
    if (authorizationHeaders !== 1 || req.headers.origin || !secretEquals(String(req.headers.authorization ?? ''), `Bearer ${caller.token}`)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="tinstar-overview"' }); res.end('Unauthorized'); return
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
    const upstream = new Client({ name: 'tinstar-tunnel-facade', version: '1' })
    const server = new Server({ name: 'tinstar-overview-tunnel', version: '6.0.0' }, { capabilities: { tools: {} } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const cleanup = async () => { await Promise.allSettled([upstream.close(), transport.close(), server.close()]) }
    try {
      let size = 0
      const chunks: Buffer[] = []
      const timeout = setTimeout(() => req.destroy(), 10_000)
      let parsed: unknown
      try {
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk)
          if (size > 256 * 1024) throw new Error('Request too large')
          chunks.push(Buffer.from(chunk))
        }
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } finally { clearTimeout(timeout) }
      await upstream.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${upstreamPort}/api/reconciliation/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${installToken}` }, redirect: 'error' },
      }))
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = await upstream.listTools()
        return { tools: tools.tools.filter(tool => allowed.has(tool.name)) }
      })
      server.setRequestHandler(CallToolRequestSchema, async request => {
        if (!allowed.has(request.params.name)) return { isError: true, content: [{ type: 'text', text: 'Tool outside configured caller scope' }] }
        try { return await upstream.callTool({ name: request.params.name, arguments: request.params.arguments }) }
        catch { return { isError: true, content: [{ type: 'text', text: 'Tin Star tool unavailable; retry a read to check source/window state' }] } }
      })
      res.once('close', () => { void cleanup() })
      await server.connect(transport)
      await transport.handleRequest(req, res, parsed)
    } catch {
      // Never serialize SDK/network errors: they can include request headers.
      if (!res.headersSent) { res.writeHead(503); res.end('Tin Star MCP unavailable or invalid request') }
      else res.end()
      await cleanup()
    }
  }
  // The bind address is deliberately not configurable: this facade is only an
  // outbound tunnel target, never another public or tailnet listener.
  const server = createServer((req, res) => { void handle(req, res) })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return { server, listen: (port: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) }) }
}

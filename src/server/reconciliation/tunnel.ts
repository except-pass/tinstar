import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, JSONRPCRequestSchema, ListToolsRequestSchema, RequestSchema, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { secretEquals } from './sessions'

const commonTools = ['search_work', 'get_work', 'get_workflow_rules', 'get_work_views', 'start_work', 'create_work', 'update_work', 'submit_handoff', 'list_ui_sessions', 'get_scene', 'read_record', 'get_card_context', 'get_queue', 'get_worker_link_report', 'get_command', 'list_prs', 'get_pr', 'get_release_status']
const views = ['present_view', 'next_queue_item']
const modernVersion = '2026-07-28'
const supportedVersions = [modernVersion, ...SUPPORTED_PROTOCOL_VERSIONS]
const serverInfo = { name: 'tinstar-overview-tunnel', version: '6.0.0' }
const capabilities = { tools: {} }
const privateCache = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
const discoverSchema = RequestSchema.extend({ method: z.literal('server/discover') })
export interface TunnelOptions {
  upstreamPort: number
  installToken: string
  caller: { id: string; token: string; allowView: boolean }
}
export function createTunnelFacade(options: TunnelOptions) {
  const { caller, installToken, upstreamPort } = options
  // Missing/ambiguous caller policy must not turn the private install token into
  // ambient authority for an Internet tunnel or another local HTTP proxy.
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,99}$/.test(caller.id) || caller.token.length < 32 || /\s/.test(caller.token) || !installToken || secretEquals(caller.token, installToken) || typeof caller.allowView !== 'boolean') throw new Error('Explicit separate caller credential and scope required')
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('Invalid local upstream port')
  const allowed = new Set([...commonTools, ...(caller.allowView ? views : [])])
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
    const authorizationHeaders = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'authorization').length
    if (authorizationHeaders !== 1 || req.headers.origin || !secretEquals(String(req.headers.authorization ?? ''), `Bearer ${caller.token}`)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="tinstar-overview"' }); res.end('Unauthorized'); return
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
    const upstream = new Client({ name: 'tinstar-tunnel-facade', version: '1' })
    const server = new Server(serverInfo, { capabilities })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const cleanup = async () => { await Promise.allSettled([upstream.close(), transport.close(), server.close()]) }
    res.once('close', () => { void cleanup() })
    try {
      let size = 0
      const chunks: Buffer[] = []
      const timeout = setTimeout(() => req.destroy(), 10_000)
      let parsed: unknown
      try {
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk)
          if (size > 2 * 1024 * 1024) throw new Error('Request too large')
          chunks.push(Buffer.from(chunk))
        }
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } finally { clearTimeout(timeout) }
      const message = JSONRPCRequestSchema.safeParse(parsed)
      const version = req.headers['mcp-protocol-version']
      const metaVersion = message.success ? message.data.params?._meta?.['io.modelcontextprotocol/protocolVersion'] : undefined
      const modern = version === modernVersion || metaVersion === modernVersion
      const error = (status: number, code: number, text: string, data?: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.success ? message.data.id : null, error: { code, message: text, ...(data ? { data } : {}) } }))
      }
      if (version && !supportedVersions.includes(String(version)) && (!message.success || message.data.method !== 'initialize')) {
        error(400, -32022, 'Unsupported protocol version', { supported: supportedVersions, requested: version }); return
      }
      if (modern) {
        if (!message.success) { error(400, -32600, 'Invalid JSON-RPC request'); return }
        const { method, params } = message.data
        const nameHeader = req.headers['mcp-name']
        const name = typeof nameHeader === 'string' && nameHeader.startsWith('=?base64?') && nameHeader.endsWith('?=')
          ? Buffer.from(nameHeader.slice(9, -2), 'base64').toString('utf8') : nameHeader
        // Modern headers mirror the body. Check before adapting the legacy SDK
        // so intermediaries and the facade cannot execute different requests.
        if (version !== modernVersion || metaVersion !== modernVersion || req.headers['mcp-method'] !== method || method === 'tools/call' && name !== params?.name) {
          error(400, -32020, 'MCP routing headers do not match request metadata'); return
        }
        if (!['server/discover', 'tools/list', 'tools/call'].includes(method)) { error(404, -32601, 'Method not found'); return }
        // SDK 1.x only knows the legacy transport revision. These three RPCs
        // need no sessions or server-initiated requests; retain SDK HTTP/JSON
        // validation and shared handlers, adapting only this facade request.
        // https://modelcontextprotocol.io/specification/2026-07-28/schema
        req.headers['mcp-protocol-version'] = '2025-11-25'
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i]!.toLowerCase() === 'mcp-protocol-version') req.rawHeaders[i + 1] = '2025-11-25'
        }
        server.setRequestHandler(discoverSchema, async () => ({
          ...privateCache, supportedVersions, capabilities, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        }))
      }
      await upstream.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${upstreamPort}/api/reconciliation/mcp`), {
        // Forward only the facade's configured, authenticated caller proof,
        // never identity/owner headers supplied by the tunnel client.
        requestInit: { headers: { Authorization: `Bearer ${installToken}`, 'X-Tinstar-Caller': caller.id,
          'X-Tinstar-Caller-Authorization': `Bearer ${caller.token}` }, redirect: 'error' },
      }))
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = await upstream.listTools()
        return { ...(modern ? privateCache : {}), tools: tools.tools.filter(tool => allowed.has(tool.name)) }
      })
      server.setRequestHandler(CallToolRequestSchema, async request => {
        const complete = modern ? { resultType: 'complete' } : {}
        if (!allowed.has(request.params.name)) return { ...complete, isError: true, content: [{ type: 'text', text: 'Tool outside configured caller scope' }] }
        try { return { ...await upstream.callTool({ name: request.params.name, arguments: request.params.arguments }), ...complete } }
        catch { return { ...complete, isError: true, content: [{ type: 'text', text: 'Tin Star tool unavailable; retry a read to check source/window state' }] } }
      })
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

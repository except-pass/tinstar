import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authorizePrReadGrant } from '../prReadGrant'
import { DomainReadTools } from '../domainReads'
import { ReconciliationMcp } from '../mcp'
import { createTunnelFacade } from '../tunnel'
import { PullsApi } from '../../pulls/routes'
import { PullReader } from '../../pulls/reader'
import { PullFilesReader } from '../../pulls/files'
import { QueuePullReader } from '../queuePulls'
import { AssociationStore } from '../../releases/associations'
import { releaseFixture } from '../../../releases/__tests__/fixtures'

const servers: Server[] = [], clients: Client[] = [], roots: string[] = []
const owner = 'owner@example.test', callerId = 'owner-chatgpt'
const head = 'a'.repeat(40), url = 'https://github.com/owner/repo/pull/1'
const parse = (value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text)
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-pr-grant-')); roots.push(root)
  const callerToken = randomBytes(32).toString('hex'), callerTokenFile = join(root, 'caller-header')
  await writeFile(callerTokenFile, `Bearer ${callerToken}\n`, { mode: 0o600 })
  const config = { ask: { ownerLogins: [owner], bridgeToken: randomBytes(32).toString('hex') },
    prOperations: { repositories: ['owner/repo'] }, mcp: { prReadGrants: [{ callerId, callerTokenFile, ownerLogin: owner }] } }
  const save = () => writeFile(join(root, 'config.json'), JSON.stringify(config))
  await save()
  const scene = { ...releaseFixture(), searchIndex: { documents: [], notes: [] } }
  scene.coverage.intentions.expiresAt = '2026-01-01T00:00:00Z'
  const row = (number: number) => ({ number, title: `Change ${number}`, html_url: `https://github.com/owner/repo/pull/${number}`,
    user: { login: 'owner' }, draft: false, head: { sha: head }, base: { ref: 'main', sha: 'c'.repeat(40) },
    state: 'open', merged_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T00:00:00Z', body: 'Shared description', additions: 2, deletions: 0, changed_files: 2 })
  const github = vi.fn(async (path: string): Promise<unknown> => {
    if (path === '/user') return { login: 'owner' }
    if (path.startsWith('/user/orgs?')) return []
    if (path.includes('state=open')) return [row(1), row(2)]
    if (path.includes('/reviews?')) throw new Error('Private review source unavailable')
    if (path.includes('/files?')) return ['a.ts', 'b.ts'].map(filename => ({ filename, status: 'modified', additions: 1, deletions: 0, changes: 1 }))
    return row(1)
  })
  const workflow = { createClawsonMerge: vi.fn() }
  const pulls = new PullsApi({ scene: async () => scene, workflow: workflow as never }, new AssociationStore(root), root,
    new PullReader(github, Date.now, new QueuePullReader(async () => { throw new Error('Private checks unavailable') })), new PullFilesReader(github))
  const read = vi.spyOn(pulls, 'read'), inspect = vi.spyOn(pulls, 'inspect')
  const releaseRead = vi.fn().mockResolvedValue({ pulls: [], unassociatedCards: [], warnings: [], reconciliation: null })
  const mcp = new ReconciliationMcp({ scene: async () => scene, card: async () => null,
    workerLinkReport: vi.fn(), queue: vi.fn(), createWork: vi.fn().mockResolvedValue({ outcome: 'not-saved', code: 'unavailable' }),
  }, root, new DomainReadTools(pulls, { read: releaseRead }, req => authorizePrReadGrant(req, root)))
  const backend = createServer((req, res) => { void (async () => { if (!await pulls.handle(req, res)) await mcp.handle(req, res) })() }); servers.push(backend)
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const port = (backend.address() as { port: number }).port, base = `http://127.0.0.1:${port}`
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const headers = { Authorization: `Bearer ${token}`, 'X-Tinstar-Caller': callerId, 'X-Tinstar-Caller-Authorization': `Bearer ${callerToken}` }
  const connect = async (extra: Record<string, string>, endpoint = `${base}/api/reconciliation/mcp`) => {
    const client = new Client({ name: 'pr-grant-test', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: extra } }))
    return client
  }
  const call = async (client: Client, name = 'list_prs', args: Record<string, unknown> = {}) => parse(await client.callTool({ name, arguments: args }))
  return { root, callerToken, callerTokenFile, config, save, pulls, read, inspect, github, workflow, base, port, token, headers, connect, call }
}

it('uses both credentials through the facade, matches UI evidence, and does not grant UI or write authority', async () => {
  const f = await setup()
  const facade = createTunnelFacade({ upstreamPort: f.port, installToken: f.token, caller: { id: callerId, token: f.callerToken, allowView: false } })
  servers.push(facade.server); await facade.listen(0)
  const endpoint = `http://127.0.0.1:${(facade.server.address() as { port: number }).port}/mcp`
  // Client-supplied identities are ignored; the facade forwards its verified caller.
  const client = await f.connect({ Authorization: `Bearer ${f.callerToken}`, 'X-Tinstar-Caller': 'forged', 'Tailscale-User-Login': 'forged' }, endpoint)
  const ui = await (await fetch(`${f.base}/api/pulls`, { headers: { 'Tailscale-User-Login': owner } })).json()
  const listed = await f.call(client, 'list_prs', { limit: 1 })
  expect(listed).toMatchObject({ outcome: 'available', pulls: ui.data.pulls.slice(0, 1), repositories: ui.data.repositories,
    associationsComplete: ui.data.associationsComplete, pagination: { total: 2, next_offset: 1 } })
  const detail = await f.call(client, 'get_pr', { url, head, include_files: true, limit: 1 })
  const uiDetail = await (await fetch(`${f.base}/api/pulls/detail?url=${url}&head=${head}`, { headers: { 'Tailscale-User-Login': owner } })).json()
  expect(detail).toMatchObject({ outcome: 'available', detail: uiDetail.data, footprint: { files: [{ filename: 'a.ts' }], pagination: { total: 2, next_offset: 1 } } })
  expect(detail.detail).toMatchObject({ checks: 'unknown', reviewsComplete: false })
  expect(detail.relationships.complete).toBe(false)
  const foreign = await f.call(client, 'get_pr', { url: 'https://github.com/other/repo/pull/1', head })
  expect(foreign.outcome).toBe('unavailable')
  expect(f.github.mock.calls.some(([path]) => path.includes('/other/repo/'))).toBe(false)
  for (const path of ['/api/pulls', `/api/pulls/detail?url=${url}&head=${head}`, '/api/pulls/clawson-merge']) {
    const response = await fetch(`${f.base}${path}`, { method: path.endsWith('clawson-merge') ? 'POST' : 'GET', headers: { ...f.headers, 'X-Tinstar-UI': '1' } })
    expect(response.status).toBe(403)
  }
  expect(f.workflow.createClawsonMerge).not.toHaveBeenCalled()
  for (const name of ['merge_pr', 'approve_pr', 'submit_review', 'dispatch_worker']) expect((await client.callTool({ name, arguments: {} })).isError).toBe(true)
  const serialized = JSON.stringify({ listed, detail, foreign, tools: await client.listTools() })
  for (const secret of [f.token, f.callerToken, f.config.ask.bridgeToken]) expect(serialized).not.toContain(secret)
  // Revocation is effective on the very next call by an already connected facade client.
  f.config.mcp.prReadGrants = []; await f.save()
  f.read.mockClear(); f.inspect.mockClear()
  expect((await f.call(client)).outcome).toBe('unauthorized')
  expect((await f.call(client, 'get_pr', { url, head })).outcome).toBe('unauthorized')
  expect(f.read).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled()
  expect((await fetch(`${f.base}/api/pulls`, { headers: { 'Tailscale-User-Login': owner } })).status).toBe(200)
})

it('rejects missing/invalid installation tokens before any PR source read', async () => {
  const f = await setup()
  for (const authorization of ['', 'Bearer invalid', `Bearer ${f.callerToken}`]) {
    for (const name of ['list_prs', 'get_pr']) {
      const response = await fetch(`${f.base}/api/reconciliation/mcp`, { method: 'POST', headers: { ...f.headers, Authorization: authorization,
        'Tailscale-User-Login': owner, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: name === 'get_pr' ? { url, head } : {} } }) })
      expect(response.status).toBe(401)
      const text = await response.text()
      expect(text).not.toContain(f.token); expect(text).not.toContain(f.callerToken)
    }
  }
  expect(f.read).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled()
})

it('refuses forged caller/owner headers, other callers and mismatched caller credentials', async () => {
  const f = await setup()
  for (const headers of [
    { Authorization: f.headers.Authorization, 'Tailscale-User-Login': owner },
    { ...f.headers, 'X-Tinstar-Caller-Authorization': '' },
    { ...f.headers, 'X-Tinstar-Caller-Authorization': 'Bearer invalid' },
    { ...f.headers, 'X-Tinstar-Caller-Authorization': f.headers.Authorization },
    { ...f.headers, 'X-Tinstar-Caller': 'other-caller' },
  ] as Record<string, string>[]) {
    const client = await f.connect(headers)
    for (const [name, args] of [['list_prs', {}], ['get_pr', { url, head }]] as const) {
      expect((await f.call(client, name, args)).outcome).toBe('unauthorized')
    }
  }
  expect(f.read).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled()
})

it('rechecks grant, owner membership and private credential files on each read, failing closed on config errors', async () => {
  const f = await setup(), client = await f.connect(f.headers)
  expect((await f.call(client)).outcome).toBe('available')
  f.read.mockClear()
  const refuse = async () => {
    expect((await f.call(client)).outcome).toBe('unauthorized')
    expect((await f.call(client, 'get_pr', { url, head })).outcome).toBe('unauthorized')
    expect(f.read).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled()
  }
  f.config.ask.ownerLogins = ['another-owner']; await f.save(); await refuse()
  f.config.ask.ownerLogins = [owner]; f.config.mcp.prReadGrants[0]!.ownerLogin = 'unconfigured-owner'; await f.save(); await refuse()
  f.config.mcp.prReadGrants[0]!.ownerLogin = owner; await f.save()
  await chmod(f.callerTokenFile, 0o644); await refuse()
  await chmod(f.callerTokenFile, 0o600)
  await writeFile(f.callerTokenFile, `Bearer ${randomBytes(32).toString('hex')}`); await refuse()
  await rm(f.callerTokenFile); await refuse()
  await writeFile(join(f.root, 'config.json'), '{broken'); await refuse()
  await rm(join(f.root, 'config.json')); await refuse()
})

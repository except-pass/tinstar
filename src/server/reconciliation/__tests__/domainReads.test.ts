import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DomainReadTools } from '../domainReads'
import { ReconciliationMcp } from '../mcp'
import { PullsApi } from '../../pulls/routes'
import { PullReader } from '../../pulls/reader'
import { PullFilesReader } from '../../pulls/files'
import { QueuePullReader } from '../queuePulls'
import { ReleasesApi } from '../../releases/routes'
import { ReleasePullReader } from '../../releases/pulls'
import { releaseFixture } from '../../../releases/__tests__/fixtures'
import { buildWorkerLinkReport } from '../workerLinkReport'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'

const roots: string[] = [], servers: Server[] = [], clients: Client[] = []
const head = 'a'.repeat(40), url = 'https://github.com/owner/repo/pull/1'
const input = { offset: 0, limit: 1 }
const parse = (value: unknown) => JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text)
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-domain-')); roots.push(root)
  await writeFile(join(root, 'config.json'), JSON.stringify({ prOperations: { repositories: ['owner/repo'] }, ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
  const scene = { ...releaseFixture(), searchIndex: { documents: [], notes: [] } }
  const releases = new ReleasesApi({ scene: async () => scene }, root, new ReleasePullReader(async () => ({ title: 'Merged change', state: 'closed', merged: true, merged_at: '2026-11-06T18:00:00Z', merge_commit_sha: head })))
  return { root, scene, releases }
}

it('advertises bounded schemas and denies PR reads before touching private sources, including forged owner headers', async () => {
  const { root, scene, releases } = await setup()
  const pulls = { read: vi.fn(), inspect: vi.fn() }
  const domain = new DomainReadTools(pulls, releases)
  const mcp = new ReconciliationMcp({ scene: async () => scene, card: async () => null,
    workerLinkReport: async () => buildWorkerLinkReport(fixtureSources()),
    queue: async () => ({ outcome: 'queue-source-unavailable', message: 'Fixture' }),
  }, root, domain)
  const server = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new Client({ name: 'domain-read-test', version: '1' }); clients.push(client)
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'Tailscale-User-Login': 'owner@example.test', 'X-Forwarded-For': '127.0.0.1', 'X-Tinstar-UI': '1' } },
  }))
  const tools = (await client.listTools()).tools
  expect(tools.find(tool => tool.name === 'list_prs')?.inputSchema.properties?.limit).toMatchObject({ minimum: 1, maximum: 100, default: 25 })
  for (const tool of tools.filter(tool => ['list_prs', 'get_pr', 'get_release_status'].includes(tool.name))) expect(tool.annotations?.readOnlyHint).toBe(true)
  for (const [name, args] of [['list_prs', {}], ['get_pr', { url, head, include_files: true }]] as const) {
    expect(parse(await client.callTool({ name, arguments: args }))).toMatchObject({ outcome: 'unauthorized', prerequisite: expect.stringContaining('verified owner binding') })
  }
  expect(pulls.read).not.toHaveBeenCalled(); expect(pulls.inspect).not.toHaveBeenCalled()
  for (const args of [{ limit: 101 }, { offset: -1 }, { limit: 0 }]) expect((await client.callTool({ name: 'get_release_status', arguments: args })).isError).toBe(true)
  const release = parse(await client.callTool({ name: 'get_release_status', arguments: { limit: 1 } }))
  expect(release).toMatchObject({ outcome: 'available', associationsWritable: false, reconciliation: { sourceStatus: 'unconfigured' }, pagination: { pulls: { total: 2, next_offset: 1 } } })
  expect(release.pulls[0].deployment.state).toBe('unknown')
})

it('paginates the same release evidence as the UI without dropping source warnings, links or verification requirements', async () => {
  const { releases, scene } = await setup()
  scene.cards[0]!.source.properties['Requires production verification'] = { id: 'verify', type: 'checkbox', value: true, hasMore: false }
  scene.coverage.intentions.status = 'stale'
  const pulls = { read: vi.fn(), inspect: vi.fn() }, domain = new DomainReadTools(pulls, releases)
  const ui = await releases.read(false)
  const first = await domain.releaseStatus(input), second = await domain.releaseStatus({ ...input, offset: 1 })
  expect(first).toMatchObject({ warnings: ui.warnings, githubSync: ui.githubSync, associationsComplete: false,
    pulls: ui.pulls.slice(0, 1), reconciliation: { ...ui.reconciliation, cards: ui.reconciliation!.cards.slice(0, 1), targets: [] } })
  expect(first).toMatchObject({ pulls: [expect.objectContaining({ links: expect.arrayContaining([expect.objectContaining({ cardId: scene.cards[0]!.id }), expect.objectContaining({ cardId: scene.cards[1]!.id })]) })] })
  expect(second).toMatchObject({ pulls: ui.pulls.slice(1, 2), reconciliation: { cards: ui.reconciliation!.cards.slice(1, 2) } })
  expect(ui.reconciliation!.cards.find(card => card.cardId === scene.cards[0]!.id)?.requiresProductionVerification).toBe(true)
  expect(first).not.toHaveProperty('automation')
  vi.spyOn(releases.store, 'read').mockRejectedValue(new Error('Unreadable audit'))
  expect(await domain.releaseStatus(input)).toMatchObject({ associationsComplete: false, warnings: expect.arrayContaining([expect.stringContaining('association audit unavailable')]) })
})

it('keeps release source failure unknown and never exposes raw errors', async () => {
  const domain = new DomainReadTools({ read: vi.fn(), inspect: vi.fn() }, { read: vi.fn().mockRejectedValue(new Error('SECRET terminal stderr')) })
  const result = await domain.releaseStatus(input)
  expect(result).toMatchObject({ outcome: 'unavailable', message: expect.stringContaining('unknown') })
  expect(JSON.stringify(result)).not.toContain('SECRET')
  expect(result).not.toHaveProperty('pulls')
})

it('adapts real PR readers behind a server-owned test grant, preserving multiple links, unknown checks, files and attribution', async () => {
  const { root, scene, releases } = await setup()
  let currentHead = head, clock = Date.now(), failInventory = false
  const row = (number: number) => ({ number, title: `Change ${number}`, html_url: `https://github.com/owner/repo/pull/${number}`, user: { login: 'owner' }, draft: false, head: { sha: currentHead }, base: { ref: 'main', sha: 'c'.repeat(40) }, state: 'open', merged_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T00:00:00Z', body: 'Actual description', additions: 3, deletions: 0, changed_files: 2 })
  const read = vi.fn(async (path: string): Promise<unknown> => {
    if (path === '/user') return { login: 'owner' }
    if (path.startsWith('/user/orgs?')) return []
    if (path.endsWith('/reviews?per_page=100')) return Array.from({ length: 100 }, () => ({ user: { login: 'reviewer' }, state: 'APPROVED', html_url: `${url}#review` }))
    if (path.includes('/files?')) return ['src/a.ts', 'src/b.ts'].map(filename => ({ filename, status: 'modified', additions: 1, deletions: 0, changes: 1 }))
    if (path.includes('state=open')) { if (failInventory) throw new Error('Source unavailable'); return [row(1), row(2), row(3)] }
    if (path.endsWith('/999')) throw new Error('SECRET inaccessible PR')
    return row(Number(path.split('/').at(-1)))
  })
  const reader = new PullReader(read, () => clock, new QueuePullReader(async () => { throw new Error('Checks source outage') }))
  const api = new PullsApi({ scene: async () => scene }, releases.store, root, reader, new PullFilesReader(read))
  // Adapter projection coverage; configured transport grants are exercised separately.
  const domain = new DomainReadTools(api, releases, async () => true)
  const listed = await domain.listPulls(input)
  expect(listed).toMatchObject({ pagination: { total: 3, next_offset: 1 }, pulls: [{ id: 'owner/repo#1', head, links: expect.any(Array) }] })
  expect(await domain.listPulls({ ...input, offset: 2 })).toMatchObject({ pulls: [{ id: 'owner/repo#3', links: [] }], pagination: { next_offset: null } })
  const inspected = await domain.getPull({ ...input, url, head, include_files: true })
  expect(inspected).toMatchObject({ outcome: 'available', pull: { id: 'owner/repo#1', links: expect.arrayContaining([expect.objectContaining({ cardId: scene.cards[0]!.id }), expect.objectContaining({ cardId: scene.cards[1]!.id })]) },
    detail: { head, checks: 'unknown', review: 'Unknown / partial', reviewsComplete: false },
    footprint: { complete: true, files: [{ filename: 'src/a.ts' }], pagination: { total: 2, next_offset: 1 } },
    relationships: { cards: expect.arrayContaining([expect.objectContaining({ card_id: scene.cards[0]!.id })]) } })
  // Summary revalidation precedes detail cache lookup: a newly pushed head
  // cannot reuse the previous head's cached approval/check observations.
  currentHead = 'b'.repeat(40)
  expect(await domain.getPull({ ...input, url, head, include_files: true })).toMatchObject({ outcome: 'unavailable', message: expect.stringContaining('head changed') })
  const missing = await domain.getPull({ ...input, url: 'https://github.com/owner/repo/pull/999', head, include_files: false })
  expect(missing.outcome).toBe('unavailable'); expect(JSON.stringify(missing)).not.toContain('SECRET')
  expect(await domain.getPull({ ...input, url: 'https://github.com/other/repo/pull/1', head, include_files: false })).toMatchObject({ outcome: 'unavailable' })
  clock += 61_000; failInventory = true
  expect(await domain.listPulls(input)).toMatchObject({ repositories: [{ complete: false, status: 'stale' }], pulls: [expect.objectContaining({ freshness: 'stale' })] })
})

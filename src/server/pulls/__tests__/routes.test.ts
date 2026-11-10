import { afterEach, expect, it, vi } from 'vitest'
import { createServer, IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { PullsApi } from '../routes'
import { PullReader } from '../reader'
import { PullFilesReader } from '../files'
import { AssociationStore } from '../../releases/associations'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); resetOriginAllowlistForTests() })
it('reuses the shared audit for many-to-many links, keeps unlinked PRs, and refuses mutations/cross-origin reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-ops-'))
  await writeFile(join(root, 'config.json'), JSON.stringify({ prOperations: { repositories: ['owner/repo'] }, ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
  const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }, store = new AssociationStore(root)
  const cardIds = scene.cards.slice(0, 2).map(card => card.id)
  for (const cardId of cardIds) await store.append({ id: randomUUID(), pull: 'https://github.com/owner/repo/pull/1', cardId, action: 'link', reason: 'Explicit approved relationship' }, 'owner')
  const read = vi.fn<(path: string, projection?: string) => Promise<unknown>>(async (path: string) => path === '/user' ? { login: 'owner' } : path.startsWith('/user/orgs?') ? [] : [1, 2].map(number => ({ number, title: `PR ${number}`, html_url: `https://github.com/owner/repo/pull/${number}`, user: { login: 'author' }, draft: false, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' }, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' })))
  const api = new PullsApi({ scene: async () => scene }, store, root, new PullReader(read))
  const server = createServer((req, res) => { void api.handle(req, res) }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  seedOriginAllowlist((server.address() as { port: number }).port)
  const headers = { 'Tailscale-User-Login': 'owner@example.test' }
  for (const path of ['/api/pulls/origin?url=https://github.com/owner/repo/pull/1', `/api/pulls/files?url=https://github.com/owner/repo/pull/1&head=${'a'.repeat(40)}`, '/api/pulls', `/api/pulls/detail?url=https://github.com/owner/repo/pull/1&head=${'a'.repeat(40)}`]) {
    for (const denied of [{}, { 'Tailscale-User-Login': 'stranger@example.test' }] as Record<string, string>[]) {
      const response = await fetch(`${base}${path}`, { headers: denied })
      expect(response.status).toBe(403)
      expect((await response.json()).error.message).toContain('Authorized tailnet owner required')
    }
  }
  expect(read).not.toHaveBeenCalled()
  const detail = vi.spyOn(PullReader.prototype, 'detail').mockResolvedValue({ body: 'Private description', reviews: [{ author: 'private-reviewer' }] } as never)
  const detailBody = await (await fetch(`${base}/api/pulls/detail?url=https://github.com/owner/repo/pull/1&head=${'a'.repeat(40)}`, { headers })).json()
  expect(detailBody.data.body).toBe('Private description')
  expect(detailBody.data.reviews[0].author).toBe('private-reviewer')
  detail.mockRestore()
  const files = vi.spyOn(PullFilesReader.prototype, 'get').mockResolvedValue({ head: 'a'.repeat(40), files: [{ filename: 'src/a.ts' }], complete: true } as never)
  const fileBody = await (await fetch(`${base}/api/pulls/files?url=https://github.com/owner/repo/pull/1&head=${'a'.repeat(40)}`, { headers })).json()
  expect(fileBody.data.files[0].filename).toBe('src/a.ts')
  expect((await fetch(`${base}/api/pulls/files?url=https://github.com/other/repo/pull/1&head=${'a'.repeat(40)}`, { headers })).status).toBe(400)
  expect(files).toHaveBeenCalledTimes(1)
  files.mockRestore()
  const body = await (await fetch(`${base}/api/pulls`, { headers })).json()
  expect(body.ok).toBe(true)
  expect(body.data.pulls).toHaveLength(2)
  expect(body.data.pulls[0].links.filter((link: { active: boolean }) => link.active)).toHaveLength(2)
  expect(body.data.pulls[1].links).toEqual([])
  expect((await fetch(`${base}/api/pulls`, { method: 'POST', headers })).status).toBe(400)
  expect((await fetch(`${base}/api/pulls`, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403)
  expect((await fetch(`${base}/api/pulls/detail?url=https://github.com/other/repo/pull/1&head=${'a'.repeat(40)}`, { headers })).status).toBe(400)
  expect(await store.read()).toHaveLength(2)
  expect(read).toHaveBeenCalledTimes(3)
  // A foreign PR appears only while its shared card edge is active.
  await writeFile(join(root, 'config.json'), JSON.stringify({ prOperations: { repositories: ['foreign/repo'] }, ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
  const foreign = 'https://github.com/foreign/repo/pull/9'
  await store.append({ id: randomUUID(), pull: foreign, cardId: cardIds[0]!, action: 'link', reason: 'Explicit relationship' }, 'owner')
  read.mockImplementation(async path => path.startsWith('/search/issues?') ? { total_count: 0, incomplete_results: false, items: [] } : { number: 9, title: 'Associated upstream work', html_url: foreign, user: { login: 'another-person' }, draft: false, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' }, state: 'open', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' })
  const linked = await (await fetch(`${base}/api/pulls`, { headers })).json()
  expect(linked.data.pulls.map((pull: { url: string }) => pull.url)).toEqual([foreign])
  await store.append({ id: randomUUID(), pull: foreign, cardId: cardIds[0]!, action: 'unlink', reason: 'Relationship removed' }, 'owner')
  const unlinked = await (await fetch(`${base}/api/pulls`, { headers })).json()
  expect(unlinked.data.pulls).toEqual([])
  expect(unlinked.data.repositories[0].scope).toBe('authored-or-associated')
})

it('resolves closed origins within owned/authored/associated scope and derives Ask provenance from shared evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-origin-'))
  await writeFile(join(root, 'config.json'), JSON.stringify({ prOperations: { repositories: ['owner/repo', 'foreign/repo'] }, ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
  const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }, store = new AssociationStore(root), worker = scene.executions[0]!
  const url = 'https://github.com/foreign/repo/pull/9'
  worker.source.pr.url = url
  await store.append({ id: randomUUID(), pull: url, cardId: scene.cards[0]!.id, action: 'link', reason: 'Explicit relationship' }, 'owner')
  const read = vi.fn(async (path: string) => path === '/user' ? { login: 'owner' } : path.startsWith('/user/orgs') ? [] : {
    number: 9, title: 'Closed origin', html_url: path.includes('/owner/') ? 'https://github.com/owner/repo/pull/9' : url, user: { login: 'stranger' }, draft: false, head: { sha: 'b'.repeat(40) }, base: { ref: 'main' }, state: 'closed', merged_at: '2026-11-08T12:00:00Z', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-08T12:00:00Z',
  })
  const api = new PullsApi({ scene: async () => scene }, store, root, new PullReader(read))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  expect(await api.origin('https://github.com/owner/repo/pull/9')).toMatchObject({ state: 'merged', head: 'b'.repeat(40), title: 'Closed origin' })
  expect(await api.origin(url)).toMatchObject({ state: 'merged', links: expect.arrayContaining([expect.objectContaining({ active: true, cardId: scene.cards[0]!.id })]) })
  const context = await api.relationships('foreign/repo#9')
  expect(context?.cards).toContainEqual({ card_id: scene.cards[0]!.id, sources: ['Manual association'] })
  expect(context?.workers[0]).toMatchObject({ execution_id: worker.id, home: worker.home, attempt: worker.identity.spawn_gen, source: String(worker.source.pr.source ?? 'tasks[].pr.url'), claims: expect.any(Array) })
  worker.source.pr.url = null
  await store.append({ id: randomUUID(), pull: url, cardId: scene.cards[0]!.id, action: 'unlink', reason: 'Removed relationship' }, 'owner')
  await expect(api.origin(url)).rejects.toThrow('authored or associated scope')
  await expect(api.origin('https://github.com/unconfigured/repo/pull/9')).rejects.toThrow('repository scope')
  expect(read.mock.calls.every(([path]) => !path.includes('state=all'))).toBe(true)
})

it.each(['complete', 'partial', 'stale', 'unavailable'] as const)('uses production open-only %s coverage for association-only merge asks without new PR lookups', async coverage => {
  const { ReconciliationSources } = await import('../../reconciliation')
  const { CardContextReader } = await import('../../reconciliation/cardContext')
  const { fixtureSources } = await import('../../../../test-fixtures/reconciliation/scenes')
  const root = await mkdtemp(join(process.cwd(), '.association-coverage-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'config.json'), JSON.stringify({ prOperations: { repositories: ['owner/repo'] }, ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
  let clock = Date.now(), phase = 'open'
  const url = 'https://github.com/owner/repo/pull/9'
  const row = (number: number) => ({ number, title: 'Private change', html_url: `https://github.com/owner/repo/pull/${number}`, user: { login: 'agent' }, draft: false, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' }, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' })
  const read = vi.fn(async (path: string) => {
    if (path === '/user') return { login: 'owner' }
    if (path.startsWith('/user/orgs?')) return []
    if (!path.startsWith('/repos/owner/repo/pulls?state=open&')) throw new Error('Unexpected PR lookup')
    if (phase === 'open') return [row(9)]
    if (coverage === 'complete') return []
    if (coverage === 'partial' && path.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => row(1000 + i))
    throw new Error('Fixture inventory unavailable')
  })
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, undefined, undefined, root)
  const snapshot = fixtureSources({ now: clock }), card = snapshot.intentions.data!.cards[0]!
  snapshot.intentions.data!.cards = [card]; snapshot.fleet = []
  delete card.properties.Link; delete card.properties.Evidence
  card.properties['Will action'] = { id: 'actions', type: 'multi_select', value: ['Merge'], hasMore: false }
  card.properties['Next action'] = { id: 'next', type: 'rich_text', value: 'Merge the reviewed change', hasMore: false }
  const scene = { ...fixtureScene({ now: clock }), searchIndex: { documents: [], notes: [] } }
  scene.cards = scene.cards.filter(item => item.id === card.id); scene.cards[0]!.source = card
  vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
  vi.spyOn(sources, 'scene').mockResolvedValue(scene)
  const context = vi.spyOn(CardContextReader.prototype, 'commentDetails').mockResolvedValue({ outcome: 'available', blocks: [] })
  try {
    const store = new AssociationStore(root)
    await store.append({ id: randomUUID(), pull: url, cardId: card.id, action: 'link', reason: 'Fixture association' }, 'owner')
    const api = new PullsApi(sources, store, root, new PullReader(read, () => clock))
    sources.authorizePulls = req => api.authorized(req)
    const inventory = vi.fn(() => api.read())
    sources.readPulls = inventory
    sources.readPullReadiness = vi.fn(async () => new Map())
    const owner = new IncomingMessage(new Socket())
    owner.headers = { 'tailscale-user-login': 'owner@example.test' }
    Object.defineProperty(owner.socket, 'remoteAddress', { value: '127.0.0.1' })
    if (coverage !== 'unavailable') {
      const open = await sources.queue(owner)
      expect(open.needsWill?.[0]?.pulls[0]?.url).toBe(url)
      clock += 61_000
    }
    phase = 'absent'
    const listed = await api.read()
    expect(listed.repositories[0]?.status).toBe(coverage === 'complete' ? 'fresh' : coverage)
    expect(listed.associations[0]).toMatchObject({ url, links: [expect.objectContaining({ cardId: card.id, active: true })] })
    if (coverage === 'complete' || coverage === 'unavailable') expect(listed.pulls).toEqual([])
    const result = await sources.queue(owner)
    if (coverage === 'complete') expect(result.needsWill).toEqual([])
    else expect(result.needsWill?.[0]).toMatchObject({ kind: 'merge', action: 'PR state unverified', reasons: expect.arrayContaining(['PR state unverified']) })
    card.properties['Will action']!.value = ['Merge', 'Decision']
    const mixed = await sources.queue(owner)
    expect(mixed.needsWill).toHaveLength(1)
    expect(mixed.needsWill?.[0]!.sources.find(source => source.request?.kind === 'notion-card')?.actions).toEqual(coverage === 'complete' ? ['Decision'] : ['Merge', 'Decision'])
    expect(sources.readPullReadiness).toHaveBeenLastCalledWith([])
    const reads = inventory.mock.calls.length
    const restricted = await sources.queue()
    expect(inventory).toHaveBeenCalledTimes(reads)
    expect(restricted.needsWill?.[0]).toMatchObject({ pulls: [], prDetails: 'PR details require owner authorization' })
    expect(read.mock.calls.every(([path]) => path === '/user' || path.startsWith('/user/orgs?') || path.startsWith('/repos/owner/repo/pulls?state=open&'))).toBe(true)
  } finally { context.mockRestore() }
})

it('retains an Evidence-only merge ask outside complete authored-or-associated inventory without fetching the PR', async () => {
  const { ReconciliationSources } = await import('../../reconciliation')
  const { CardContextReader } = await import('../../reconciliation/cardContext')
  const { fixtureSources } = await import('../../../../test-fixtures/reconciliation/scenes')
  const { inventoryPullState } = await import('../../../shared/pulls')
  const root = await mkdtemp(join(process.cwd(), '.scope-coverage-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'config.json'), JSON.stringify({ prOperations: { repositories: ['upstream/repo'] }, ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
  const url = 'https://github.com/upstream/repo/pull/9'
  const read = vi.fn(async (path: string) => {
    if (path === '/user') return { login: 'owner' }
    if (path.startsWith('/user/orgs?')) return []
    if (path.startsWith('/search/issues?')) return { total_count: 0, incomplete_results: false, items: [] }
    throw new Error('An Evidence-only PR by another author must not be fetched')
  })
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, undefined, undefined, root)
  const snapshot = fixtureSources({ now: Date.now() }), card = snapshot.intentions.data!.cards[0]!
  snapshot.intentions.data!.cards = [card]; snapshot.fleet = []
  delete card.properties.Link
  card.properties.Evidence = { id: 'evidence', type: 'url', value: url, hasMore: false }
  card.properties['Will action'] = { id: 'actions', type: 'multi_select', value: ['Merge', 'Decision'], hasMore: false }
  card.properties['Next action'] = { id: 'next', type: 'rich_text', value: 'Merge the reviewed change', hasMore: false }
  const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
  scene.cards = scene.cards.filter(item => item.id === card.id); scene.cards[0]!.source = card
  scene.executions = []; scene.backlog = []; scene.claims = []
  vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
  vi.spyOn(sources, 'scene').mockResolvedValue(scene)
  const context = vi.spyOn(CardContextReader.prototype, 'commentDetails').mockResolvedValue({ outcome: 'available', blocks: [] })
  try {
    const api = new PullsApi(sources, new AssociationStore(root), root, new PullReader(read))
    const inventory = await api.read()
    expect(inventory).toMatchObject({ pulls: [], associations: [], repositories: [{ repository: 'upstream/repo', scope: 'authored-or-associated', complete: true, status: 'fresh' }] })
    expect(inventoryPullState(url, inventory)).toBe('unverified')
    expect(inventoryPullState(url, { ...inventory, repositories: inventory.repositories.map(repo => ({ ...repo, scope: undefined })) })).toBe('unverified')
    expect(inventoryPullState(url, { ...inventory, repositories: inventory.repositories.map(repo => ({ ...repo, scope: 'all-open' as const })) })).toBe('not-open')
    const associated = { ...inventory, associations: [{ id: 'upstream/repo#9', repository: 'upstream/repo', number: 9, url, links: [{ cardId: card.id, active: true, sources: ['Manual association'], events: [] }] }] }
    expect(inventoryPullState(url, associated)).toBe('not-open')
    associated.associations[0]!.links[0]!.active = false
    expect(inventoryPullState(url, associated)).toBe('unverified')
    sources.authorizePulls = req => api.authorized(req)
    sources.readPulls = () => api.read()
    const readiness = vi.fn(async () => new Map())
    sources.readPullReadiness = readiness
    const owner = new IncomingMessage(new Socket())
    owner.headers = { 'tailscale-user-login': 'owner@example.test' }
    Object.defineProperty(owner.socket, 'remoteAddress', { value: '127.0.0.1' })
    const view = await sources.queue(owner)
    expect(view.needsWill).toHaveLength(1)
    expect(view.needsWill?.[0]).toMatchObject({ kind: 'merge', action: 'PR state unverified', reasons: expect.arrayContaining(['PR state unverified']) })
    expect(view.needsWill?.[0]!.sources.find(source => source.request?.kind === 'notion-card')?.actions).toEqual(['Merge', 'Decision'])
    expect(view.needsWill?.[0]!.sources.find(source => source.kind === 'github')).toMatchObject({ id: url, status: 'unknown', observedAt: null })
    expect(readiness).toHaveBeenCalledWith([])
    expect(read).toHaveBeenCalledTimes(3)
    card.properties['Will action']!.value = ['Merge']
    expect((await sources.queue(owner)).needsWill).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(3)
    const restricted = await sources.queue()
    expect(restricted.needsWill?.[0]).toMatchObject({ pulls: [], prDetails: 'PR details require owner authorization' })
  } finally { context.mockRestore() }
})

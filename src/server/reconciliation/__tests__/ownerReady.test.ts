import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import type { OwnerReadyRead } from '../../../shared/ownerReady'
import { handleReconciliationRequest, ReconciliationSources } from '..'
import { DomainReadTools } from '../domainReads'
import { ReconciliationMcp } from '../mcp'
import { authorizePrReadGrant } from '../prReadGrant'
import { mergePublication, readyHeadPublication } from '../ownerRequestEvidence'
import { QueuePullReader } from '../queuePulls'
import { PullReader } from '../../pulls/reader'
import { PullsApi } from '../../pulls/routes'
import { AssociationStore } from '../../releases/associations'

const original = 'a'.repeat(40), changed = 'b'.repeat(40), sibling = 'c'.repeat(40)
const moving = 'https://github.com/owner/repo/pull/1'
const closing = 'https://github.com/owner/repo/pull/2'
const legacy = 'https://github.com/owner/repo/pull/3'
const unchanged = 'https://github.com/owner/other/pull/4'
const historical = 'https://github.com/owner/repo/pull/5'
const restricted = 'https://github.com/owner/repo/pull/6'
const releaseWait = 'https://github.com/owner/repo/pull/7'
const outsider = 'https://github.com/outside/repo/pull/8'
const mergeComment = '12345678-1234-1234-1234-123456789abc'
const author = 'owner@example.test'
const project = '10639'
const fields = { owner: 'customfield_101', decisions: 'customfield_102', blockerType: 'customfield_103',
  blockerTarget: 'customfield_104', blockerCondition: 'customfield_105' }
const bundle = (read: OwnerReadyRead, repository: string | null) => read.repositories.find(bundle => bundle.repository === repository)
const merge = (read: OwnerReadyRead, url: string) => read.repositories.flatMap(bundle => bundle.merges).find(merge => merge.url === url)
const entry = (url: string, head: string, id: string, created = '2026-11-23T12:00:00Z') =>
  ({ id, body: `Will: merge ${url}${head ? ` head ${head}` : ''}`, created })
const issue = (id: string, decisions = '', status = 'Ready for Review', description = '') => ({ id, key: `TSW-${id}`,
  fields: { project: { id: project }, status: { name: status }, assignee: { displayName: 'William Gathright', accountId: 'fixture-will' },
    [fields.decisions]: decisions, description } })
const text = (value: unknown) => (value as { content: Array<{ text: string }> }).content[0]!.text

it('keeps one current owner bundle per repo during Main downtime and reconciles current heads once on return', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-owner-ready-'))
  const clients: Client[] = []
  const homes = ['main', 'mate-a', 'mate-b'].map(label => ({ label, home: join(root, label), snapshotFile: join(root, `${label}.json`) }))
  const [main, ...mates] = homes
  const generated = new Date().toISOString()
  const snapshotFile = (source: typeof homes[number], tasks: unknown[], generatedAt = generated) => writeFile(source.snapshotFile,
    JSON.stringify({ schema: 'fm-fleet-snapshot.v1', generated: generatedAt, fm_home: source.home, tasks,
      backlog: { present: true, records: [] }, main_inventory: { valid: true } }))
  // Two independently published ready notices corroborate the same durable ask.
  for (const [index, source] of mates.entries()) await snapshotFile(source, [{
    id: `delivery-${index}`, kind: 'ship', spawn_gen: `attempt-${index}`, backlog: { body_lines: ['card: TSW-10'] },
    pr: { url: moving, head: original }, hints: { last_event_text: `done: PR ${index === 0 ? moving : moving + '?source=mate'} checks green at head ${original}` },
  }])
  const liveHeads = new Map([[moving, original], [closing, sibling], [legacy, original], [unchanged, sibling], [releaseWait, sibling]])
  const questions = 'D1 [Open]: Choose launch wording\n\nD2 [Open]: Confirm the launch date'
  const review = issue('10', questions)
  const tickets = [review, issue('11'), issue('12'), issue('13'), issue('14', 'D1 [Open]: Select a recovery option', 'Decision'), issue('15')]
  const comments = new Map([
    ['10', [entry(moving, original, '21'),
      ...Array.from({ length: 49 }, (_, index) => ({ id: String(index + 100), body: 'Review update', created: '2026-11-23T12:00:00Z' })),
      entry(moving + '?notice=retry', '', '20'),
      { ...entry(restricted, original, '19'), visibility: { type: 'role' } }, entry(historical, original, '18', '2026-11-23T08:00:00Z')]],
    ['11', [entry(closing, sibling, '22')]], ['12', [entry(legacy, '', '23')]],
    ['13', [entry(unchanged, sibling, '24')]], ['15', [entry(outsider, original, '25')]],
  ])
  const repoBoard = fixtureSources()
  const [native, production] = repoBoard.intentions.data!.cards
  native!.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Merge', 'Decision'], hasMore: false }
  native!.properties.Repository = { id: 'repo', type: 'rich_text', value: 'owner/repo', hasMore: false }
  production!.properties.Status!.value = 'Waiting for Prod Release'
  production!.properties.Link = { id: 'pull', type: 'url', value: releaseWait, hasMore: false }
  repoBoard.intentions.data!.cards = [native!, production!]
  const notionNotes: string[] = [
    `Tin Star request: {"id":"notion-merge","action":"Merge"}\nRequested from: Will\nQuestion: Merge ${moving} head ${original}`,
    'Tin Star request: {"id":"notion-choice","action":"Decision"}\nRequested from: Will\nQuestion: Choose a deployment window?',
  ]
  let boardHistoryUnavailable = false
  let shiftCommentBoundary = false
  const sourceWrites: string[] = []
  const readSource = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/search/jql')) {
      const { jql, nextPageToken } = JSON.parse(String(init?.body))
      expect(jql).toContain(`project = ${project}`)
      return Response.json(nextPageToken ? { issues: tickets.slice(3), isLast: true }
        : { issues: tickets.slice(0, 3), isLast: false, nextPageToken: 'next-issues' })
    }
    if (init?.method && init.method !== 'GET') sourceWrites.push(`${init.method} ${path}`)
    if (path === '/v1/comments') {
      if (boardHistoryUnavailable) return new Response(null, { status: 503 })
      return Response.json({ results: notionNotes.map((note, index) => ({ id: index === 0 ? mergeComment : `native-${index}`, rich_text: [{ plain_text: note }] })), has_more: false })
    }
    const [, id, resource] = /\/issue\/(\d+)(?:\/(comment|changelog))?$/.exec(path) ?? []
    if (resource === 'comment') {
      const rows = comments.get(id!) ?? []
      const startAt = Number(new URL(String(input)).searchParams.get('startAt'))
      const page = id === '10' && shiftCommentBoundary && startAt > 0
        ? [...rows.slice(1), { id: '9999', created: '2026-11-23T07:00:00Z', body: 'Review update' }] : rows
      return Response.json({ startAt, total: page.length, comments: page.slice(startAt, startAt + 50) })
    }
    if (resource === 'changelog') {
      const values = id === '10' ? [{ created: '2026-11-23T09:00:00Z', items: [{ field: 'status', fromString: 'Ready for Review', toString: 'In Progress' }] }] : []
      return Response.json({ startAt: 0, total: values.length, values })
    }
    if (id) return Response.json({ id, fields: { project: { id: project } } })
    throw new Error(`Unexpected fixture source request ${path}`)
  })
  const inventory = vi.fn(async (path: string): Promise<unknown> => {
    if (path === '/user') return { login: 'owner' }
    if (path.startsWith('/user/orgs?')) return []
    const repository = /^\/repos\/(owner\/\w+)\/pulls\?/.exec(path)?.[1]
    if (!repository) throw new Error('Outside fixture PR inventory')
    return [...liveHeads].filter(([url]) => url.startsWith(`https://github.com/${repository}/`)).map(([url, head]) => ({
      number: Number(url.split('/').at(-1)), title: 'Fixture PR', html_url: url, user: { login: 'owner' }, draft: false,
      head: { sha: head }, base: { ref: 'main' }, created_at: generated, updated_at: generated,
    }))
  })
  let outage = false
  const readScalars = vi.fn(async (path: string): Promise<Record<string, unknown>> => {
    if (outage) throw new Error('Controlled forge evidence outage')
    if (path.endsWith('/pulls/4')) return { state: 'open', merged: false, draft: false, head: sibling, mergeable: true, mergeable_state: 'clean' }
    if (path.endsWith('/pulls/1')) return { state: 'open', merged: false, draft: false, head: liveHeads.get(moving), mergeable: true, mergeable_state: 'clean' }
    if (path.endsWith('/pulls/2')) return { state: 'open', merged: false, draft: false, head: sibling, mergeable: true, mergeable_state: 'clean' }
    if (path.includes('/check-runs?')) return { total: 1, returned: 1, pending: 0, failed: 0 }
    if (path.includes('/status?')) return { total: 0, state: 'pending' }
    throw new Error('Unexpected readiness call')
  })
  const callerId = 'owner-chatgpt', caller = randomBytes(32).toString('hex'), callerFile = join(root, 'caller')
  await writeFile(callerFile, `Bearer ${caller}\n`, { mode: 0o600 })
  await writeFile(join(root, 'config.json'), JSON.stringify({
    ask: { ownerLogins: [author], bridgeToken: randomBytes(32).toString('hex') },
    mcp: { prReadGrants: [{ callerId, callerTokenFile: callerFile, ownerLogin: author }] },
    prOperations: { repositories: ['owner/repo', 'owner/other'] },
  }))
  const makeSources = () => {
    const sources = new ReconciliationSources({ fleet: homes, warnings: [], notion: { dataSourceId: 'd'.repeat(32), token: 'fixture' },
      jiraWork: { mode: 'work', url: 'https://example.atlassian.net', cloudId: '7d1bfc1a-cf35-4405-8f3e-71b6cefb7c91',
        projectId: project, fields, issueTypes: { Task: '1' }, blocksLinkTypeId: '42', token: 'fixture' } }, readSource, undefined, root)
    vi.spyOn(sources, 'snapshot').mockImplementation(async force => ({ ...repoBoard,
      generatedAt: new Date().toISOString(), fleet: await sources.fleetSnapshot(force), diagnostics: { notion: sources.notionApi.diagnostics } }))
    sources.waitingOnMain = vi.fn(async () => { throw new Error('Return recheck must not invoke Main wait notifications') })
    const pulls = new PullsApi(sources, new AssociationStore(root), root, new PullReader(inventory, Date.now, new QueuePullReader(readScalars)))
    sources.authorizePulls = req => pulls.authorized(req)
    sources.readOwnerInventory = (repositories, force, scene) => pulls.read(force, repositories, scene)
    sources.readPullReadiness = (...args) => pulls.readiness(...args)
    return { sources, pulls }
  }
  let { sources, pulls } = makeSources()
  const mcp = new ReconciliationMcp(sources, root, new DomainReadTools(pulls, { read: vi.fn() },
    req => authorizePrReadGrant(req, root), recheck => sources.ownerReadyWithPulls(recheck)))
  const server = createServer((req, res) => { void (async () => {
    if (!await handleReconciliationRequest(sources, req, res)) await mcp.handle(req, res)
  })().catch(() => { res.writeHead(500); res.end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const install = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
    async function connect(granted: boolean) {
      const client = new Client({ name: 'owner-ready-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: {
        Authorization: `Bearer ${install}`, 'X-Tinstar-Caller': callerId,
        'X-Tinstar-Caller-Authorization': granted ? `Bearer ${caller}` : 'Bearer forged', 'Tailscale-User-Login': author,
      } } }))
      return client
    }
    const granted = await connect(true), mate = await connect(false)
    const call = async (client: Client, name: string, args = {}) => JSON.parse(text(await client.callTool({ name, arguments: args })))
    const browse = (recheck = true, owner = true) => fetch(`${base}/api/reconciliation/owner-ready${recheck ? '?recheck=1' : ''}`, {
      headers: owner ? { 'Tailscale-User-Login': author } : undefined,
    })

    await snapshotFile(main!, [])
    expect((await sources.fleetSnapshot(true))[0]!.observation.status).toBe('fresh')
    await rm(main!.snapshotFile)
    const pending = (await call(mate, 'get_work_views')).ownerReady as OwnerReadyRead
    expect(pending.warnings).toContainEqual(expect.stringContaining('Fleet coverage for main is stale'))
    expect(pending.repositories.map(group => group.repository)).toEqual(['outside/repo', 'owner/other', 'owner/repo', null])
    expect(bundle(pending, 'owner/repo')?.merges.filter(ask => ask.url === moving)).toHaveLength(1)
    expect(merge(pending, moving)).toMatchObject({ requestedHeads: [original], unverifiedRequest: false,
      sources: [expect.objectContaining({ kind: 'jira', url: expect.stringContaining('focusedCommentId=21') }),
        expect.objectContaining({ kind: 'jira', url: expect.stringContaining('focusedCommentId=20') }), expect.objectContaining({
          kind: 'notion', url: `https://www.notion.so/${native!.id}#${mergeComment.replaceAll('-', '')}`, requestedHead: original,
        }), expect.objectContaining({ kind: 'firstmate', url: '/?worker=delivery-0', requestedHead: original }),
        expect.objectContaining({ kind: 'firstmate', url: '/?worker=delivery-1', requestedHead: original })] })
    expect(merge(pending, moving)).not.toHaveProperty('live')
    expect(bundle(pending, 'owner/repo')?.decisions.map(row => row.question)).toEqual(['Choose launch wording', 'Confirm the launch date', 'Choose a deployment window?'])
    expect(bundle(pending, null)?.decisions).toHaveLength(1)
    expect([historical, restricted, releaseWait].map(url => merge(pending, url))).toEqual([undefined, undefined, undefined])
    expect((await call(mate, 'list_prs', { view: 'owner-ready', recheck: true })).outcome).toBe('unauthorized')
    expect((await browse(true, false)).status).toBe(403)
    expect((await browse(false)).status).toBe(404)
    expect(inventory).not.toHaveBeenCalled()

    // Reconstruct Tin Star with a stale Main file and the very same native records.
    await snapshotFile(main!, [], new Date(Date.now() - 3600_000).toISOString())
    ;({ sources, pulls } = makeSources())
    const restarted = (await call(granted, 'list_prs', { view: 'owner-ready' })).ownerReady as OwnerReadyRead
    expect(restarted.warnings).toContainEqual(expect.stringContaining('Fleet coverage for main is stale'))
    expect(merge(restarted, moving)?.live?.state).toBe('ready')
    expect(merge(restarted, legacy)).toMatchObject({ requestedHeads: [], unverifiedRequest: true, live: { head: original, state: 'unverified' } })
    expect(merge(restarted, outsider)?.live).toMatchObject({ head: null, state: 'unverified' })

    liveHeads.set(moving, changed)
    liveHeads.delete(closing)
    review.fields[fields.decisions] = 'D1 [Answered]: Choose launch wording\n  Answer: Use the short wording\n\nD2 [Open]: Confirm the launch date'
    await snapshotFile(main!, [])
    const records = JSON.stringify({ tickets, notes: [...comments], notionNotes })
    inventory.mockClear()
    readScalars.mockClear()
    const [fromUi, fromMcp] = await Promise.all([
      browse().then(response => response.json()),
      call(granted, 'list_prs', { view: 'owner-ready', recheck: true }),
    ])
    const returned = fromUi.data as OwnerReadyRead
    expect(fromMcp.ownerReady).toEqual(returned)
    expect(returned.warnings.some(warning => warning.includes('main is'))).toBe(false)
    expect(returned.recheckedAt).toBeTruthy()
    expect(merge(returned, moving)).toMatchObject({ requestedHeads: [original], live: { head: changed, state: 'stale' } })
    expect(merge(returned, closing)).toBeUndefined()
    expect(merge(returned, unchanged)?.live?.state).toBe('ready')
    expect(bundle(returned, 'owner/repo')?.decisions.map(row => row.question)).toEqual(['Confirm the launch date', 'Choose a deployment window?'])
    expect(inventory.mock.calls.filter(([path]) => path.includes('state=open')).map(([path]) => path).sort()).toEqual([
      '/repos/owner/other/pulls?state=open&per_page=100&page=1', '/repos/owner/repo/pulls?state=open&per_page=100&page=1',
    ])
    expect(readScalars.mock.calls.map(([path]) => path).sort()).toEqual([
      `/repos/owner/other/commits/${sibling}/check-runs?per_page=100`,
      `/repos/owner/other/commits/${sibling}/status?per_page=100`, '/repos/owner/other/pulls/4',
    ])
    expect(sourceWrites).toEqual([])
    expect(sources.waitingOnMain).not.toHaveBeenCalled()
    expect(JSON.stringify({ tickets, notes: [...comments], notionNotes })).toBe(records)

    // A genuine replacement can refresh the ask; failed check coverage holds it.
    comments.get('10')!.unshift(entry(moving, changed, '26', '2026-11-23T13:00:00Z'))
    notionNotes.push('Tin Star answer: "notion-merge"')
    for (const source of mates) await snapshotFile(source, [])
    outage = true
    const unverified = (await (await browse()).json()).data as OwnerReadyRead
    expect(merge(unverified, moving)).toMatchObject({ requestedHeads: [changed], live: { head: changed, state: 'unverified' } })
    outage = false
    expect(merge((await (await browse()).json()).data, moving)).toMatchObject({
      requestedHeads: [changed], live: { head: changed, state: 'ready' },
      sources: expect.arrayContaining([
        expect.objectContaining({ url: expect.stringContaining('focusedCommentId=21'), requestedHead: original, superseded: true }),
        expect.objectContaining({ url: expect.stringContaining('focusedCommentId=26'), requestedHead: changed }),
      ]),
    })

    comments.get('10')!.unshift(...Array.from({ length: 250 }, (_, index) =>
      ({ id: String(index + 1000), body: 'Review update', created: '2026-11-23T14:00:00Z' })))
    comments.get('10')!.unshift(entry(moving, changed, '27', '2026-11-23T15:00:00Z'))
    boardHistoryUnavailable = true
    const retained = (await (await browse()).json()).data as OwnerReadyRead
    expect(merge(retained, moving)).toMatchObject({ requestedHeads: [changed], unverifiedRequest: true,
      live: { state: 'unverified' }, sources: expect.arrayContaining([
        expect.objectContaining({ url: expect.stringContaining('focusedCommentId=26'), requestedHead: changed }),
        expect.objectContaining({ url: expect.stringContaining('focusedCommentId=27'), requestedHead: changed }),
      ]) })
    expect(bundle(retained, 'owner/repo')?.decisions).toContainEqual(
      expect.objectContaining({ question: 'Choose a deployment window?', fresh: false }))

    comments.set('10', [entry(moving, changed, '27', '2026-11-23T15:00:00Z'),
      ...comments.get('10')!.slice(1, 50), entry(moving, original, '28')])
    const distinct = (await call(granted, 'list_prs', { view: 'owner-ready', recheck: true })).ownerReady as OwnerReadyRead
    expect(bundle(distinct, 'owner/repo')?.merges.filter(ask => ask.url === moving)).toHaveLength(1)
    expect(merge(distinct, moving)?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('focusedCommentId=27'), requestedHead: changed }),
      expect.objectContaining({ url: expect.stringContaining('focusedCommentId=28'), requestedHead: original, superseded: true }),
    ]))
    shiftCommentBoundary = true
    const shifted = (await (await browse()).json()).data as OwnerReadyRead
    expect(merge(shifted, moving)).toMatchObject({
      unverifiedRequest: true, live: { head: changed, state: 'unverified' },
      requestedHeads: [changed],
      sources: expect.arrayContaining([
        expect.objectContaining({ url: expect.stringContaining('focusedCommentId=28'), requestedHead: original, superseded: true }),
      ]),
    })
    expect(sourceWrites).toEqual([])
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

it('bounds same-head checks, rotates coverage, and holds a head that moves after the inventory read', async () => {
  const urls = Array.from({ length: 6 }, (_, index) => `https://github.com/owner/repo/pull/${index + 1}`)
  const expectedHeads = new Map(urls.map(url => [url, original]))
  const read = vi.fn(async (path: string) => {
    if (/\/pulls\/\d+$/.test(path)) return { state: 'open', merged: false, draft: false,
      head: path.endsWith('/1') ? changed : original, mergeable: true, mergeable_state: 'clean' }
    if (path.includes('/check-runs?')) return { total: 1, returned: 1, pending: 0, failed: 0 }
    return { total: 0, state: 'pending' }
  })
  const reader = new QueuePullReader(read)
  const first = await reader.get(urls, { force: true, expectedHeads })
  expect([...first.keys()].sort()).toEqual(urls.slice(0, 4))
  expect(first.get(urls[0]!)).toMatchObject({ head: changed, checks: 'unknown' })
  expect(read.mock.calls.map(([path]) => path).filter(path => path.includes(changed))).toEqual([])
  const next = await reader.get(urls, { force: true, expectedHeads })
  expect([...next.keys()]).toEqual(expect.arrayContaining(urls.slice(4)))
})

it('holds unrecognized head spellings as conditional merge requests', () => {
  for (const suffix of [`@ ${original}`, `head sha= ${original}`, `(head ${original})`]) {
    expect(mergePublication(`Will: merge ${moving} ${suffix}`, true)).toMatchObject({ head: null, conditional: true })
  }
})

it('accepts worker checks-green notices and rejects Jira-style worker prose', () => {
  expect(readyHeadPublication(`done: PR ${moving} checks green at head ${original}`)).toMatchObject({ head: original })
  expect(readyHeadPublication(`done: Will: merge ${moving} head ${original}`)).toBeNull()
})

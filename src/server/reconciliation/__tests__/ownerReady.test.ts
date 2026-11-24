import { expect, it, vi } from 'vitest'
import { createServer, IncomingMessage, Server } from 'node:http'
import { Socket } from 'node:net'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { jiraConfig, startJiraWebhook } from '../../../../event-publisher/jira.js'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { runTswStatusSync } from '../../../coordinator/tswStatusSync'
import type { OwnerReadyRead } from '../../../shared/ownerReady'
import { handleReconciliationRequest, ReconciliationSources } from '..'
import { DomainReadTools } from '../domainReads'
import { ReconciliationMcp } from '../mcp'
import { authorizePrReadGrant } from '../prReadGrant'
import { mergePublication, readyHeadPublication } from '../ownerRequestEvidence'
import { verifyOwnerMerges } from '../ownerReady'
import { releasePull } from '../../../shared/pullIdentity'
import { NotionApi } from '../notionApi'
import { SceneReconciler } from '../scene'
import { QueuePullReader } from '../queuePulls'
import { PullReader } from '../../pulls/reader'
import { PullsApi } from '../../pulls/routes'
import { AssociationStore } from '../../releases/associations'

const { Journal } = createRequire(import.meta.url)('../../../../event-publisher/journal.js') as typeof import('../../../../event-publisher/journal.js')

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
const cloudId = '7d1bfc1a-cf35-4405-8f3e-71b6cefb7c91'
const jiraSite = 'https://example.atlassian.net'
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
  const publishReady = (index: number, url: string, head = original) => snapshotFile(mates[index]!, [{
    id: `delivery-${index}`, kind: 'ship', spawn_gen: `attempt-${index}`, backlog: { body_lines: ['card: TSW-10'] },
    yolo: 'off',
    current_state: { state: 'done', freshness: 'fresh', detail: 'checks green: PR ready for review' },
    pr: { url, head }, hints: { last_event_text: `done: PR ${url} checks green at head ${head}` },
  }])
  await publishReady(0, moving)
  await publishReady(1, moving + '/')
  const liveHeads = new Map([[moving, original], [closing, sibling], [legacy, original], [unchanged, sibling], [releaseWait, sibling]])
  const questions = 'D1 [Open]: Choose launch wording\n\nD2 [Open]: Confirm the launch date'
  const review = issue('10', questions)
  const tickets = [review, issue('11'), issue('12'), issue('13'), issue('14', 'D1 [Open]: Select a recovery option', 'Decision'), issue('15')]
  const comments = new Map([
    ['10', [...Array.from({ length: 49 }, (_, index) => ({ id: String(index + 100), body: 'Review update', created: '2026-11-23T12:00:00Z' })),
      entry(moving + '?notice=retry', '', '20'),
      { ...entry(restricted, original, '19'), visibility: { type: 'role' } }, entry(historical, original, '18', '2026-11-23T08:00:00Z')]],
    ['11', [entry(closing, sibling, '22')]], ['12', [entry(legacy, '', '23')]],
    ['13', [entry(unchanged, sibling, '24')]], ['15', [entry(outsider, original, '25')]],
  ])
  const repoBoard = fixtureSources()
  const [native, production] = repoBoard.intentions.data!.cards
  native!.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Merge', 'Decision'], hasMore: false }
  native!.properties.Link = { id: 'pull', type: 'url', value: moving, hasMore: false }
  native!.properties['Next action'] = { id: 'next', type: 'rich_text', value: `Merge ${moving} head ${original}`, hasMore: false }
  production!.properties.Status!.value = 'Waiting for Prod Release'
  production!.properties.Link = { id: 'pull', type: 'url', value: releaseWait, hasMore: false }
  repoBoard.intentions.data!.cards = [native!, production!]
  const notionNotes: string[] = [
    `Tin Star request: {"id":"notion-merge","action":"Merge"}\nRequested from: Will\nQuestion: Merge ${moving} head ${original}`,
    'Tin Star request: {"id":"notion-choice","action":"Decision"}\nRequested from: Will\nQuestion: Choose a deployment window?',
  ]
  let boardHistoryUnavailable = false
  let shiftCommentBoundary = false
  let olderJiraHistoryUnavailable = false
  let holdJiraPage: ((response: Response) => Promise<Response>) | undefined
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
      return Response.json({ results: notionNotes.map((note, index) => ({ id: index === 0 ? mergeComment : `native-${index}`, created_time: '2026-11-23T11:30:00Z', rich_text: [{ plain_text: note }] })), has_more: false })
    }
    const [, id, resource] = /\/issue\/(\d+)(?:\/(comment|changelog))?$/.exec(path) ?? []
    if (resource === 'comment') {
      const rows = comments.get(id!) ?? []
      const startAt = Number(new URL(String(input)).searchParams.get('startAt'))
      const page = id === '10' && shiftCommentBoundary && startAt > 0
        ? [...rows.slice(1), { id: '9999', created: '2026-11-23T07:00:00Z', body: 'Review update' }] : rows
      const response = Response.json({ startAt, total: page.length, comments: page.slice(startAt, startAt + 50) })
      if (id === '10' && startAt === 0 && holdJiraPage) {
        const hold = holdJiraPage
        holdJiraPage = undefined
        return hold(response)
      }
      return response
    }
    if (resource === 'changelog') {
      if (id === '16' && olderJiraHistoryUnavailable) return new Response(null, { status: 503 })
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
    if (path.endsWith('/pulls/3')) return { state: 'open', merged: false, draft: false, head: original, mergeable: true, mergeable_state: 'clean' }
    if (path.endsWith('/pulls/2')) return { state: liveHeads.has(closing) ? 'open' : 'closed', merged: false, draft: false, head: sibling, mergeable: true, mergeable_state: 'clean' }
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
      jiraWork: { mode: 'work', url: jiraSite, cloudId,
        projectId: project, fields, issueTypes: { Task: '1' }, blocksLinkTypeId: '42', token: 'fixture' } }, readSource, undefined, root)
    vi.spyOn(sources, 'snapshot').mockImplementation(async force => ({ ...repoBoard,
      generatedAt: new Date().toISOString(), fleet: await sources.fleetSnapshot(force), diagnostics: { notion: sources.notionApi.diagnostics } }))
    sources.waitingOnMain = vi.fn(async () => { throw new Error('Return recheck must not invoke Main wait notifications') })
    const pulls = new PullsApi(sources, new AssociationStore(root), root, new PullReader(inventory, Date.now, new QueuePullReader(readScalars)))
    sources.authorizePulls = req => pulls.authorized(req)
    sources.readOwnerInventory = (repositories, force, scene) => pulls.readForReconciliation(force, repositories, scene)
    sources.readPulls = async () => pulls.readForReconciliation(false, undefined, new SceneReconciler().project(await sources.snapshot()))
    const schedule = vi.fn<NonNullable<ReconciliationSources['readPullReadiness']>>((...args) => pulls.readiness(...args))
    sources.readPullReadiness = schedule
    return { sources, pulls, schedule }
  }
  let { sources, pulls, schedule } = makeSources()
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
    const browse = (owner = true) => fetch(`${base}/api/reconciliation/owner-ready`, {
      headers: owner ? { 'Tailscale-User-Login': author } : undefined,
    })

    await snapshotFile(main!, [])
    expect((await sources.fleetSnapshot(true))[0]!.observation.status).toBe('fresh')
    await rm(main!.snapshotFile)
    let coordinatorStatus = 'In Progress'
    let coordinatorAssignee: string | null = null
    const coordinatorHistory: Array<{ field: 'status' | 'assignee'; from: string | null; to: string; byService: boolean; occurredAt: number; entryId: string }> = []
    const edit = vi.fn(async (input: { note?: string }, actor: string) => {
      if (!input.note) throw new Error('Expected a coordinator merge note')
      comments.get('10')!.unshift({ id: '21', body: `${input.note}\n\nRecorded via Tin Star (${actor})`, created: '2026-11-23T12:00:00Z' })
      coordinatorHistory.push({ field: 'assignee', from: coordinatorAssignee, to: 'fixture-will', byService: true, occurredAt: Date.now(), entryId: '1' })
      coordinatorAssignee = 'fixture-will'
      return { outcome: 'saved' }
    })
    const sync = async () => runTswStatusSync(await sources.fleetSnapshot(true), {
      apply: true, maxCards: 1, stateFile: join(root, 'status-checkpoint.json'), audit: async () => {},
      jira: {
        readTswCard: async () => ({
          id: 'fixture:10', issue_id: '10', key: 'TSW-10', url: `${jiraSite}/browse/TSW-10`,
          project_id: project, issue_type: 'Task', name: 'Fixture delivery', status: coordinatorStatus,
          updated_at: generated, owner: 'Firstmate mate-a', assignee: coordinatorAssignee && 'William Gathright', assignee_id: coordinatorAssignee,
          description: '', links: [], decision_questions: [], decision_text: questions, blocker: null,
        }),
        statusHistory: async (_id, after) => ({
          cursor: { total: coordinatorHistory.length, last: coordinatorHistory.at(-1)?.entryId ?? null },
          changes: coordinatorHistory.slice(after?.total ?? 0),
        }),
        findAssignableAccount: async () => 'fixture-will',
        tswReviewNote: async () => undefined,
        edit,
        transition: async () => {
          coordinatorHistory.push({ field: 'status', from: coordinatorStatus, to: 'Ready for Review', byService: true, occurredAt: Date.now(), entryId: '2' })
          coordinatorStatus = 'Ready for Review'
          return { outcome: 'saved' }
        },
        repairTransitionAudit: vi.fn(),
      },
    })
    for (const [url, head] of [[moving, changed], [closing, original]] as const) {
      await publishReady(1, url, head)
      const conflict = await sync()
      expect(conflict.plans).toEqual([])
      expect(conflict.audits.filter(entry => entry.result === 'competing-task-events')).toHaveLength(2)
    }
    expect(edit).not.toHaveBeenCalled()
    await publishReady(1, moving + '/')
    expect(await sync()).toMatchObject({ stopped: false, plans: [{ event: { head: original } }] })
    expect(await sync()).toMatchObject({ stopped: false, plans: [] })
    expect(coordinatorStatus).toBe('Ready for Review')
    expect(edit).toHaveBeenCalledTimes(1)
    expect(comments.get('10')![0]?.body).toContain('Recorded via Tin Star (Firstmate mate-a, Firstmate mate-b)')
    const journal = new Journal(join(root, 'outage-events.sqlite'))
    const publisherConfig = jiraConfig({ site: jiraSite, cloudId, projectId: project, fields })
    const secret = randomBytes(32).toString('hex')
    const deliveryId = 'fixture-merge-publication'
    try {
      journal.registerSources([publisherConfig.source])
      const listen = Server.prototype.listen
      const ephemeralListener = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
        return Reflect.apply(listen, this, [0, '127.0.0.1'])
      })
      const publisher = await startJiraWebhook(journal, publisherConfig, secret, secret).finally(() => ephemeralListener.mockRestore())
      try {
        const note = comments.get('10')![0]!
        const body = JSON.stringify({ webhookEvent: 'comment_created', issue: review, comment: note, timestamp: Date.parse(note.created) })
        const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
        const deliver = () => fetch(publisher.url, { method: 'POST', body, headers: {
          'Content-Type': 'application/json', 'X-Atlassian-Webhook-Identifier': deliveryId, 'X-Hub-Signature': signature,
        } })
        expect((await deliver()).status).toBe(204)
        expect((await deliver()).status).toBe(204)
        const notices = journal.events()
        expect(notices).toHaveLength(1)
        expect(notices[0]).toMatchObject({ event_type: 'ticket.comment.created', source: { delivery_id: deliveryId }, change: { after: note.body } })
      } finally { await publisher.close() }
    } finally { journal.close() }
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
    expect((await browse(false)).status).toBe(403)
    expect(inventory).not.toHaveBeenCalled()

    // Reconstruct Tin Star with a stale Main file and the very same native records.
    await snapshotFile(main!, [], new Date(Date.now() - 3600_000).toISOString())
    ;({ sources, pulls, schedule } = makeSources())
    const restarted = (await call(granted, 'list_prs', { view: 'owner-ready' })).ownerReady as OwnerReadyRead
    expect(restarted.warnings).toContainEqual(expect.stringContaining('Fleet coverage for main is stale'))
    expect(merge(restarted, moving)?.live?.state).toBe('ready')
    const withDefaults = await call(granted, 'list_prs', { view: 'owner-ready', offset: 0, limit: 25 })
    expect(withDefaults.outcome).toBe('available')
    expect(merge(withDefaults.ownerReady, moving)).toMatchObject({ requestedHeads: [original], live: { state: 'ready' } })
    expect(merge(restarted, legacy)).toMatchObject({ requestedHeads: [], unverifiedRequest: true, live: { head: original, state: 'unverified' } })
    expect(merge(restarted, outsider)?.live).toMatchObject({ head: null, state: 'unverified' })

    liveHeads.set(moving, changed)
    liveHeads.delete(closing)
    liveHeads.delete(legacy)
    comments.set('12', [entry(legacy, sibling, '23')])
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
    expect(merge(returned, legacy)).toMatchObject({ requestedHeads: [sibling], live: { head: original, state: 'stale' } })
    expect(merge(returned, unchanged)?.live?.state).toBe('ready')
    expect(bundle(returned, 'owner/repo')?.decisions.map(row => row.question)).toEqual(['Confirm the launch date', 'Choose a deployment window?'])
    expect(inventory.mock.calls.filter(([path]) => path.includes('state=open')).map(([path]) => path).sort()).toEqual([
      '/repos/owner/other/pulls?state=open&per_page=100&page=1', '/repos/owner/repo/pulls?state=open&per_page=100&page=1',
    ])
    expect(readScalars.mock.calls.map(([path]) => path).sort()).toEqual([
      `/repos/owner/other/commits/${sibling}/check-runs?per_page=100`,
      `/repos/owner/other/commits/${sibling}/status?per_page=100`, '/repos/owner/other/pulls/4',
      '/repos/owner/repo/pulls/2', '/repos/owner/repo/pulls/3',
    ])
    expect(sourceWrites).toEqual([])
    expect(sources.waitingOnMain).not.toHaveBeenCalled()
    expect(JSON.stringify({ tickets, notes: [...comments], notionNotes })).toBe(records)

    liveHeads.set(legacy, original)
    comments.set('12', [entry(legacy, '', '23')])

    // A genuine replacement can refresh the ask; failed check coverage holds it.
    comments.get('10')!.unshift(entry(moving, changed, '26', '2026-11-23T13:00:00Z'))
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

    tickets.push(issue('16'))
    comments.set('16', [entry(moving, original, '30', '2026-11-23T11:00:00Z')])
    await browse()
    olderJiraHistoryUnavailable = true
    const olderUnavailable = (await (await browse()).json()).data as OwnerReadyRead
    expect(olderUnavailable.warnings).toEqual(expect.arrayContaining([expect.stringContaining('TSW-16')]))
    expect(merge(olderUnavailable, moving)).toMatchObject({ requestedHeads: [changed], live: { state: 'ready' },
      sources: expect.arrayContaining([expect.objectContaining({ url: expect.stringContaining('focusedCommentId=30'), superseded: true })]) })

    const conditional = { ...entry(moving, '', '29', '2026-11-23T13:30:00Z'), body: `Will: merge ${moving} after rollout` }
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    const pageStarted = new Promise<void>(resolve => {
      holdJiraPage = async response => { resolve(); await gate; return response }
    })
    const ordinaryJira = sources.jiraWork!.ownerRequests.get(true)
    await pageStarted
    comments.get('10')!.unshift(conditional)
    readScalars.mockClear()
    const waiting = await browse().then(response => response.json()).then(body => body.data as OwnerReadyRead).finally(resume)
    await ordinaryJira
    expect(merge(waiting, moving)).toMatchObject({ requestedHeads: [], unverifiedRequest: true, live: { state: 'unverified' },
      sources: expect.arrayContaining([expect.objectContaining({ kind: 'notion', requestedHead: original, readinessEvidenceOnly: true })]) })
    expect(readScalars.mock.calls.some(([path]) => path === '/repos/owner/repo/pulls/1')).toBe(false)
    const req = new IncomingMessage(new Socket())
    Object.defineProperty(req.socket, 'remoteAddress', { value: '127.0.0.1' })
    req.headers['tailscale-user-login'] = author
    schedule.mockClear()
    const queue = await sources.queue(req, undefined, true, 'read', true)
    expect(queue.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'merge',
      evidence: expect.arrayContaining([expect.objectContaining({ kind: 'pull-request', url: moving })]) })]))
    expect(merge(queue.ownerReady!, moving)?.unverifiedRequest).toBe(true)
    const normal = await sources.queue(req, undefined, true, 'read')
    const mergeRow = (result: typeof queue) => result.items.find(item => item.kind === 'merge' && item.evidence.some(link => link.url === moving))
    expect(mergeRow(queue)).toEqual(mergeRow(normal))
    const ordinaryCalls = schedule.mock.calls.filter(([, options]) => !options)
    expect(ordinaryCalls.map(([urls]) => urls)).toEqual([expect.arrayContaining([moving]), expect.arrayContaining([moving])])
    const bundleCalls = schedule.mock.calls.filter(([, options]) => options?.expectedHeads)
    expect(bundleCalls).toHaveLength(1)
    expect(bundleCalls[0]?.[0]).not.toContain(moving)
    comments.get('10')!.shift()
    notionNotes.push('Tin Star answer: "notion-merge"')

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
    boardHistoryUnavailable = false
    notionNotes.push('Tin Star answer: "notion-choice"')
    native!.properties['Next action']!.value = 'Choose a follow-up deployment window'
    const laterDecision = (await (await browse()).json()).data as OwnerReadyRead
    const decisions = bundle(laterDecision, 'owner/repo')?.decisions
    expect(decisions).toContainEqual(expect.objectContaining({ question: 'Choose a follow-up deployment window',
      sources: [expect.objectContaining({ label: 'Decision action' })] }))
    expect(decisions?.map(decision => decision.question)).not.toContain('Choose a deployment window?')

    native!.properties['Next action']!.value = `Merge ${moving} head ${sibling}`
    const laterMerge = (await (await browse()).json()).data as OwnerReadyRead
    expect(merge(laterMerge, moving)?.sources).toContainEqual(expect.objectContaining({
      label: 'Merge action', requestedHead: sibling, readinessEvidenceOnly: true,
    }))
    expect(merge(laterMerge, moving)?.sources.map(source => source.label)).not.toContain('notion-merge')
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

it.each([true, false])('holds unrecognized head spellings as conditional merge requests (Jira: %s)', jira => {
  const request = `${jira ? 'Will: merge' : 'Merge'} ${moving}`
  expect(mergePublication(`${request} head ${original}`, jira)).toMatchObject({ head: original, conditional: false })
  for (const suffix of [original, `at head ${original}`, `@ ${original}`, `head sha= ${original}`, `(head ${original})`, `head ${original} (ready for review)`, '(ready for review)']) {
    expect(mergePublication(`${request} ${suffix}`, jira)).toMatchObject({ head: null, conditional: true })
  }
})

it('rejects the Please merge alias in owner request records', () => {
  expect(mergePublication(`Please merge ${moving} head ${original}`)).toBeNull()
})

it('accepts worker checks-green notices and rejects Jira-style worker prose', () => {
  expect(readyHeadPublication(`done: PR ${moving} checks green at head ${original}`)).toMatchObject({ head: original })
  expect(readyHeadPublication(`done: Will: merge ${moving} head ${original}`)).toBeNull()
  expect(readyHeadPublication(`pr-ready: PR ${moving} checks green at head ${original}`)).toBeNull()
  expect(readyHeadPublication(`PR ${moving} checks green at head ${original}`)).toBeNull()
  expect(readyHeadPublication(`done: PR ${moving} checks green ${original}`)).toBeNull()
})

it('retains explicit closure when another associated PR summary fails', async () => {
  const at = new Date().toISOString()
  const reader = new PullReader(async path => {
    if (path.startsWith('/search/issues')) return { total_count: 0, incomplete_results: false, items: [] }
    if (path.endsWith('/pulls/2')) return { state: 'closed', number: 2, html_url: closing, title: 'Closed fixture',
      user: { login: 'owner' }, draft: false, head: { sha: sibling }, base: { ref: 'main' }, created_at: at, updated_at: at }
    throw new Error('Unrelated summary unavailable')
  })
  const [repo] = await reader.inventory(['owner/repo'], { account: 'member', owners: ['member'],
    associated: [releasePull(closing)!, releasePull(moving)!] })
  expect(repo!.coverage.complete).toBe(false)
  const read: OwnerReadyRead = { observedAt: at, warnings: [], repositories: [{ repository: 'owner/repo', decisions: [],
    merges: [closing, moving].map(url => ({ url, requestedHeads: [sibling], unverifiedRequest: false, fresh: true, sources: [] })) }] }
  verifyOwnerMerges(read, { pulls: [], closedPulls: repo!.closedPulls, repositories: [repo!.coverage],
    warnings: [], associationsComplete: true }, new Map())
  expect(read.repositories[0]?.merges).toMatchObject([{ url: moving, live: { state: 'unverified' } }])
})

it('rotates five owner histories beyond the ordinary twenty without displacing queue history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-owner-history-'))
  try {
    const snapshot = fixtureSources({ size: 26 })
    snapshot.fleet = []
    const board = snapshot.intentions.data!
    const { dataSourceId } = board
    if (dataSourceId === null) throw new Error('Expected a fixture data source ID')
    board.cards = board.cards.slice(-26)
    for (const card of board.cards) {
      card.properties.Status!.value = 'In Progress'
      card.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Decision'], hasMore: false }
    }
    const historyReads: string[] = []
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input))
      if (url.pathname !== '/v1/comments') throw new Error('Unexpected fixture request')
      const id = url.searchParams.get('block_id')!
      historyReads.push(id)
      return Response.json({ has_more: false, results: [{
        id, rich_text: [{ plain_text: `Tin Star request: {"id":"${id}","action":"Decision"}\nRequested from: Will\nQuestion: Review ${id}?` }],
      }] })
    }
    const sources = new ReconciliationSources({ fleet: [], warnings: [], notion: { dataSourceId, token: 'fixture' } },
      fetcher, new NotionApi(fetcher, 0), root)
    vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
    await sources.queue(undefined, undefined, true, 'read')
    const ordinary = historyReads.splice(0)
    expect(ordinary).toHaveLength(20)
    const remaining = board.cards.map(card => card.id).filter(id => !ordinary.includes(id))
    expect(remaining).toHaveLength(6)
    const first = await sources.queue(undefined, undefined, true, 'read', true)
    expect(historyReads.splice(0)).toEqual([...ordinary, ...remaining.slice(0, 5)])
    const lastQuestion = `Review ${remaining[5]}?`
    const questions = (result: typeof first) => result.ownerReady?.repositories.flatMap(group => group.decisions.map(decision => decision.question))
    expect(questions(first)).not.toContain(lastQuestion)
    const next = await sources.queue(undefined, undefined, true, 'read', true)
    expect(historyReads).toEqual([...ordinary, remaining[5], ...remaining.slice(0, 4)])
    expect(questions(next)).toContain(lastQuestion)
  } finally { await rm(root, { recursive: true, force: true }) }
})

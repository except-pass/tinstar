import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it } from 'vitest'
import { loadReconciliationConfig, type JiraWorkConfig } from '../config'
import { ReconciliationSources } from '..'
import { ReconciliationMcp } from '../mcp'
import { jiraTransitions, jiraVerbs } from '../jiraWorkRules'
import { externalWorkers } from '../../../shared/workflow'
import { decisionRequests } from '../../../shared/workflowRequests'

const cloudId = '5bac40b8-c168-4931-90d1-2c8dfe15c6ea'
const config = {
  mode: 'work', url: 'https://sample.atlassian.net', cloudId, projectId: '10001', token: 'fixture-scoped-service-token',
  issueTypes: { Task: '10100', Epic: '10101' },
  fields: { owner: 'customfield_11001', decisions: 'customfield_11002', blockerType: 'customfield_11003', blockerTarget: 'customfield_11004', blockerCondition: 'customfield_11005' },
  blocksLinkTypeId: '10000',
} satisfies JiraWorkConfig
const roots: string[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('rejects Jira work configuration that aliases Epic to Task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jira-work-config-'))
  roots.push(root)
  const jira = { ...config, issueTypes: { Task: config.issueTypes.Task, Epic: config.issueTypes.Task } }
  await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: { jira } }))
  const loaded = loadReconciliationConfig(root)
  expect(loaded.jiraWork).toBeUndefined()
  expect(loaded.warnings).toEqual([expect.stringContaining('Invalid Jira work settings')])
})

const types = [
  { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  { id: '10001', name: 'Relates', inward: 'relates to', outward: 'relates to' },
]
const transitions = jiraVerbs.flatMap((name, index) => jiraTransitions[name][1].map((to, destination) => ({
  id: String(index * 10 + destination + 1), name, to: { name: to },
})))
const localizedStatuses = new Map([
  ['Backlog', '待处理'], ['To Do', '待办'], ['Queued', '已排队'], ['In Progress', '正在进行'],
  ['Decision', '决策'], ['Waiting For', '等待中'], ['Ready for Review', '准备审查'],
  ['Waiting for Prod Release', '等待发布'], ['Verify in Prod', '生产验证'], ['Done', '完成'], ['Canceled', '已取消'],
])
const jiraNow = () => new Date(Date.now() - 5000).toISOString()
/** Blank paragraphs come back without a content array. TSW-1 comments 56761 and 56765. */
function jiraStoredBody(body: any) {
  if (!body || body.type !== 'doc' || !Array.isArray(body.content)) return body
  return {
    ...body,
    content: body.content.map((node: any) => node?.type === 'paragraph' && Array.isArray(node.content) && node.content.length === 0
      ? { type: 'paragraph' }
      : node),
  }
}
const response = (value: unknown, status = 200) => value === undefined
  ? new Response(null, { status })
  : new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jira-work-mcp-'))
  roots.push(root)
  const { token: _token, ...settings } = config
  await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: { jira: { ...settings, token: config.token } } }), { mode: 0o600 })
  const parsed = loadReconciliationConfig(root)
  expect(parsed.jiraWork).toMatchObject(settings)
  expect(parsed.jira).toBeUndefined()
  const historicalKeys = new Map<string, string>()
  const requests: { method: string; path: string; fields: string | null }[] = []
  const controls = { loseCreate: false, loseEdit: false, refuseTransition: false, omitComment: false, commentResponse: undefined as 'lost' | 'unreadable' | 'rejected' | 'wrong-id' | undefined, directCommentOverrides: {} as Record<string, unknown>, statusDuringCommentRead: '', loseBaselineTime: false, newerCommentsAfterPost: false, rejectSearch: false, staleSearch: false, wrongCreate: false, beforeWrite: '', loseLink: false, moveDuringComments: false, delayedComment: '', delayedCommentAuthor: 'fixture-service', delayedCommentTime: '', transitionList: undefined as Array<{ id: string; name: string; to: { id?: string; name: string }; isAvailable?: boolean }> | undefined, lastTransitionId: '' }
  const issues = new Map<string, { id: string; key: string; fields: Record<string, any>; properties: Record<string, unknown>; comments: any[] }>()
  const links = new Map<string, { type: typeof types[number]; inwardIssue: string; outwardIssue: string }>()
  let nextIssue = 60001, nextLink = 8001
  const make = (id: string, key: string, project: string, fields: Record<string, any> = {}) => ({
    id, key, fields: { summary: 'Fixture', status: { name: 'Backlog' }, updated: '2026-01-01T12:00:00Z',
      issuetype: { id: config.issueTypes.Task }, description: null, project: { id: project },
      ...Object.fromEntries(Object.values(config.fields).map(field => [field, null])), ...fields },
    properties: Object.create(null) as Record<string, unknown>, comments: [] as any[],
  })
  issues.set('70001', make('70001', 'OTHER-1', '10002'))
  const fetcher: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw))
    expect(url.origin).toBe('https://api.atlassian.com')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${config.token}`)
    const english = headers.get('accept-language') === 'en' && headers.get('x-force-accept-language') === 'true'
    const statusName = (name: string) => english ? name : localizedStatuses.get(name) ?? name
    const path = url.pathname.replace(`/ex/jira/${cloudId}/rest/api/3/`, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, fields: url.searchParams.get('fields') })
    if (controls.beforeWrite === `${method} ${path}`) {
      controls.beforeWrite = ''
      throw new Error('Process stopped before Jira received the write')
    }
    if (path === 'serverInfo') {
      if (controls.loseBaselineTime) throw new Error('Dropped server time response')
      return response({ serverTime: jiraNow() })
    }
    if (path === 'myself') return response({ accountId: 'fixture-service' })
    if (path === 'search/jql') {
      if (controls.rejectSearch) return response({}, 403)
      expect(body.jql).toContain(`project = ${config.projectId}`)
      return response({ isLast: true, issues: controls.staleSearch ? [] : [...issues.values()].filter(issue => issue.fields.project.id === config.projectId) })
    }
    if (path === 'issue' && method === 'POST') {
      if (body.fields[config.fields.owner] && !['Avery', 'Taylor'].includes(body.fields[config.fields.owner].value)) return response({}, 400)
      const id = String(nextIssue++)
      const issue = make(id, `WORK-${Number(id) - 60000}`, config.projectId, body.fields)
      if (controls.wrongCreate) issue.fields.summary = 'Unexpected Jira summary'
      issues.set(id, issue)
      for (const property of body.properties ?? []) issue.properties[property.key] = property.value
      if (controls.loseCreate) { controls.loseCreate = false; throw new Error('Dropped response containing fixture-scoped-service-token') }
      return response({ id, key: issue.key }, 201)
    }
    if (path === 'issueLinkType') return response({ issueLinkTypes: types })
    if (path === 'issueLink' && method === 'POST') {
      const type = types.find(type => type.id === body.type.id)!
      const endpoint = (issue: { id?: string; key?: string }) => issue.id ?? [...issues.values()].find(candidate => candidate.key === issue.key)?.id
      const inwardIssue = endpoint(body.inwardIssue)
      const outwardIssue = endpoint(body.outwardIssue)
      if (!inwardIssue || !outwardIssue) return response({}, 404)
      links.set(String(nextLink++), { type, inwardIssue, outwardIssue })
      if (controls.loseLink) { controls.loseLink = false; throw new Error('Dropped link response') }
      return response(undefined, 201)
    }
    const linkPath = /^issueLink\/(\d+)$/.exec(path)
    if (linkPath && method === 'DELETE') return links.delete(linkPath[1]!) ? response(undefined, 200) : response({}, 404)
    const match = /^issue\/([^/]+)(?:\/(.*))?$/.exec(path)
    if (!match) throw new Error(`Unexpected fixture request ${method} ${path}`)
    const issue = issues.get(historicalKeys.get(match[1]!) ?? match[1]!) ?? [...issues.values()].find(issue => issue.key === match[1])
    if (!issue) return response({}, 404)
    const part = match[2]
    if (!part && method === 'GET') {
      if (url.searchParams.get('fields') === 'project') return response({ id: issue.id, key: issue.key, fields: { project: issue.fields.project } })
      const issuelinks = [...links].filter(([, link]) => [link.inwardIssue, link.outwardIssue].includes(issue.id)).map(([id, link]) => {
        const inward = issue.id === link.outwardIssue
        const target = issues.get(inward ? link.inwardIssue : link.outwardIssue)!
        return { id, type: link.type, [inward ? 'inwardIssue' : 'outwardIssue']: { id: target.id, key: target.key } }
      })
      const status = { ...issue.fields.status, name: statusName(issue.fields.status.name) }
      return response({ ...issue, fields: { ...issue.fields, status, issuelinks } })
    }
    if (part?.startsWith('properties/') && method === 'GET') {
      const key = part.slice('properties/'.length)
      return Object.hasOwn(issue.properties, key) ? response({ key, value: issue.properties[key] }) : response({}, 404)
    }
    if (method === 'GET' && (part === 'comment' || part?.startsWith('comment/'))) {
      const commentId = part === 'comment' ? undefined : part.slice('comment/'.length)
      if (controls.moveDuringComments) {
        issue.fields.project = { id: '10002' }
        issue.comments.push({ id: 'foreign', body: 'Destination project comment' })
      }
      if (controls.statusDuringCommentRead && requests.some(request => request.method === 'POST' && request.path === `issue/${issue.id}/comment`)) {
        issue.fields.status = { name: controls.statusDuringCommentRead }
      }
      if (commentId) {
        const comment = issue.comments.find(comment => comment.id === commentId)
        return comment ? response({ ...comment, ...controls.directCommentOverrides }) : response({}, 404)
      }
      const startAt = Number(url.searchParams.get('startAt'))
      return response({ startAt, total: issue.comments.length, comments: issue.comments.slice(startAt, startAt + 50) })
    }
    if (part === 'comment' && method === 'POST') {
      if (controls.commentResponse === 'rejected') return response({}, 403)
      const created = jiraNow()
      if (!controls.omitComment) {
        issue.comments.push({ id: String(issue.comments.length + 1), body: jiraStoredBody(body.body), created, updated: created, author: { accountId: 'fixture-service' } })
      }
      if (controls.commentResponse === 'lost') throw new Error('Dropped comment write response')
      if (controls.commentResponse === 'unreadable') return new Response('{', { status: 201 })
      const id = String(issue.comments.length + Number(controls.omitComment || controls.commentResponse === 'wrong-id'))
      if (controls.newerCommentsAfterPost) {
        issue.comments.unshift(...Array.from({ length: 50 }, (_, i) => ({ id: `new-${i}`, body: 'Newer comment' })))
      }
      return response({ id, created }, 201)
    }
    if (part === 'transitions' && method === 'GET') {
      const available = controls.transitionList ?? transitions.filter(transition => jiraTransitions[transition.name][0].some(status => status === issue.fields.status.name))
      const offered = available.map(transition => ({
        ...transition, to: { ...transition.to, name: statusName(transition.to.name) },
      }))
      return response({ transitions: offered })
    }
    if ((!part && method === 'PUT') || (part === 'transitions' && method === 'POST')) {
      if (part && controls.refuseTransition) return response({}, 409)
      if (!part && body.fields[config.fields.owner] && !['Avery', 'Taylor'].includes(body.fields[config.fields.owner].value)) return response({}, 400)
      if (part) {
        controls.lastTransitionId = body.transition.id
        issue.fields.status = (controls.transitionList ?? transitions).find(transition => transition.id === body.transition.id)!.to
      }
      Object.assign(issue.fields, body.fields)
      for (const property of body.properties ?? []) issue.properties[property.key] = property.value
      const created = jiraNow()
      for (const comment of body.update?.comment ?? []) {
        if (!controls.omitComment) {
          issue.comments.push({ id: String(issue.comments.length + 1), body: jiraStoredBody(comment.add.body), created, updated: created, author: { accountId: 'fixture-service' } })
        }
      }
      if (controls.delayedComment) {
        issue.comments.push({ id: 'delayed', body: controls.delayedComment, created: controls.delayedCommentTime || created, updated: controls.delayedCommentTime || created, author: { accountId: controls.delayedCommentAuthor } })
      }
      if (controls.loseEdit) { controls.loseEdit = false; throw new Error('Dropped issue write response') }
      return response(undefined, 204)
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`)
  }
  async function connect(actor = 'Fixture agent') {
    const sources = new ReconciliationSources(parsed, fetcher, undefined, root)
    const mcp = new ReconciliationMcp(sources, root)
    const [remote, local] = InMemoryTransport.createLinkedPair()
    const server = mcp.createServer(actor)
    await server.connect(local)
    const client = new Client({ name: 'jira-work-test', version: '1' })
    clients.push(client)
    await client.connect(remote)
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError ?? false, JSON.stringify(result)).toBe(false)
      const content = result.content as Array<{ type: string; text: string }>
      return JSON.parse(content[0]!.text)
    }
    return { client, call }
  }
  return { root, connect, requests, controls, issues, links, historicalKeys }
}

it('publishes branch-specific update IDs and TSW workflow reference IDs', async () => {
  const { client } = await (await fixture()).connect()
  const { tools } = await client.listTools()
  const ajv = addFormats(new Ajv({ strict: false }))
  const update = ajv.compile(tools.find(tool => tool.name === 'update_work')!.inputSchema)
  const create = ajv.compile(tools.find(tool => tool.name === 'create_work')!.inputSchema)
  const start = ajv.compile(tools.find(tool => tool.name === 'start_work')!.inputSchema)
  const notion = 'a'.repeat(32)
  const tsw = 'jira:fortresspower-jira.atlassian.net:10639:60001'
  const pilot = tsw.replace(':10639:', ':10638:')
  const operation_id = 'schema-proof'
  const edit = { kind: 'edit', card_id: notion, operation_id }
  const observed_at = '2026-11-23T20:00:00Z'
  for (const fields of [
    { kind: 'complete', disposition: 'Completed fixture', evidence: 'Read back fixture' },
    { kind: 'park', disposition: 'Parked fixture' },
    { kind: 'edit', note: 'Fixture note' },
    { kind: 'wait', type: 'Event', id: 'fixture', dependency: 'Fixture deployment',
      unblocks_when: 'Deployment verified', follow_up_by: 'Hulk', next_check_in: observed_at },
  ]) {
    expect(update({ card_id: notion, operation_id, ...fields }), ajv.errorsText(update.errors)).toBe(true)
  }
  expect(update({ ...edit, kind: 'jira_edit', card_id: tsw, note: 'Fixture' })).toBe(true)
  expect(update({ ...edit, kind: 'jira_edit', note: 'Fixture' })).toBe(false)

  for (const [card_id, accepted] of [[notion, true], [tsw, true], [pilot, true], [tsw.replace(':10639:', ':10640:'), false]] as const) {
    for (const name of ['Parent item', 'Epic', 'Initiative']) {
      const properties = { [name]: [card_id] }
      expect(update({ ...edit, properties }), name).toBe(accepted)
      expect(create({ operation_id, name: 'Fixture', owner: 'Hulk', area: 'Engineering', properties }), name).toBe(accepted)
    }
    const worker = { kind: 'external', system: 'fixture', run_id: '1',
      reference: 'https://example.test/run/1', card_id, observed_at, state: 'running', evidence: 'Fixture test running' }
    const proposal = { schema: 'tinstar.decision-proposal.v1', proposal_id: 'fixture', request_key: 'request', card_id,
      question: 'Proceed?', rationale: 'Fixture advice', recommended_action_id: 'proceed',
      actions: [{ id: 'proceed', label: 'Proceed', instruction: 'Proceed with the fixture' }], references: [],
      source: { kind: 'firstmate-request', id: 'request', revision: '1' }, published_at: observed_at, supersedes: null,
    }
    expect(start({ card_id: card_id === pilot ? pilot : notion, operation_id, worker })).toBe(accepted)
    expect(update({ ...edit, kind: 'request_decision', request_id: 'request', question: 'Proceed?', requested_from: 'Will', proposal })).toBe(accepted)
    if (card_id === pilot) {
      const savedReport = JSON.stringify({ schema: 'tinstar.external-worker.v1', reported_by: 'Fixture', ...worker })
      expect(externalWorkers(savedReport, Date.parse(observed_at))).toMatchObject([{ card_id: pilot, freshness: 'current-report' }])
      const savedRequest = JSON.stringify({ id: 'request', action: 'Decision', proposal })
      expect(decisionRequests([{ id: 'saved-decision', text: `Tin Star request: ${savedRequest}` }]))
        .toMatchObject([{ id: 'request', proposal }])
    }
  }
})

it('uses the existing MCP tools for native ticket edits, decision history, blockers, links and disposition', async () => {
  const f = await fixture()
  const { client, call } = await f.connect()
  const names = (await client.listTools()).tools.map(tool => tool.name)
  for (const name of ['create_work', 'get_work', 'update_work', 'transition_work', 'link_work']) expect(names.filter(tool => tool === name)).toHaveLength(1)
  const created = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Synthetic Jira Work' })
  expect(created).toMatchObject({ outcome: 'saved', card: { key: 'WORK-1', issue_id: '60001', owner: null, status: 'Backlog', issue_type: 'Task' } })
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'create_work')!.inputSchema
  const validate = addFormats(new Ajv({ strict: false })).compile(schema)
  expect(validate({ provider: 'jira', operation_id: 'schema', name: 'Jira' })).toBe(true)
  expect(validate({ provider: 'jira', operation_id: 'schema', name: 'Jira', owner: 'Avery', area: 'CI', status: 'Queued' })).toBe(false)
  expect(validate({ operation_id: 'schema', name: 'Notion' })).toBe(false)
  expect(validate({ operation_id: 'schema', name: 'Notion', owner: 'Avery', area: 'CI' })).toBe(true)
  const card_id = created.card.id
  const issue = f.issues.get('60001')!
  expect(issue.fields).not.toHaveProperty('assignee')
  expect(issue.fields).not.toHaveProperty('priority')
  const routed = (name: string, operation_id: string, args: Record<string, unknown>) => call(name, { card_id, operation_id, ...args })
  const move = (operation_id: string, verb: string, fields: Record<string, unknown> = {}) => routed('transition_work', operation_id, { verb, ...fields })
  const edit = (operation_id: string, fields: Record<string, unknown>) => routed('update_work', operation_id, { kind: 'jira_edit', ...fields })
  const link = (operation_id: string, fields: Record<string, unknown>) => routed('link_work', operation_id, fields)
  expect(await move('owner-required', 'Prioritize')).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('Owner') })
  expect(await edit('prepare', { owner: 'Avery', description: 'Run the fixture and confirm two question IDs.', note: 'Preparation evidence' })).toMatchObject({ outcome: 'saved' })
  expect(await move('select', 'Prioritize')).toMatchObject({ outcome: 'saved', card: { status: 'To Do' } })
  expect(await move('queue', 'Queue', { evidence: 'The fixture prints both IDs.' })).toMatchObject({ outcome: 'saved', card: { status: 'Queued' } })
  expect(await edit('clear-instructions', { description: null })).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('To Do') })
  expect(await edit('stage-blocker', { blocker: { type: 'Actor', target: 'actor:reviewer', unblocks_when: 'The reviewer responds.' } })).toMatchObject({ outcome: 'saved' })
  expect(await move('blocked-start', 'Start', { evidence: 'Fixture run is active.' })).toMatchObject({ outcome: 'not-saved' })
  expect(await edit('clear-staged', { blocker: null })).toMatchObject({ outcome: 'saved' })
  expect(await move('start', 'Start', { evidence: 'Fixture run is active.' })).toMatchObject({ outcome: 'saved', card: { status: 'In Progress' } })
  expect(await edit('ask', { add_questions: [
    { id: 'D1', question: 'Choose a region?', options: ['East', 'West'] },
    { id: 'D2', question: 'Choose a label?\nInclude the reason.' },
  ] })).toMatchObject({ outcome: 'saved' })
  expect(await move('ask-status', 'Request Decision')).toMatchObject({ outcome: 'saved', card: { status: 'Decision' } })
  expect(await edit('answer-one', { answers: [{ id: 'D1', answer: 'East.\nUse the nearest site.' }] })).toMatchObject({ outcome: 'saved', card: { status: 'Decision', decision_questions: [
    { id: 'D1', question: 'Choose a region?', options: ['East', 'West'], answer: 'East.\nUse the nearest site.' },
    { id: 'D2', question: 'Choose a label?\nInclude the reason.' },
  ] } })
  expect(await edit('rewrite', { answers: [{ id: 'D1', answer: 'West' }] })).toMatchObject({ outcome: 'not-saved' })
  expect(await move('premature-answer', 'Answer Decision', { to: 'In Progress' })).toMatchObject({ outcome: 'not-saved' })
  const firstAnswer = issue.fields[config.fields.decisions].content.find((node: any) => node.content[0]?.text.startsWith('  Answer:'))!
  firstAnswer.content[0].marks = [{ type: 'link', attrs: { href: 'https://example.test/evidence' } }]
  const nativeNode = structuredClone(firstAnswer)
  expect(await edit('answer-two', { answers: [{ id: 'D2', answer: 'Keep the current label.' }] })).toMatchObject({ outcome: 'saved' })
  expect(issue.fields[config.fields.decisions].content).toContainEqual(nativeNode)
  expect(await move('answer-no-evidence', 'Answer Decision', { to: 'In Progress' })).toMatchObject({
    outcome: 'not-saved', message: expect.stringContaining('requires evidence'),
  })
  expect(await move('answer-status', 'Answer Decision', { to: 'In Progress', evidence: 'The worker resumed execution.' })).toMatchObject({ outcome: 'saved' })
  expect(await edit('external', { blocker: { type: 'Actor', target: 'team:reviewers', unblocks_when: 'A reviewer grants access.' } })).toMatchObject({ outcome: 'saved', card: { blocker: { type: 'Actor' } } })
  expect(await move('wait', 'Block')).toMatchObject({ outcome: 'saved', card: { status: 'Waiting For' } })
  expect(await edit('change-blocker', { blocker: { type: 'Event', target: 'event:approval-1', unblocks_when: 'The approval event is recorded.' } })).toMatchObject({ outcome: 'saved', card: { blocker: { type: 'Event' } } })
  expect(await link('two-blockers', { action: 'add', target_key: 'OTHER-1', type: 'Blocks', direction: 'inward' })).toMatchObject({ outcome: 'not-saved' })
  expect(await edit('clear-external', { blocker: null })).toMatchObject({ outcome: 'saved', card: { blocker: null } })
  const linked = await link('jira-blocker', { action: 'add', target_key: 'OTHER-1', type: 'Blocks', direction: 'inward' })
  expect(linked, JSON.stringify(linked)).toMatchObject({ outcome: 'saved', card: { blocker: { type: 'Jira', link: { id: '8001', target_key: 'OTHER-1', label: 'is blocked by' } } } })
  expect(linked.card.blocker.link).not.toHaveProperty('target_id')
  expect(f.requests.filter(request => request.method === 'GET' && /issue\/(OTHER-1|70001)$/.test(request.path))
    .every(request => request.fields === 'project')).toBe(true)
  expect(await move('wait-too-early', 'Resolve Wait', { to: 'In Progress', evidence: 'Claimed clear' })).toMatchObject({ outcome: 'not-saved' })
  expect(await link('remove', { action: 'remove', link_id: '8001' })).toMatchObject({ outcome: 'saved', card: { blocker: null } })
  expect(await move('wait-no-evidence', 'Resolve Wait', { to: 'In Progress' })).toMatchObject({
    outcome: 'not-saved', message: expect.stringContaining('requires evidence'),
  })
  expect(await move('cleared', 'Resolve Wait', { to: 'In Progress', evidence: 'The blocker cleared and the worker resumed execution.' })).toMatchObject({ outcome: 'saved' })
  expect(await move('review', 'Submit for Review', { evidence: 'Fixture log is attached.' })).toMatchObject({ outcome: 'saved', card: { status: 'Ready for Review' } })
  expect(await move('accept', 'Accept Review', { evidence: 'Fixture was reviewed. A release remains.' })).toMatchObject({ outcome: 'saved', card: { status: 'Waiting for Prod Release' } })
  expect(await move('wrong-revision', 'Deployed', { required_revision: 'rev-a', live_revision: 'rev-b', evidence: 'Observed release status.' })).toMatchObject({ outcome: 'not-saved' })
  expect(await move('deployed', 'Deployed', { required_revision: 'rev-a', live_revision: 'rev-a', evidence: 'Observed release status.' })).toMatchObject({ outcome: 'saved', card: { status: 'Verify in Prod' } })
  expect(await move('verify', 'Verify Passed', { evidence: 'Production fixture prints both question IDs.' })).toMatchObject({ outcome: 'saved', card: { status: 'Done' } })
  expect(await move('reopen', 'Reopen', { to: 'To Do', reason: 'A new acceptance requirement applies.' })).toMatchObject({ outcome: 'saved', card: { status: 'To Do' } })
  expect(await move('cancel', 'Cancel', { reason: 'Requirement was withdrawn.', disposition: 'No worker remains active.' })).toMatchObject({ outcome: 'saved', card: { status: 'Canceled' } })
  issue.comments.push({ id: 'restricted', body: 'Private note', visibility: { type: 'role', value: 'Administrator' } })
  const read = await call('get_work', { card_id })
  expect(read).toMatchObject({ outcome: 'available', card: { id: card_id, key: 'WORK-1' }, comments: expect.arrayContaining([expect.objectContaining({ body: expect.stringContaining('Requirement was withdrawn.') })]) })
  expect(read.comments.find((comment: { id: string }) => comment.id === 'restricted')).toEqual({ id: 'restricted' })
  expect(JSON.stringify(read)).not.toContain('Private note')
  const before = f.requests.length
  const denied = await call('get_work', { card_id: card_id.replace('10001', '10002') })
  expect(denied).toMatchObject({ outcome: 'unavailable' })
  expect(f.requests).toHaveLength(before)
}, 30_000)

it('reconciles lost writes after a new server instance and never repeats a pending or failed mutation', async () => {
  const f = await fixture()
  const first = await f.connect()
  const args = { provider: 'jira', name: 'Retry proof', operation_id: 'create-proof', issue_type: 'Epic' }
  f.controls.loseCreate = true
  const uncertain = await first.call('create_work', args)
  expect(uncertain).toMatchObject({ outcome: 'partially-saved' })
  expect(JSON.stringify(uncertain)).not.toContain(config.token)
  const second = await f.connect()
  f.controls.rejectSearch = true
  expect(await second.call('create_work', args)).toMatchObject({ outcome: 'partially-saved' })
  f.controls.rejectSearch = false
  f.controls.staleSearch = true
  expect(await second.call('create_work', args)).toMatchObject({ code: 'unconfirmed' })
  f.controls.staleSearch = false
  const issue = f.issues.get('60001')!
  const originalType = issue.fields.issuetype
  issue.fields.issuetype = { id: '99999', name: 'Story' }
  expect(await second.call('create_work', args)).toMatchObject({ outcome: 'partially-saved', code: 'unconfirmed' })
  issue.fields.issuetype = originalType
  f.issues.get('60001')!.fields.summary = 'Title changed natively'
  const confirmed = await second.call('create_work', args)
  expect(confirmed).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { issue_type: 'Epic', issue_id: '60001', name: 'Title changed natively' } })
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue')).toHaveLength(1)
  const card_id = confirmed.card.id
  f.controls.loseEdit = true
  const edit = { kind: 'jira_edit', card_id, operation_id: 'edit-proof', owner: 'Taylor', description: 'Inspect the test output.', note: 'One comment only.' }
  expect(await second.call('update_work', edit)).toMatchObject({ outcome: 'partially-saved' })

  const third = await f.connect()
  expect(await third.call('update_work', edit)).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { owner: 'Taylor' } })
  f.issues.get('60001')!.fields[config.fields.owner] = { value: 'Avery' }
  expect(await third.call('update_work', edit)).toMatchObject({ code: 'unconfirmed' })
  expect(f.issues.get('60001')!.comments).toHaveLength(1)
  f.controls.refuseTransition = true
  const move = { card_id, operation_id: 'fast-track', verb: 'Fast-track', evidence: 'Fixture checks are named.' }
  const rejected = await third.call('transition_work', move)
  expect(rejected).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('409') })
  expect((await third.call('get_work', { card_id })).card.status).toBe('Backlog')
  f.controls.refuseTransition = false
  f.controls.loseEdit = true
  const nextMove = { ...move, operation_id: 'accepted-fast-track' }
  expect(await third.call('transition_work', nextMove)).toMatchObject({
    outcome: 'saved', code: 'confirmed', card: { status: 'Queued' },
  })
  expect(await third.call('transition_work', nextMove)).toMatchObject({ code: 'already-saved', card: { status: 'Queued' } })
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue/60001/comment')).toHaveLength(1)
  const restarted = await f.connect()
  const beforeRetry = f.requests.length
  expect(await restarted.call('transition_work', move)).toEqual(rejected)
  expect(f.requests).toHaveLength(beforeRetry)
  f.controls.omitComment = true
  const omit = { kind: 'jira_edit', card_id, operation_id: 'omit', description: 'New instructions', note: 'Jira omitted this' }
  expect(await third.call('update_work', omit)).toMatchObject({ code: 'unconfirmed' })
  expect(await third.call('update_work', omit)).toMatchObject({ code: 'unconfirmed' })
  expect(f.requests.filter(request => request.method === 'PUT' && request.path === 'issue/60001')).toHaveLength(2)
  expect(await third.call('transition_work', { card_id, operation_id: 'dequeue', verb: 'Dequeue' })).toMatchObject({ outcome: 'saved', card: { status: 'To Do' } })
  f.controls.omitComment = false
  const moveAgain = (operation_id: string, verb: string, fields: Record<string, unknown> = {}) =>
    third.call('transition_work', { card_id, operation_id, verb, ...fields })
  expect(await moveAgain('queue-again', 'Queue')).toMatchObject({ outcome: 'saved' })
  expect(await moveAgain('start-work', 'Start', { evidence: 'The test is running.' })).toMatchObject({ outcome: 'saved' })
  const refused = { card_id, operation_id: 'stop-without-reconciling', verb: 'Stop and Requeue', evidence: 'Named test checks are ready.' }
  const invalid = await third.call('transition_work', refused)
  expect(invalid).toMatchObject({ outcome: 'not-saved', code: 'invalid-work' })
  const beforeRefusedRetry = f.requests.length
  expect(await restarted.call('transition_work', refused)).toEqual(invalid)
  expect(f.requests.slice(beforeRefusedRetry).map(request => request.method)).toEqual(['GET', 'GET'])
  expect(await moveAgain('stop', 'Stop and Requeue', { disposition: 'The previous test process exited.', evidence: 'The reproduction and assertions are ready.' })).toMatchObject({ outcome: 'saved', card: { status: 'Queued' } })
  expect(await moveAgain('start-again', 'Start', { evidence: 'The reproduction started.' })).toMatchObject({ outcome: 'saved' })
  expect(await moveAgain('direct', 'Complete Directly', { evidence: 'The reproduction passed. No review or production change remains.' })).toMatchObject({ outcome: 'saved', card: { status: 'Done' } })
}, 30_000)


it('sends undispatched receipts, isolates callers, and keeps ambiguous dispatched receipts', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const create = { provider: 'jira', operation_id: 'shared', name: 'Retry', description: 'Verify the fixture runs.', owner: 'Avery' }
  const created = await call('create_work', create)
  expect(created).toMatchObject({ outcome: 'saved', card: { issue_id: '60001' } })
  const other = await f.connect('Other agent')
  expect(await other.call('create_work', create)).toMatchObject({ outcome: 'saved', card: { issue_id: '60002' } })
  const card_id = created.card.id
  const issue = f.issues.get('60001')!
  issue.fields[config.fields.owner] = null
  const prioritize = { card_id, operation_id: 'prioritize', verb: 'Prioritize' }
  expect(await call('transition_work', prioritize)).toMatchObject({
    outcome: 'not-saved', message: expect.stringContaining('Choose an Owner'),
  })
  issue.fields[config.fields.owner] = { value: 'Avery' }
  const resumed = await f.connect()
  expect(await resumed.call('transition_work', prioritize)).toMatchObject({ outcome: 'saved', card: { status: 'To Do' } })

  const edit = { card_id, operation_id: 'edit', kind: 'jira_edit', name: 'Retried edit' }
  f.controls.beforeWrite = 'GET issue/60001'
  expect(await call('update_work', edit)).toMatchObject({ outcome: 'not-saved' })
  expect(await other.call('get_work', { card_id })).toMatchObject({ card: { name: 'Retry' } })
  expect(await call('update_work', edit)).toMatchObject({ outcome: 'saved', card: { name: 'Retried edit' } })

  const add = { card_id, operation_id: 'add', action: 'add', target_key: 'OTHER-1', type: 'Blocks', direction: 'outward' }
  expect(await call('link_work', add)).toMatchObject({ outcome: 'saved', card: { links: [{ id: '8001', direction: 'outward' }] } })
  const remove = { card_id, operation_id: 'remove', action: 'remove', link_id: '8001' }
  f.controls.beforeWrite = 'DELETE issueLink/8001'
  expect(await call('link_work', remove)).toMatchObject({ code: 'unconfirmed' })
  expect(await call('link_work', remove)).toMatchObject({ code: 'unconfirmed' })
  f.links.delete('8001')
  expect(await call('link_work', { ...add, operation_id: 'replacement' })).toMatchObject({ outcome: 'saved' })
  expect(await call('link_work', { ...remove, operation_id: 'remove-replacement', link_id: '8002' })).toMatchObject({ outcome: 'saved' })
  expect(await call('link_work', remove)).toMatchObject({ code: 'already-saved' })
  expect(f.requests.filter(request => request.method === 'DELETE' && request.path === 'issueLink/8001')).toHaveLength(1)

  f.controls.loseLink = true
  const superseded = { ...add, operation_id: 'superseded' }
  expect(await call('link_work', superseded)).toMatchObject({ code: 'unconfirmed' })
  expect(await call('link_work', superseded)).toMatchObject({ code: 'already-saved' })
  f.links.delete('8003')
  expect(await call('link_work', superseded)).toMatchObject({ code: 'unconfirmed' })
  expect(f.links.size).toBe(0)

  f.controls.wrongCreate = true
  const wrong = { ...create, operation_id: 'wrong-create' }
  const contradicted = await call('create_work', wrong)
  expect(contradicted).toMatchObject({ code: 'unconfirmed' })
  const restarted = await f.connect()
  const beforeRetry = f.requests.length
  expect(await restarted.call('create_work', wrong)).toEqual(contradicted)
  expect(f.requests).toHaveLength(beforeRetry)
}, 30_000)

it('answers multiple entries in one native Jira code block', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Code block decisions',
  })
  const issue = f.issues.get('60001')!
  const code = {
    type: 'codeBlock', attrs: { language: 'text' },
    content: [{ type: 'text', text: 'D1 [Open]: First?\nD2 [Open]: Second?\nD3 [Open]: Leave intact?' }],
  }
  issue.fields[config.fields.decisions] = { type: 'doc', version: 1, content: [code] }
  expect(await call('update_work', { kind: 'jira_edit', card_id, operation_id: 'answer',
    answers: [{ id: 'D1', answer: 'Yes.\nKeep the formatting.' }, { id: 'D2', answer: 'No.' }],
  })).toMatchObject({ outcome: 'saved' })
  expect(issue.fields[config.fields.decisions].content).toEqual([{
    ...code, content: [{ type: 'text', text: 'D1 [Answered]: First?\n  Answer: Yes.\n    Keep the formatting.\nD2 [Answered]: Second?\n  Answer: No.\nD3 [Open]: Leave intact?' }],
  }])
})

it('refuses active destinations for a blocked Decision and allows Block', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Blocked decision', owner: 'Avery', description: 'Run the checks.',
  })
  const issue = f.issues.get('60001')!
  issue.fields.status = { name: 'Decision' }
  issue.fields[config.fields.decisions] = 'D1 [Answered]: Resume?\n  Answer: Yes.'
  const answer = (to: string, revisions = {}) => call('transition_work', {
    card_id, operation_id: to, verb: 'Answer Decision', to, evidence: 'Checks are complete.', ...revisions,
  })
  issue.fields[config.fields.blockerType] = { value: 'Actor' }
  issue.fields[config.fields.blockerTarget] = 'team:reviewers'
  issue.fields[config.fields.blockerCondition] = 'A reviewer grants access.'
  for (const to of ['Queued', 'In Progress', 'Ready for Review', 'Waiting for Prod Release', 'Verify in Prod']) {
    const revisions = to === 'Verify in Prod' ? { required_revision: 'rev-a', live_revision: 'rev-a' } : {}
    expect(await answer(to, revisions)).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('Clear the primary blocker') })
  }
  expect(await call('transition_work', { card_id, operation_id: 'block', verb: 'Block' }))
    .toMatchObject({ outcome: 'saved', card: { status: 'Waiting For', blocker: { type: 'Actor' } } })
})

it.each([false, true])('answers a Jira decision with native soft breaks=%s and preserves option marks', async softBreaks => {
  const f = await fixture()
  const { call } = await f.connect()
  const created = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Decision layouts' })
  const issue = f.issues.get('60001')!
  const line = (text: string) => ({ type: 'text', text })
  const option = { ...line('  Option: East '), marks: [{ type: 'link', attrs: { href: 'https://example.test/east' } }] }
  const d2 = line('D2 [Open]: Choose a label?')
  const br = { type: 'hardBreak' }
  const para = (...content: Record<string, unknown>[]) => ({ type: 'paragraph', content })
  const header = line('D1 [Open]: Choose a region?')
  issue.fields[config.fields.decisions] = { type: 'doc', version: 1,
    content: softBreaks ? [para(header, br, option, br, d2)] : [para(header), para(option), para(d2)] }
  const result = await call('update_work', { card_id: created.card.id, operation_id: 'answer', kind: 'jira_edit',
    answers: [{ id: 'D1', answer: 'East' }] })
  expect(result).toMatchObject({ outcome: 'saved', card: { decision_questions: [
    { id: 'D1', question: 'Choose a region?', options: ['East'], answer: 'East' }, { id: 'D2', question: 'Choose a label?' },
  ] } })
  expect(issue.fields[config.fields.decisions].content.flatMap((node: { content: unknown[] }) => node.content))
    .toEqual(expect.arrayContaining([option, d2]))
  const savedOption = issue.fields[config.fields.decisions].content.flatMap((node: { content: unknown[] }) => node.content)
    .find((node: { text?: string }) => node.text?.startsWith('  Option:'))
  expect(JSON.stringify(savedOption)).toBe(JSON.stringify(option))
}, 30_000)



it('checks the live project before fetching moved ticket content or comments', async () => {
  const f = await fixture()
  const { client, call } = await f.connect()
  const create = { provider: 'jira', operation_id: 'create', name: 'Moved ticket' }
  const { card: { id: card_id } } = await call('create_work', create)
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'get_work')!.inputSchema
  const validate = addFormats(new Ajv({ strict: false })).compile(schema)
  expect(validate({ card_id, details: false })).toBe(true)
  for (const options of [{ lease_token: 'lease' }, { refresh: false }, { implementation_contract: {} }]) {
    expect(validate({ card_id, ...options })).toBe(false)
    const before = f.requests.length
    const result = await client.callTool({ name: 'get_work', arguments: { card_id, ...options } })
    expect(result.isError).toBe(true)
    expect(f.requests).toHaveLength(before)
  }
  expect(validate({ card_id: 'a'.repeat(32), refresh: true, implementation_contract: {} })).toBe(true)
  f.issues.get('60001')!.fields.project = { id: '10002' }
  const before = f.requests.length
  expect(await call('get_work', { card_id })).toMatchObject({ outcome: 'unavailable' })
  expect(await call('update_work', { card_id, kind: 'jira_edit', operation_id: 'edit', note: 'Note' })).toMatchObject({ outcome: 'not-saved' })
  expect(await call('transition_work', { card_id, operation_id: 'move', verb: 'Prioritize' })).toMatchObject({ outcome: 'not-saved' })
  expect(await call('link_work', { card_id, operation_id: 'link', action: 'remove', link_id: '8001' })).toMatchObject({ outcome: 'not-saved' })
  expect(await call('create_work', create)).toMatchObject({ code: 'unconfirmed' })
  expect(f.requests.slice(before)).toEqual([
    ...Array.from({ length: 4 }, () => ({ method: 'GET', path: 'issue/60001', fields: 'project' })),
    { method: 'POST', path: 'search/jql', fields: null },
  ])
}, 30_000)


it('withholds a comment fetched while the issue moves projects', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Moving ticket' })
  f.controls.moveDuringComments = true
  const result = await call('get_work', { card_id })
  expect(result).toMatchObject({ warnings: expect.arrayContaining([expect.stringContaining('comments')]) })
  expect(result).not.toHaveProperty('comments')
  expect(JSON.stringify(result)).not.toContain('Destination project comment')
  expect(f.requests.slice(-2)).toEqual([
    { method: 'GET', path: 'issue/60001/comment', fields: null },
    { method: 'GET', path: 'issue/60001', fields: 'project' },
  ])
}, 30_000)


it.each([
  ['Answer Decision', 'Decision'],
  ['Resolve Wait', 'Waiting For'],
])('requires submission evidence when %s enters Ready for Review', async (verb, status) => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Review entry', owner: 'Avery',
  })
  const issue = f.issues.get('60001')!
  issue.fields.status = { name: status }
  issue.fields[config.fields.decisions] = 'D1 [Answered]: Ship the change?\n  Answer: Yes.'
  const input = { card_id, operation_id: 'submit', verb, to: 'Ready for Review' }
  expect(await call('transition_work', input)).toMatchObject({
    outcome: 'not-saved', message: expect.stringContaining('requires evidence'),
  })
  expect(issue.fields.status.name).toBe(status)
  expect(await call('transition_work', { ...input, operation_id: 'submit-with-evidence', evidence: 'The completed work and test results are attached for review.' }))
    .toMatchObject({ outcome: 'saved', card: { status: 'Ready for Review' } })
})

it('requires source text for a native Jira blocker condition', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Native blocker', owner: 'Avery',
  })
  expect(await call('transition_work', { card_id, operation_id: 'prioritize', verb: 'Prioritize' }))
    .toMatchObject({ outcome: 'saved' })
  const issue = f.issues.get('60001')!
  issue.fields[config.fields.blockerType] = { value: 'Actor' }
  issue.fields[config.fields.blockerTarget] = 'team:reviewers'
  const content = [{ type: 'mediaInline' }, { type: 'emoji', attrs: { shortName: ':thumbsup:' } }]
  issue.fields[config.fields.blockerCondition] = { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] }
  const read = await call('get_work', { card_id })
  expect(read.card).not.toHaveProperty('blocker')
  expect(read.card.external_blocker_fields.unblocks_when).toBe('[Rich content in Jira]:thumbsup:')
  const block = { card_id, operation_id: 'block', verb: 'Block' }
  expect(await call('transition_work', block)).toMatchObject({
    outcome: 'not-saved', message: expect.stringContaining('unblock condition'),
  })
  issue.fields[config.fields.blockerCondition].content.push({
    type: 'paragraph', content: [{ type: 'text', text: 'A reviewer grants access.' }],
  })
  expect(await call('transition_work', block)).toMatchObject({ outcome: 'saved', card: {
    status: 'Waiting For', blocker: { unblocks_when: '[Rich content in Jira]:thumbsup:\nA reviewer grants access.' },
  } })
})

it('requires actual description text for Queue and Start', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Rich content only', owner: 'Avery',
  })
  const issue = f.issues.get('60001')!
  const paragraph = { type: 'paragraph', content: [{ type: 'mediaInline' }, { type: 'mention', attrs: { text: '@Avery' } }, { type: 'inlineCard', attrs: { url: 'https://example.test' } }] }
  issue.fields.description = { type: 'doc', version: 1, content: [paragraph] }
  expect(await call('get_work', { card_id })).toMatchObject({ card: { description: '[Rich content in Jira]@Averyhttps://example.test' } })
  const move = (verb: string) => call('transition_work', { card_id, operation_id: verb, verb, evidence: 'Work began.' })
  expect(await move('Prioritize')).toMatchObject({ outcome: 'saved' })
  expect(await move('Queue')).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('require instructions') })
  issue.fields.status = { name: 'Queued' }
  expect(await move('Start')).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('require instructions') })
  issue.fields.description.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Run the checks and confirm they pass.' }] })
  expect(await move('Start')).toMatchObject({ outcome: 'saved', card: { status: 'In Progress' } })
})

it('scopes transition revisions and disposition to their supported paths', async () => {
  const f = await fixture()
  const { client, call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Ticket' })
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'transition_work')!.inputSchema
  const validate = new Ajv({ strict: false }).compile(schema)
  const revisions = { required_revision: 'rev-a', live_revision: 'rev-a' }
  for (const verb of jiraVerbs) {
    expect(validate({ card_id, operation_id: 'check', verb, ...revisions })).toBe(verb === 'Deployed')
    const destinations = jiraTransitions[verb][1]
    const args = { card_id, operation_id: 'check', verb }
    expect(validate(args)).toBe(destinations.length === 1)
    for (const to of destinations) expect(validate({ ...args, to })).toBe(destinations.length > 1)
  }
  const before = f.requests.length
  for (const field of ['required_revision', 'live_revision']) {
    const result = await client.callTool({ name: 'transition_work',
      arguments: { card_id, operation_id: field, verb: 'Queue', [field]: 'rev-a' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Revision arguments')
  }
  for (const verb of ['Answer Decision', 'Resolve Wait']) {
    for (const to of ['Backlog', 'Waiting For']) {
      const args = { card_id, operation_id: 'interrupt', verb, to }
      expect(validate(args)).toBe(false)
      expect((await client.callTool({ name: 'transition_work', arguments: args })).isError).toBe(true)
    }
    for (const to of ['To Do', 'Queued', 'In Progress', 'Ready for Review', 'Decision', 'Waiting for Prod Release', 'Verify in Prod']) {
      expect(validate({ card_id, operation_id: 'interrupt', verb, to })).toBe(to !== 'Decision' || verb === 'Resolve Wait')
    }
  }
  for (const verb of jiraVerbs) {
    const to = verb === 'Answer Decision' || verb === 'Resolve Wait' ? 'Verify in Prod' : undefined
    expect(validate({ card_id, operation_id: 'check', verb, ...(to ? { to } : {}), disposition: 'Work reconciled.' }))
      .toBe(['Park', 'Cancel', 'Stop and Requeue'].includes(verb))
    if (to) {
      expect(validate({ card_id, operation_id: 'check', verb, to, ...revisions })).toBe(true)
      expect(validate({ card_id, operation_id: 'check', verb, to: 'Waiting for Prod Release', ...revisions })).toBe(false)
    }
  }
  expect((await client.callTool({ name: 'transition_work',
    arguments: { card_id, operation_id: 'check', verb: 'Prioritize', disposition: 'Unrelated.' } })).isError).toBe(true)
  expect(f.requests).toHaveLength(before)
}, 30_000)



it.each([
  ['Answer Decision', 'Decision'],
  ['Resolve Wait', 'Waiting For'],
])('requires release evidence when resuming through %s', async (verb, status) => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Resume release', owner: 'Avery',
  })
  const issue = f.issues.get('60001')!
  issue.fields[config.fields.decisions] = 'D1 [Answered]: Resume?\n  Answer: Yes.'
  const input = { card_id, verb }
  issue.fields.status = { name: status }
  const release = { ...input, operation_id: 'release', to: 'Waiting for Prod Release' }
  expect(await call('transition_work', release)).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('requires evidence') })
  expect(await call('transition_work', { ...release, evidence: 'The completed work is accepted for release.' }))
    .toMatchObject({ outcome: 'saved', card: { status: 'Waiting for Prod Release' } })

  issue.fields.status = { name: status }
  const verify = { ...input, operation_id: 'verify', to: 'Verify in Prod', evidence: 'Production is ready for verification.' }
  expect(await call('transition_work', verify)).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('exact required revision') })
  expect(await call('transition_work', { ...verify, required_revision: 'rev-a', live_revision: 'rev-b' }))
    .toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('exact required revision') })
  expect(await call('transition_work', { ...verify, required_revision: 'rev-a', live_revision: 'rev-a' }))
    .toMatchObject({ outcome: 'saved', card: { status: 'Verify in Prod' } })
  expect(JSON.stringify(issue.comments.at(-1)?.body)).toContain('Live revision: rev-a')
})

it('uses immutable link target identity for historical keys, blockers, and recovery', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const create = (name: string) => call('create_work', { provider: 'jira', operation_id: name, name })
  const { card: { id: card_id } } = await create('Source')
  const { card: { id: target_id } } = await create('Target')
  f.historicalKeys.set('OLD-1', '60001')
  f.historicalKeys.set('OLD-2', '60002')
  const add = { card_id, action: 'add', direction: 'outward', type: 'Blocks', target_key: 'OLD-2' }
  expect(await call('link_work', { ...add, operation_id: 'self', target_key: 'OLD-1' })).toMatchObject({ outcome: 'not-saved' })
  const blocker = { type: 'Event', target: 'deploy', unblocks_when: 'Release completes' }
  expect(await call('update_work', { card_id: target_id, operation_id: 'block', kind: 'jira_edit', blocker })).toMatchObject({ outcome: 'saved' })
  expect(await call('link_work', { ...add, operation_id: 'blocked' })).toMatchObject({
    outcome: 'not-saved', message: expect.stringContaining('primary blocker'),
  })
  expect(await call('update_work', { card_id: target_id, operation_id: 'clear', kind: 'jira_edit', blocker: null })).toMatchObject({ outcome: 'saved' })
  f.controls.loseLink = true
  const pending = { ...add, operation_id: 'lost' }
  expect(await call('link_work', pending)).toMatchObject({ code: 'unconfirmed' })
  const saved = await call('link_work', pending)
  expect(saved).toMatchObject({ code: 'already-saved', card: { links: [{ target_key: 'WORK-2' }] } })
  expect(saved.card.links[0]).not.toHaveProperty('target_id')
  expect(await call('link_work', { ...add, operation_id: 'duplicate', target_key: 'WORK-2' })).toMatchObject({ outcome: 'saved' })
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issueLink')).toHaveLength(1)
}, 30_000)


it.each([
  ['update_work', 'another author'], ['transition_work', 'another author'],
  ['update_work', 'before dispatch'], ['transition_work', 'before dispatch'],
])('rejects an identical comment during %s readback when it is from %s', async (tool, reason) => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Ticket', owner: 'Avery', description: 'Ready for work',
  })
  f.controls.omitComment = true
  if (reason === 'another author') f.controls.delayedCommentAuthor = 'human-account'
  else f.controls.delayedCommentTime = '2020-01-01T00:00:00Z'
  const edit = tool === 'update_work'
  f.controls.delayedComment = edit
    ? 'Matching note\n\nRecorded via Tin Star (Fixture agent)'
    : 'Fast-track via Tin Star (Fixture agent)\nEvidence: Matching note'
  const args = edit ? { kind: 'jira_edit', name: 'New title', note: 'Matching note' }
    : { verb: 'Fast-track', evidence: 'Matching note' }
  expect(await call(tool, { card_id, operation_id: 'change', ...args })).toMatchObject({
    code: 'unconfirmed', message: expect.stringContaining('did not confirm the requested comment'),
  })
}, 30_000)


it.each([false, true])('recovers note-only writes without reposting (unchanged fields: %s)', async unchanged => {
  const f = await fixture()
  const { call } = await f.connect()
  const description = '{"password":"two word passphrase"} and password: "longfirstword secondword"\nATATTabcdefghijklmnop0123456789 ATCTTabcdefghijklmnop0123456789 github_pat_1234567890abcdef1234567890abcdef Basic Zml4dHVyZTpwYXNzd29yZA==\nEVENTS_JIRA_WEBHOOK_SECRET=fixtureWebhookValue Authorization=fixtureAuthValue\nEVENTS_JIRA_WEBHOOK_SECRET=\'quoted fixture value\'\nPASSWORD="first\nTOKEN=123\n\'TOKEN\'=\'inner\'\nprivate-tail"\nPASSWORD="first\nprivate-tail TOKEN=" trailing prose\n"ordinary quotation"\nEVENTS_JIRA_WEBHOOK_SECRET="clipped\nAUTHORIZATION="second fixture value"\nPASSWORD="clipped\nTOKEN="first\nprivate-tail")\nPASSWORD="clipped {"TOKEN":"opaque phrase"}\nTOKEN=4821 PASSWORD=a!b count=4821 "TOKEN": opaqueValue (PASSWORD=prefix]suffix) ["TOKEN": prefix)suffix]\nPASSWORD=]]}> TOKEN=opaque]] (PASSWORD=]]>) end\n{"password":123456789,"count":123456789,"token":-1.2e+3}\nPASSWORD=firstValue,TOKEN: secondValue, "API KEY" = thirdValue,"SECRET": fourthValue end\nAuthorization: Basic dTpw and Authorization=Basic YTpiYw== done\nAuthorization:\n  Basic dTpw\nBasic YTpiYw==\nAuthorization: Basic\n  dTpw\nBasic dTpw.\nBasic YTpiYw==, next\nBasic information\nBasic configuration is required\nAuthorization: Bearer a7X9\nAuthorization:\n  Bearer\n  b8Y0\nBearer witness\nPassword: admin rotated yesterday\nD2 [Open]: What follows?'
  const { card } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Token: TTL tuning', description })
  const projectedDescription = '{"password":"[credential omitted]"} and password: [credential omitted]\n[credential omitted] [credential omitted] [credential omitted] [credential omitted]\nEVENTS_JIRA_WEBHOOK_SECRET=[credential omitted] Authorization=[credential omitted]\nEVENTS_JIRA_WEBHOOK_SECRET=[credential omitted]\nPASSWORD=[credential omitted]\nPASSWORD=[credential omitted] trailing prose\n"ordinary quotation"\nEVENTS_JIRA_WEBHOOK_SECRET=[credential omitted]\nAUTHORIZATION=[credential omitted]\nPASSWORD=[credential omitted]\nTOKEN=[credential omitted])\nPASSWORD=[credential omitted]{"TOKEN":"[credential omitted]"}\nTOKEN=[credential omitted] PASSWORD=[credential omitted] count=4821 "TOKEN": "[credential omitted]" (PASSWORD=[credential omitted]) ["TOKEN": "[credential omitted]"]\nPASSWORD=[credential omitted] TOKEN=[credential omitted] (PASSWORD=[credential omitted]) end\n{"password":"[credential omitted]","count":123456789,"token":"[credential omitted]"}\nPASSWORD=[credential omitted],TOKEN: [credential omitted], "API KEY" = "[credential omitted]","SECRET": "[credential omitted]" end\nAuthorization: [credential omitted] and Authorization=[credential omitted] done\nAuthorization:\n  [credential omitted]\n[credential omitted]\nAuthorization: [credential omitted]\n[credential omitted].\n[credential omitted], next\nBasic information\nBasic configuration is required\nAuthorization: [credential omitted]\nAuthorization:\n  [credential omitted]\nBearer witness\nPassword: [credential omitted] rotated yesterday\nD2 [Open]: What follows?'
  expect(card).toMatchObject({ name: 'Token: [credential omitted] tuning', description: projectedDescription })
  expect(await call('get_work', { card_id: card.id })).toMatchObject({ card: { description: projectedDescription } })
  expect(f.requests.some(request => request.path === 'serverInfo')).toBe(false)
  const edit = { kind: 'jira_edit', card_id: card.id, note: 'Confirm this comment', ...(unchanged ? { name: 'Token: TTL tuning' } : {}) }
  f.controls.loseEdit = true
  expect(await call('update_work', { ...edit, operation_id: 'saved-note' })).toMatchObject({ code: 'unconfirmed' })
  expect(await call('update_work', { ...edit, operation_id: 'saved-note' })).toMatchObject({ code: 'already-saved' })
  f.controls.omitComment = true
  f.controls.loseEdit = true
  const missing = { ...edit, note: 'Missing comment', operation_id: 'missing-note' }
  expect(await call('update_work', missing)).toMatchObject({ code: 'unconfirmed' })
  expect(await call('update_work', missing)).toMatchObject({ code: 'unconfirmed' })
  expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(2)
}, 30_000)


it('persists only Jira operation kinds and dispatch marks', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Original private title', description: 'Original private description', owner: 'Avery',
  })
  expect(await call('transition_work', { card_id, operation_id: 'prioritize', verb: 'Prioritize' })).toMatchObject({ outcome: 'saved' })
  expect(await call('update_work', { card_id, operation_id: 'all-fields', kind: 'jira_edit', name: 'Updated private title',
    description: 'Updated private description', owner: 'Taylor', add_questions: [{ id: 'D1', question: 'Private decision' }],
    blocker: { type: 'Event', target: 'private:event', unblocks_when: 'Private unblock condition' },
  })).toMatchObject({ outcome: 'saved' })
  const raw = await readFile(join(f.root, 'workflow-create-receipts.json'), 'utf8')
  for (const value of ['Original private title', 'Original private description', 'Updated private title', 'Updated private description',
    'Avery', 'Taylor', 'Private decision', 'Event', 'private:event', 'Private unblock condition', 'Backlog', 'To Do']) {
    expect(raw).not.toContain(value)
  }
  expect(Object.values(JSON.parse(raw))).toEqual([
    { input: 'create', jiraWork: { dispatched: true } },
    { input: 'transition', jiraWork: { dispatched: true } },
    { input: 'edit', jiraWork: { dispatched: true } },
  ])
}, 30_000)

it('resolves a named TSW transition when Jira translates the destination status', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'TSW shape', owner: 'Avery',
    description: 'Run the listed transition.\nSuccess: the destination status matches.',
  })
  const issue = f.issues.get('60001')!
  // Live GET /issue/TSW-2/transitions while Backlog, plus one unavailable same-named row.
  const backlog = [
    { id: '99', name: 'Prioritize', to: { id: '10005', name: 'To Do' }, isAvailable: false },
    { id: '2', name: 'Prioritize', to: { id: '10997', name: 'To Do' }, isAvailable: true },
    { id: '4', name: 'Fast-track', to: { id: '10998', name: 'Queued' }, isAvailable: true },
    { id: '38', name: 'Cancel', to: { id: '11006', name: 'Canceled' }, isAvailable: true },
  ]
  f.controls.transitionList = backlog
  expect(await call('transition_work', { card_id, operation_id: 'prioritize', verb: 'Prioritize' })).toMatchObject({ outcome: 'saved', card: { status: 'To Do' } })
  expect(f.controls.lastTransitionId).toBe('2')
  const queued = [
    { id: '5', name: 'Start', to: { id: '10999', name: 'In Progress' }, isAvailable: true },
    { id: '13', name: 'Request Decision', to: { id: '11000', name: 'Decision' }, isAvailable: true },
    { id: '14', name: 'Block', to: { id: '11001', name: 'Waiting For' }, isAvailable: true },
    { id: '28', name: 'Dequeue', to: { id: '10997', name: 'To Do' }, isAvailable: true },
    { id: '31', name: 'Return for Preparation', to: { id: '10997', name: 'To Do' }, isAvailable: true },
    { id: '38', name: 'Cancel', to: { id: '11006', name: 'Canceled' }, isAvailable: true },
  ]
  issue.fields.status = { name: 'Queued' }
  f.controls.transitionList = queued
  expect(await call('transition_work', { card_id, operation_id: 'dequeue', verb: 'Dequeue' })).toMatchObject({ outcome: 'saved', card: { status: 'To Do' } })
  expect(f.controls.lastTransitionId).toBe('28')
  issue.fields.status = { name: 'Queued' }
  expect(await call('transition_work', { card_id, operation_id: 'start', verb: 'Start', evidence: 'The listed transition ran.' })).toMatchObject({ outcome: 'saved', card: { status: 'In Progress' } })
  expect(f.controls.lastTransitionId).toBe('5')
  issue.fields.status = { name: 'Queued' }
  issue.fields[config.fields.decisions] = 'D1 [Open]: Which option?'
  expect(await call('transition_work', { card_id, operation_id: 'decide', verb: 'Request Decision' })).toMatchObject({ outcome: 'saved', card: { status: 'Decision' } })
  expect(f.controls.lastTransitionId).toBe('13')
  issue.fields.status = { name: 'Backlog' }
  f.controls.transitionList = backlog.filter(transition => transition.id !== '2')
  expect(await call('transition_work', { card_id, operation_id: 'missing', verb: 'Prioritize' })).toMatchObject({
    outcome: 'not-saved', message: expect.stringContaining('does not offer the requested named transition'),
  })
})

it.each([undefined, 'lost', 'unreadable'] as const)('confirms the dedicated audit comment from Jira readback with response %s', async commentResponse => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Audit comment', owner: 'Avery',
    description: 'Run the transition.\nSuccess: status and the audit comment are stored.',
  })
  const issue = f.issues.get('60001')!
  issue.fields.status = { name: 'Queued' }
  const evidence = 'The run finished.\n\nKept on TSW-1.'
  const input = { card_id, operation_id: 'start', verb: 'Start', evidence }
  f.controls.commentResponse = commentResponse
  expect(await call('transition_work', input)).toMatchObject({ outcome: 'saved', code: 'confirmed', card: { status: 'In Progress' } })
  expect(issue.comments).toHaveLength(1)
  const stored = issue.comments[0].body
  expect(stored.content).toContainEqual({ type: 'paragraph' })
  const writes = () => f.requests.filter(request => request.method === 'POST' && request.path.startsWith('issue/60001/'))
  expect(writes().map(request => request.path)).toEqual(['issue/60001/transitions', 'issue/60001/comment'])

  expect(await call('transition_work', input)).toMatchObject({ outcome: 'saved', code: 'already-saved' })
  issue.comments.unshift(...Array.from({ length: 50 }, (_, i) => ({ id: `new-${i}`, body: 'Newer comment' })))
  expect(await call('transition_work', input)).toMatchObject({
    outcome: 'saved', code: 'already-saved', card: { status: 'In Progress' }, message: expect.stringContaining('audit note may be missing'),
  })
  expect(writes()).toHaveLength(2)

  issue.fields.status = { name: 'Queued' }
  f.controls.omitComment = true
  expect(await call('transition_work', { ...input, operation_id: 'start-missing' })).toMatchObject({
    code: 'unconfirmed', message: expect.stringContaining('did not confirm the requested comment'),
  })
  expect(writes()).toHaveLength(4)
})

it('records a rejected audit POST even when a matching note arrives during the transition', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Audit comment', owner: 'Avery', description: 'Ready for work',
  })
  const input = { card_id, operation_id: 'fast-track', verb: 'Fast-track', evidence: 'Ready for work' }
  f.controls.delayedComment = 'Fast-track via Tin Star (Fixture agent)\nEvidence: Ready for work'
  f.controls.commentResponse = 'rejected'
  const result = await call('transition_work', input)
  expect(result).toMatchObject({ outcome: 'partially-saved', message: expect.stringContaining('rejected the audit comment (HTTP 403)') })
  expect((await call('get_work', { card_id })).card.status).toBe('Queued')
  const beforeRetry = f.requests.length
  expect(await call('transition_work', input)).toEqual(result)
  expect(f.requests).toHaveLength(beforeRetry)
})

it.each(['initial', 'matching retry', 'missing retry'])('checks the destination after the audit read on a %s', async mode => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Audit comment', owner: 'Avery', description: 'Ready for work',
  })
  const input = { card_id, operation_id: 'fast-track', verb: 'Fast-track', evidence: 'Ready for work' }
  if (mode !== 'initial') expect(await call('transition_work', input)).toMatchObject({ outcome: 'saved' })
  const issue = f.issues.get('60001')!
  if (mode === 'missing retry') issue.comments.length = 0
  f.controls.statusDuringCommentRead = 'Backlog'
  expect(await call('transition_work', input)).toMatchObject({
    outcome: 'partially-saved', code: 'unconfirmed', message: expect.stringContaining('destination status'),
  })
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue/60001/comment')).toHaveLength(1)
})

it.each(['acknowledged', 'wrong-id', 'lost'] as const)('distinguishes audit writes from an earlier matching note with a %s response', async mode => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Audit comment', owner: 'Avery', description: 'Ready for work',
  })
  const evidence = 'Ready for work'
  f.controls.delayedComment = `Fast-track via Tin Star (Fixture agent)\nEvidence: ${evidence}`
  f.controls.commentResponse = mode === 'acknowledged' ? undefined : mode
  f.controls.omitComment = mode === 'lost'
  const result = await call('transition_work', { card_id, operation_id: 'fast-track', verb: 'Fast-track', evidence })
  expect(result).toMatchObject(mode === 'acknowledged'
    ? { outcome: 'saved', card: { status: 'Queued' } }
    : { outcome: 'partially-saved', code: 'unconfirmed', message: expect.stringContaining('did not confirm the requested comment') })
  expect(f.issues.get('60001')!.comments).toHaveLength(mode === 'lost' ? 1 : 2)
})

it('reconciles an unaudited transition with a lost response only on retry', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Prioritize', owner: 'Avery',
  })
  const input = { card_id, operation_id: 'prioritize', verb: 'Prioritize' }
  f.controls.loseEdit = true
  expect(await call('transition_work', input)).toMatchObject({ outcome: 'partially-saved', code: 'unconfirmed' })
  expect(await call('transition_work', input)).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { status: 'To Do' } })
  expect(f.requests.filter(request => request.method === 'POST' && request.path.startsWith('issue/60001/'))
    .map(request => request.path)).toEqual(['issue/60001/transitions'])
})

it.each(['evicted', 'baseline unavailable', 'baseline and response unavailable', 'project changed during baseline'] as const)(
  'checks initial audit confirmation when the comment readback is %s', async mode => {
    const f = await fixture()
    const { call } = await f.connect()
    const { card: { id: card_id } } = await call('create_work', {
      provider: 'jira', operation_id: 'create', name: 'Audit comment', owner: 'Avery', description: 'Ready for work',
    })
    f.controls.newerCommentsAfterPost = mode === 'evicted'
    f.controls.loseBaselineTime = mode.startsWith('baseline')
    f.controls.moveDuringComments = mode === 'project changed during baseline'
    if (mode === 'baseline and response unavailable') f.controls.commentResponse = 'lost'

    const result = await call('transition_work', { card_id, operation_id: 'fast-track', verb: 'Fast-track', evidence: 'Ready for work' })
    expect(result).toMatchObject(mode === 'evicted' || mode === 'baseline unavailable'
      ? { outcome: 'saved', code: 'confirmed', card: { status: 'Queued' } }
      : { outcome: 'partially-saved', code: 'unconfirmed' })
    expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue/60001/comment'))
      .toHaveLength(mode === 'project changed during baseline' ? 0 : 1)
  },
)

it.each([
  ['ID', { id: '999' }],
  ['visibility', { visibility: { type: 'role', value: 'Administrators' } }],
  ['body', { body: 'Different note' }],
  ['author', { author: { accountId: 'another-account' } }],
] as const)('leaves the audit unconfirmed when a successful comment GET returns the wrong %s', async (_field, overrides) => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', {
    provider: 'jira', operation_id: 'create', name: 'Audit comment', owner: 'Avery', description: 'Ready for work',
  })
  f.controls.directCommentOverrides = overrides

  expect(await call('transition_work', { card_id, operation_id: 'fast-track', verb: 'Fast-track', evidence: 'Ready for work' }))
    .toMatchObject({ outcome: 'partially-saved', code: 'unconfirmed', message: expect.stringContaining('did not confirm the requested comment') })
  expect(f.issues.get('60001')!.comments.map(comment => comment.id)).toEqual(['1'])
  expect(f.requests).toContainEqual({ method: 'GET', path: 'issue/60001/comment/1', fields: null })
  expect((await call('get_work', { card_id })).card.status).toBe('Queued')
})

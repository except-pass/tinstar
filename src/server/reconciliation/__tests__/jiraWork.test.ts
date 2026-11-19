import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const types = [
  { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  { id: '10001', name: 'Relates', inward: 'relates to', outward: 'relates to' },
]
const transitions = jiraVerbs.flatMap((name, index) => jiraTransitions[name][1].map((to, destination) => ({
  id: String(index * 10 + destination + 1), name, to: { name: to },
})))
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
  const history: Record<string, any[]> = {}
  const requests: { method: string; path: string; fields: string | null }[] = []
  const controls = { loseCreate: false, loseEdit: false, refuseTransition: false, omitComment: false, rejectSearch: false, staleSearch: false, wrongCreate: false, beforeWrite: '', loseLink: false, moveDuringComments: false, delayedComment: '', delayedCommentAuthor: 'fixture-service', delayedCommentTime: '' }
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
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${config.token}`)
    const path = url.pathname.replace(`/ex/jira/${cloudId}/rest/api/3/`, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, fields: url.searchParams.get('fields') })
    if (controls.beforeWrite === `${method} ${path}`) {
      controls.beforeWrite = ''
      throw new Error('Process stopped before Jira received the write')
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
      return response({ ...issue, fields: { ...issue.fields, issuelinks } })
    }
    if (part?.startsWith('properties/') && method === 'GET') {
      const key = part.slice('properties/'.length)
      return Object.hasOwn(issue.properties, key) ? response({ key, value: issue.properties[key] }) : response({}, 404)
    }
    if (part === 'changelog' && method === 'GET') return response({ startAt: 0, isLast: true, values: history[issue.id] ?? [] })
    if (part === 'comment' && method === 'GET') {
      if (controls.moveDuringComments) {
        issue.fields.project = { id: '10002' }
        issue.comments.push({ id: 'foreign', body: 'Destination project comment' })
      }
      const startAt = Number(url.searchParams.get('startAt'))
      return response({ startAt, total: issue.comments.length, comments: issue.comments.slice(startAt, startAt + 50) })
    }
    if (part === 'transitions' && method === 'GET') {
      const available = transitions.filter(transition => jiraTransitions[transition.name][0].some(status => status === issue.fields.status.name))
      return response({ transitions: available })
    }
    if ((!part && method === 'PUT') || (part === 'transitions' && method === 'POST')) {
      if (part && controls.refuseTransition) return response({}, 409)
      if (!part && body.fields[config.fields.owner] && !['Avery', 'Taylor'].includes(body.fields[config.fields.owner].value)) return response({}, 400)
      if (part) issue.fields.status = transitions.find(transition => transition.id === body.transition.id)!.to
      Object.assign(issue.fields, body.fields)
      for (const property of body.properties ?? []) issue.properties[property.key] = property.value
      const created = new Date().toISOString()
      for (const comment of body.update?.comment ?? []) {
        if (!controls.omitComment) issue.comments.push({ id: String(issue.comments.length + 1), body: comment.add.body, created, updated: created, author: { accountId: 'fixture-service' } })
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
  return { connect, requests, controls, issues, links, history, historicalKeys }
}

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
  expect(await move('answer-status', 'Answer Decision', { to: 'In Progress' })).toMatchObject({ outcome: 'saved' })
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
  expect(await move('cleared', 'Resolve Wait', { to: 'In Progress', evidence: 'The dependency was accepted.' })).toMatchObject({ outcome: 'saved' })
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
  f.issues.get('60001')!.fields.summary = 'Title changed natively'
  const confirmed = await second.call('create_work', args)
  expect(confirmed).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { issue_type: 'Epic', issue_id: '60001', name: 'Title changed natively' } })
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue')).toHaveLength(1)
  expect(await second.call('create_work', { ...args, name: 'Changed input' })).toMatchObject({ outcome: 'not-saved', code: 'invalid-work' })
  const card_id = confirmed.card.id
  f.controls.loseEdit = true
  const edit = { kind: 'jira_edit', card_id, operation_id: 'edit-proof', owner: 'Taylor', description: 'Inspect the test output.', note: 'One comment only.' }
  expect(await second.call('update_work', edit)).toMatchObject({ outcome: 'partially-saved' })
  f.issues.get('60001')!.fields[config.fields.owner] = { value: 'Avery' }
  f.history['60001'] = [{ created: new Date().toISOString(), author: { accountId: 'fixture-service' }, items: [
    { fieldId: config.fields.owner, fromString: null, toString: 'Taylor' },
    { fieldId: 'description', fromString: null, toString: 'Inspect the test output.' },
  ] }]

  const third = await f.connect()
  expect(await third.call('update_work', edit)).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { owner: 'Avery' } })
  expect(f.issues.get('60001')!.comments).toHaveLength(1)
  f.controls.refuseTransition = true
  const move = { card_id, operation_id: 'fast-track', verb: 'Fast-track', evidence: 'Fixture checks are named.' }
  const rejected = await third.call('transition_work', move)
  expect(rejected).toMatchObject({ outcome: 'not-saved', message: expect.stringContaining('409') })
  expect((await third.call('get_work', { card_id })).card.status).toBe('Backlog')
  f.controls.refuseTransition = false
  const beforeRetry = f.requests.length
  expect(await third.call('transition_work', move)).toEqual(rejected)
  expect(f.requests).toHaveLength(beforeRetry)
  f.controls.loseEdit = true
  const nextMove = { ...move, operation_id: 'accepted-fast-track' }
  expect(await third.call('transition_work', nextMove)).toMatchObject({ code: 'unconfirmed' })
  f.history['60001']!.push({ created: new Date().toISOString(), author: { accountId: 'fixture-service' },
    items: [{ fieldId: 'status', fromString: 'Backlog', toString: 'Queued' }] })
  expect(await third.call('transition_work', nextMove)).toMatchObject({ code: 'already-saved', card: { status: 'Queued' } })
  f.controls.omitComment = true
  const omit = { kind: 'jira_edit', card_id, operation_id: 'omit', description: 'New instructions', note: 'Jira omitted this' }
  expect(await third.call('update_work', omit)).toMatchObject({ code: 'unconfirmed' })
  f.history['60001']!.push({ created: new Date().toISOString(), author: { accountId: 'fixture-service' }, items: [
    { fieldId: 'description', fromString: 'Inspect the test output.', toString: 'New instructions' },
  ] })
  expect(await third.call('update_work', omit)).toMatchObject({ code: 'unconfirmed' })
  expect(f.requests.filter(request => request.method === 'PUT' && request.path === 'issue/60001')).toHaveLength(2)
  expect(await third.call('transition_work', { card_id, operation_id: 'dequeue', verb: 'Dequeue' })).toMatchObject({ outcome: 'saved', card: { status: 'To Do' } })
  f.controls.omitComment = false
  const moveAgain = (operation_id: string, verb: string, fields: Record<string, unknown> = {}) =>
    third.call('transition_work', { card_id, operation_id, verb, ...fields })
  expect(await moveAgain('queue-again', 'Queue')).toMatchObject({ outcome: 'saved' })
  expect(await moveAgain('start-work', 'Start', { evidence: 'The test is running.' })).toMatchObject({ outcome: 'saved' })
  expect(await moveAgain('stop-without-reconciling', 'Stop and Requeue', { evidence: 'Named test checks are ready.' })).toMatchObject({ outcome: 'not-saved' })
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
  f.links.delete('8001')
  expect(await call('link_work', { ...add, operation_id: 'replacement' })).toMatchObject({ outcome: 'saved' })
  expect(await call('link_work', { ...remove, operation_id: 'remove-replacement', link_id: '8002' })).toMatchObject({ outcome: 'saved' })
  f.history['60001'] = [{
    created: new Date().toISOString(), author: { accountId: 'fixture-service' },
    items: [{ field: 'Link', fromLinkId: '8002', from: 'OTHER-1', fromString: 'This issue blocks OTHER-1', to: null }],
  }]
  expect(await call('link_work', remove)).toMatchObject({ code: 'unconfirmed' })
  expect(f.requests.filter(request => request.method === 'DELETE' && request.path === 'issueLink/8001')).toHaveLength(1)

  f.controls.loseLink = true
  const superseded = { ...add, operation_id: 'superseded' }
  expect(await call('link_work', superseded)).toMatchObject({ code: 'unconfirmed' })
  f.history['60001']!.push({
    created: new Date().toISOString(), author: { accountId: 'fixture-service' },
    items: [{ field: 'Link', from: null, to: 'OTHER-1', toString: 'This issue blocks OTHER-1' }],
  })
  f.links.delete('8003')
  expect(await call('link_work', superseded)).toMatchObject({ code: 'already-saved', card: { links: [] } })
  expect(f.links.size).toBe(0)

  f.controls.wrongCreate = true
  const wrong = { ...create, operation_id: 'wrong-create' }
  expect(await call('create_work', wrong)).toMatchObject({ code: 'unconfirmed' })
  f.issues.get('60003')!.fields.summary = wrong.name
  expect(await call('create_work', wrong)).toMatchObject({ code: 'unconfirmed' })
}, 30_000)

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


it('leaves overlapping edit and reversed link history unconfirmed', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const first = await call('create_work', { provider: 'jira', operation_id: 'first', name: 'Original' })
  const second = await call('create_work', { provider: 'jira', operation_id: 'second', name: 'Neighbor' })
  const card_id = first.card.id
  const edit = { kind: 'jira_edit', card_id, operation_id: 'lost-subset', name: 'Changed' }
  f.controls.beforeWrite = 'PUT issue/60001'
  expect(await call('update_work', edit)).toMatchObject({ code: 'unconfirmed' })
  expect(await call('update_work', { ...edit, operation_id: 'saved-superset', owner: 'Avery' })).toMatchObject({ outcome: 'saved' })
  const history = (items: Record<string, unknown>[]) => ({ created: new Date().toISOString(), author: { accountId: 'fixture-service' }, items })
  f.history['60001'] = [history([
    { fieldId: 'summary', fromString: 'Original', toString: 'Changed' },
    { fieldId: config.fields.owner, fromString: null, toString: 'Avery' },
  ])]
  expect(await call('update_work', edit)).toMatchObject({ code: 'unconfirmed' })

  const add = { card_id, action: 'add', operation_id: 'lost-link', target_key: 'WORK-2', direction: 'outward', type: 'Blocks' }
  f.controls.beforeWrite = 'POST issueLink'
  expect(await call('link_work', add)).toMatchObject({ code: 'unconfirmed' })
  expect(await call('link_work', { ...add, card_id: second.card.id, operation_id: 'opposite-link', target_key: 'WORK-1', direction: 'inward' }))
    .toMatchObject({ outcome: 'saved' })
  f.history['60001']!.push(history([{ field: 'Link', from: null, to: 'WORK-2', toString: 'This issue blocks WORK-2' }]))
  expect(await call('link_work', add)).toMatchObject({ code: 'unconfirmed' })
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issueLink')).toHaveLength(2)
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
  expect(f.requests.slice(before)).toEqual(Array.from({ length: 5 }, () =>
    ({ method: 'GET', path: 'issue/60001', fields: 'project' })))
}, 30_000)

it('does not attribute a delayed earlier write to a newer dispatched receipt', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Original' })
  const edit = { kind: 'jira_edit', card_id, name: 'Changed' }
  for (const operation_id of ['earlier', 'newer']) {
    f.controls.beforeWrite = 'PUT issue/60001'
    expect(await call('update_work', { ...edit, operation_id })).toMatchObject({ code: 'unconfirmed' })
  }
  f.issues.get('60001')!.fields.summary = 'Changed'
  f.history['60001'] = [{ created: new Date().toISOString(), author: { accountId: 'fixture-service' },
    items: [{ fieldId: 'summary', fromString: 'Original', toString: 'Changed' }] }]
  expect(await call('update_work', { ...edit, operation_id: 'newer' })).toMatchObject({ code: 'unconfirmed' })
  expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(2)
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

it('recovers a later comment and field change despite an unrelated earlier dispatch', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Ticket' })
  const edit = { kind: 'jira_edit', card_id }
  f.controls.beforeWrite = 'PUT issue/60001'
  expect(await call('update_work', { ...edit, operation_id: 'earlier', name: 'Uncertain title', note: 'Earlier note' }))
    .toMatchObject({ code: 'unconfirmed' })
  const later = { ...edit, operation_id: 'later', description: 'New description', note: 'Later note' }
  f.controls.loseEdit = true
  expect(await call('update_work', later)).toMatchObject({ code: 'unconfirmed' })
  f.history['60001'] = [{ created: new Date().toISOString(), author: { accountId: 'fixture-service' },
    items: [{ fieldId: 'description', fromString: null, toString: 'New description' }] }]
  expect(await call('update_work', later)).toMatchObject({ code: 'already-saved', card: { description: 'New description' } })
  expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(2)
}, 30_000)


it('does not confirm a later edit using an earlier dispatch’s identical note', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Ticket' })
  const edit = { kind: 'jira_edit', card_id, note: 'Same note' }
  f.controls.beforeWrite = 'PUT issue/60001'
  expect(await call('update_work', { ...edit, operation_id: 'earlier', name: 'Earlier title' })).toMatchObject({ code: 'unconfirmed' })
  const later = { ...edit, operation_id: 'later', description: 'New description' }
  f.controls.omitComment = true
  f.controls.delayedComment = 'Same note\n\nRecorded via Tin Star (Fixture agent)'
  expect(await call('update_work', later)).toMatchObject({ code: 'unconfirmed' })
  f.history['60001'] = [{ created: new Date().toISOString(), author: { accountId: 'fixture-service' },
    items: [{ fieldId: 'description', fromString: null, toString: 'New description' }] }]
  expect(await call('update_work', later)).toMatchObject({ code: 'unconfirmed' })
  expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(2)
}, 30_000)

it('accepts transition revision arguments only for Deployed', async () => {
  const f = await fixture()
  const { client, call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Ticket' })
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'transition_work')!.inputSchema
  const validate = new Ajv({ strict: false }).compile(schema)
  const revisions = { required_revision: 'rev-a', live_revision: 'rev-a' }
  for (const verb of jiraVerbs) {
    expect(validate({ card_id, operation_id: 'check', verb, ...revisions })).toBe(verb === 'Deployed')
  }
  const before = f.requests.length
  for (const field of ['required_revision', 'live_revision']) {
    const result = await client.callTool({ name: 'transition_work',
      arguments: { card_id, operation_id: field, verb: 'Queue', [field]: 'rev-a' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Only Deployed')
  }
  expect(f.requests).toHaveLength(before)
}, 30_000)


it('recovers a delayed comment after an independent dispatch with a different note', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Ticket' })
  const edit = { kind: 'jira_edit', card_id }
  const earlier = { ...edit, operation_id: 'earlier', name: 'Updated title', note: 'Earlier note' }
  f.controls.beforeWrite = 'PUT issue/60001'
  expect(await call('update_work', earlier)).toMatchObject({ code: 'unconfirmed' })
  expect(await call('update_work', { ...edit, operation_id: 'later', description: 'New description', note: 'Later note' }))
    .toMatchObject({ outcome: 'saved' })
  const issue = f.issues.get('60001')!
  const created = new Date().toISOString()
  issue.fields.summary = earlier.name
  issue.comments.push({ id: 'delayed', body: 'Earlier note\n\nRecorded via Tin Star (Fixture agent)', created, updated: created, author: { accountId: 'fixture-service' } })
  f.history['60001'] = [{ created, author: { accountId: 'fixture-service' },
    items: [{ fieldId: 'summary', fromString: 'Ticket', toString: earlier.name }] }]
  expect(await call('update_work', earlier)).toMatchObject({ code: 'already-saved', card: { name: earlier.name } })
  expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(2)
}, 30_000)


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
  f.history['60001'] = [{ created: new Date().toISOString(), author: { accountId: 'fixture-service' },
    items: [
      { field: 'Link', from: null, to: 'DELETED-1', toString: 'This issue blocks DELETED-1' },
      { field: 'Link', from: null, to: 'OLD-2', toString: 'This issue blocks OLD-2' },
    ] }]
  const saved = await call('link_work', pending)
  expect(saved).toMatchObject({ code: 'already-saved', card: { links: [{ target_key: 'WORK-2' }] } })
  expect(saved.card.links[0]).not.toHaveProperty('target_id')
  expect(await call('link_work', { ...add, operation_id: 'duplicate', target_key: 'WORK-2' })).toMatchObject({ outcome: 'saved' })
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issueLink')).toHaveLength(1)
}, 30_000)

it('does not use a natively edited comment to confirm an earlier missing note', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const { card: { id: card_id } } = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Ticket' })
  const edit = { kind: 'jira_edit', card_id }
  const earlier = { ...edit, operation_id: 'earlier', name: 'Updated title', note: 'Missing note' }
  f.controls.omitComment = true
  expect(await call('update_work', earlier)).toMatchObject({ code: 'unconfirmed' })
  f.controls.omitComment = false
  expect(await call('update_work', { ...edit, operation_id: 'later', description: 'New description', note: 'Later note' }))
    .toMatchObject({ outcome: 'saved' })
  const comment = f.issues.get('60001')!.comments[0]!
  comment.body = 'Missing note\n\nRecorded via Tin Star (Fixture agent)'
  comment.updated = new Date(Date.parse(comment.created) + 1000).toISOString()
  f.history['60001'] = [{ created: comment.created, author: { accountId: 'fixture-service' },
    items: [{ fieldId: 'summary', fromString: 'Ticket', toString: earlier.name }] }]
  expect(await call('update_work', earlier)).toMatchObject({ code: 'unconfirmed' })
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

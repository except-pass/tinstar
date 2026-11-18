import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const requests: { method: string; path: string }[] = []
  const controls = { loseCreate: false, loseEdit: false, refuseTransition: false, omitComment: false, rejectSearch: false }
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
    requests.push({ method, path })
    if (path === 'search/jql') {
      if (controls.rejectSearch) return response({}, 403)
      expect(body.jql).toContain(`project = ${config.projectId}`)
      return response({ isLast: true, issues: [...issues.values()].filter(issue => issue.fields.project.id === config.projectId) })
    }
    if (path === 'issue' && method === 'POST') {
      if (body.fields[config.fields.owner] && !['Avery', 'Taylor'].includes(body.fields[config.fields.owner].value)) return response({}, 400)
      const id = String(nextIssue++)
      const issue = make(id, `WORK-${Number(id) - 60000}`, config.projectId, body.fields)
      issues.set(id, issue)
      for (const property of body.properties) issue.properties[property.key] = property.value
      if (controls.loseCreate) { controls.loseCreate = false; throw new Error('Dropped response containing fixture-scoped-service-token') }
      return response({ id, key: issue.key }, 201)
    }
    if (path === 'issueLinkType') return response({ issueLinkTypes: types })
    if (path === 'issueLink' && method === 'POST') {
      const type = types.find(type => type.id === body.type.id)!
      links.set(String(nextLink++), { type, inwardIssue: body.inwardIssue.id, outwardIssue: body.outwardIssue.id })
      return response(undefined, 204)
    }
    const linkPath = /^issueLink\/(\d+)$/.exec(path)
    if (linkPath && method === 'DELETE') return links.delete(linkPath[1]!) ? response(undefined, 204) : response({}, 404)
    const match = /^issue\/([^/]+)(?:\/(.*))?$/.exec(path)
    if (!match) throw new Error(`Unexpected fixture request ${method} ${path}`)
    const issue = issues.get(match[1]!) ?? [...issues.values()].find(issue => issue.key === match[1])
    if (!issue) return response({}, 404)
    const part = match[2]
    if (!part && method === 'GET') {
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
    if (part === 'comment' && method === 'GET') {
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
      for (const property of body.properties) issue.properties[property.key] = property.value
      for (const comment of body.update?.comment ?? []) {
        if (!controls.omitComment) issue.comments.push({ id: String(issue.comments.length + 1), body: comment.add.body, created: issue.fields.updated, author: { accountId: 'fixture-service' } })
      }
      if (controls.loseEdit) { controls.loseEdit = false; throw new Error('Dropped issue write response') }
      return response(undefined, 204)
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`)
  }
  async function connect() {
    const sources = new ReconciliationSources(parsed, fetcher, undefined, root)
    const mcp = new ReconciliationMcp(sources, root)
    const [remote, local] = InMemoryTransport.createLinkedPair()
    const server = mcp.createServer('Fixture agent')
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
  return { connect, requests, controls, issues, links }
}

it('uses the existing MCP tools for native ticket edits, decision history, blockers, links and disposition', async () => {
  const f = await fixture()
  const { client, call } = await f.connect()
  const names = (await client.listTools()).tools.map(tool => tool.name)
  for (const name of ['create_work', 'get_work', 'update_work', 'transition_work', 'link_work']) expect(names.filter(tool => tool === name)).toHaveLength(1)
  const created = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Synthetic Jira Work' })
  expect(created).toMatchObject({ outcome: 'saved', card: { key: 'WORK-1', issue_id: '60001', owner: null, status: 'Backlog', issue_type: 'Task' } })
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
  expect(await edit('answer-two', { answers: [{ id: 'D2', answer: 'Keep the current label.' }] })).toMatchObject({ outcome: 'saved' })
  expect(await move('answer-status', 'Answer Decision', { to: 'In Progress' })).toMatchObject({ outcome: 'saved' })
  expect(await edit('external', { blocker: { type: 'Actor', target: 'team:reviewers', unblocks_when: 'A reviewer grants access.' } })).toMatchObject({ outcome: 'saved', card: { blocker: { type: 'Actor' } } })
  expect(await move('wait', 'Block')).toMatchObject({ outcome: 'saved', card: { status: 'Waiting For' } })
  expect(await edit('change-blocker', { blocker: { type: 'Event', target: 'event:approval-1', unblocks_when: 'The approval event is recorded.' } })).toMatchObject({ outcome: 'saved', card: { blocker: { type: 'Event' } } })
  expect(await link('two-blockers', { action: 'add', target_key: 'OTHER-1', type: 'Blocks', direction: 'inward' })).toMatchObject({ outcome: 'not-saved' })
  expect(await edit('clear-external', { blocker: null })).toMatchObject({ outcome: 'saved', card: { blocker: null } })
  const linked = await link('jira-blocker', { action: 'add', target_key: 'OTHER-1', type: 'Blocks', direction: 'inward' })
  expect(linked, JSON.stringify(linked)).toMatchObject({ outcome: 'saved', card: { blocker: { type: 'Jira', link: { id: '8001', target_id: '70001', label: 'is blocked by' } } } })
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
  const read = await call('get_work', { card_id })
  expect(read).toMatchObject({ outcome: 'available', card: { id: card_id, key: 'WORK-1' }, comments: expect.arrayContaining([expect.objectContaining({ body: expect.stringContaining('Requirement was withdrawn.') })]) })
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
  const confirmed = await second.call('create_work', args)
  expect(confirmed).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { issue_type: 'Epic', issue_id: '60001' } })
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue')).toHaveLength(1)
  expect(await second.call('create_work', { ...args, name: 'Changed input' })).toMatchObject({ outcome: 'not-saved', code: 'invalid-work' })
  const card_id = confirmed.card.id
  f.controls.loseEdit = true
  const edit = { kind: 'jira_edit', card_id, operation_id: 'edit-proof', owner: 'Taylor', description: 'Inspect the test output.', note: 'One comment only.' }
  expect(await second.call('update_work', edit)).toMatchObject({ outcome: 'partially-saved' })
  const third = await f.connect()
  expect(await third.call('update_work', edit)).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { owner: 'Taylor' } })
  expect(f.issues.get('60001')!.comments).toHaveLength(1)
  f.controls.refuseTransition = true
  const move = { card_id, operation_id: 'fast-track', verb: 'Fast-track', evidence: 'Fixture checks are named.' }
  expect(await third.call('transition_work', move)).toMatchObject({ outcome: 'not-saved' })
  expect((await third.call('get_work', { card_id })).card.status).toBe('Backlog')
  f.controls.refuseTransition = false
  expect(await third.call('transition_work', move)).toMatchObject({ outcome: 'saved', card: { status: 'Queued' } })
  f.controls.omitComment = true
  expect(await third.call('update_work', { kind: 'jira_edit', card_id, operation_id: 'omit', note: 'Jira omitted this' })).toMatchObject({ outcome: 'partially-saved' })
  expect(await third.call('transition_work', { card_id, operation_id: 'dequeue', verb: 'Dequeue' })).toMatchObject({ outcome: 'saved', card: { status: 'To Do' } })
  f.controls.omitComment = false
  const moveAgain = (operation_id: string, verb: string, fields: Record<string, unknown> = {}) =>
    third.call('transition_work', { card_id, operation_id, verb, ...fields })
  expect(await moveAgain('queue-again', 'Queue', { evidence: 'The fixture checks native readback.' })).toMatchObject({ outcome: 'saved' })
  expect(await moveAgain('start-work', 'Start', { evidence: 'The test is running.' })).toMatchObject({ outcome: 'saved' })
  expect(await moveAgain('stop-without-reconciling', 'Stop and Requeue', { evidence: 'Named test checks are ready.' })).toMatchObject({ outcome: 'not-saved' })
  expect(await moveAgain('stop', 'Stop and Requeue', { disposition: 'The previous test process exited.', evidence: 'The reproduction and assertions are ready.' })).toMatchObject({ outcome: 'saved', card: { status: 'Queued' } })
  expect(await moveAgain('start-again', 'Start', { evidence: 'The reproduction started.' })).toMatchObject({ outcome: 'saved' })
  expect(await moveAgain('direct', 'Complete Directly', { evidence: 'The reproduction passed. No review or production change remains.' })).toMatchObject({ outcome: 'saved', card: { status: 'Done' } })
}, 30_000)

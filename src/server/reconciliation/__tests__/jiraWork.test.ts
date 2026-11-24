import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it, vi } from 'vitest'
import { loadReconciliationConfig, type JiraWorkConfig } from '../config'
import { ReconciliationSources } from '..'
import { ReconciliationMcp } from '../mcp'
import { buildQueue } from '../queue'
import { jiraTransitions, jiraVerbs } from '../jiraWorkRules'
import { JiraWork } from '../jiraWork'
import { adfText } from '../jira'
import { runTswStatusSync } from '../../../coordinator/tswStatusSync'
import { prepareClawsonMerge } from '../../pulls/clawsonMerge'

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

async function fixture(projectId = config.projectId, withNotion = false) {
  const root = await mkdtemp(join(tmpdir(), 'jira-work-mcp-'))
  roots.push(root)
  const { token: _token, ...settings } = config
  const notion = { token: 'fixture-notion-token', dataSourceId: 'a'.repeat(32) }
  const notionCard = { id: 'b'.repeat(32), url: `https://www.notion.so/${'b'.repeat(32)}`, object: 'page', last_edited_time: '2026-01-01T12:00:00Z',
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Legacy fixture' }] }, Owner: { type: 'select', select: { name: 'Clawson' } },
      Status: { type: 'status', status: { name: 'Queued' } }, 'Next check-in': { type: 'date', date: { start: '2026-01-03' } },
      'Last touched by': { type: 'rich_text', rich_text: [{ plain_text: 'Fixture writer' }] },
    } }
  await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: { jira: { ...settings, projectId, token: config.token }, ...(withNotion ? { notion } : {}) } }), { mode: 0o600 })
  const parsed = loadReconciliationConfig(root)
  expect(parsed.jiraWork).toMatchObject({ ...settings, projectId })
  expect(parsed.jira).toBeUndefined()
  const historicalKeys = new Map<string, string>()
  const requests: { method: string; path: string; fields: string | null }[] = []
  const search = { directoryUnavailable: false, deniedRead: '', pageSize: 100, failFrom: Infinity, failureStatus: 503, indexed: new Map<string, Record<string, any>>() }
  const controls = { loseCreate: false, loseEdit: false, refuseTransition: false, omitComment: false, commentResponse: undefined as 'lost' | 'unreadable' | 'rejected' | 'unavailable' | 'wrong-id' | undefined, directCommentOverrides: {} as Record<string, unknown>, statusDuringCommentRead: '', loseBaselineTime: false, newerCommentsAfterPost: false, rejectSearch: false, staleSearch: false, wrongCreate: false, beforeWrite: '', loseLink: false, moveDuringComments: false, delayedComment: '', delayedCommentAuthor: 'fixture-service', delayedCommentTime: '', transitionList: undefined as Array<{ id: string; name: string; to: { id?: string; name: string }; isAvailable?: boolean }> | undefined, lastTransitionId: '' }
  const issues = new Map<string, { id: string; key: string; fields: Record<string, any>; properties: Record<string, unknown>; comments: any[] }>()
  const links = new Map<string, { type: typeof types[number]; inwardIssue: string; outwardIssue: string }>()
  const attachments = new Map<string, unknown>()
  let dropCompletionAfterRead = false
  const history = new Map<string, Array<{ id: string; created: string; author: { accountId: string }; items: unknown[] }>>()
  const appendHistory = (id: string, items: unknown[], accountId = 'fixture-service') => {
    const entries = history.get(id) ?? []
    entries.push({ id: String(entries.length + 1), created: jiraNow(), author: { accountId }, items })
    history.set(id, entries)
  }
  const assignees = [
    { displayName: 'William Gathright', accountId: 'will-account', active: true },
    { displayName: 'Robyn A', accountId: 'rob-a', active: true },
    { displayName: 'Robyn B', accountId: 'rob-b', active: true },
  ]
  let nextIssue = 60001, nextLink = 8001
  const make = (id: string, key: string, project: string, fields: Record<string, any> = {}) => ({
    id, key, fields: { summary: 'Fixture', status: { name: 'Backlog' }, updated: '2026-01-01T12:00:00Z',
      issuetype: { id: config.issueTypes.Task }, description: null, attachment: [], duedate: null, project: { id: project }, assignee: null,
      ...Object.fromEntries(Object.values(config.fields).map(field => [field, null])), ...fields },
    properties: Object.create(null) as Record<string, unknown>, comments: [] as any[],
  })
  issues.set('70001', make('70001', 'OTHER-1', '10002'))
  const fetcher: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw))
    if (withNotion && url.origin === 'https://api.notion.com') {
      const base = `/v1/data_sources/${notion.dataSourceId}`
      if (url.pathname === base) return response({ object: 'data_source', properties: notionCard.properties })
      if (url.pathname === `${base}/query`) return response({ has_more: false, results: [notionCard] })
      throw new Error(`Unexpected Notion fixture request: ${url.pathname}`)
    }
    expect(url.origin).toBe('https://api.atlassian.com')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${config.token}`)
    const english = headers.get('accept-language') === 'en' && headers.get('x-force-accept-language') === 'true'
    const statusName = (name: string) => english ? name : localizedStatuses.get(name) ?? name
    const path = url.pathname.replace(`/ex/jira/${cloudId}/rest/api/3/`, '')
    const method = init?.method ?? 'GET'
    const body = init?.body && !(init.body instanceof FormData) ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, fields: url.searchParams.get('fields') })
    if (method === 'GET' && search.deniedRead === path) return response({}, 403)
    if (controls.beforeWrite === `${method} ${path}`) {
      controls.beforeWrite = ''
      throw new Error('Process stopped before Jira received the write')
    }
    if (path === 'serverInfo') {
      if (controls.loseBaselineTime) throw new Error('Dropped server time response')
      return response({ serverTime: jiraNow() })
    }
    if (path === 'myself') return response({ accountId: 'fixture-service' })
    if (path === 'user/assignable/search') {
      if (search.directoryUnavailable) return response({}, 503)
      const name = url.searchParams.get('query')!.toLowerCase()
      expect(issues.has(url.searchParams.get('issueId')!)).toBe(true)
      return response(assignees.filter(user => user.displayName.toLowerCase().includes(name)))
    }
    if (path === 'search/jql') {
      const offset = Number(body.nextPageToken ?? 0), end = offset + search.pageSize
      if (controls.rejectSearch || offset >= search.failFrom) return response({}, search.failureStatus)
      expect(body.jql).toContain(`project = ${projectId}`)
      const query = /^project = (\d+)(?: AND issuetype IN \(([\d, ]+)\))?(?: AND cf\[(\d+)\] = ("(?:[^"\\]|\\.)*") AND status IN \((.+)\))? ORDER BY id( DESC)?$/.exec(body.jql)
      if (!query) return response({}, 400)
      const [, project, types, ownerField, owner, statuses, descending] = query
      const selectedOwner: string | undefined = owner === undefined ? undefined : JSON.parse(owner)
      const selectedStatuses: string[] | undefined = statuses === undefined ? undefined : JSON.parse(`[${statuses}]`)
      const visible = controls.staleSearch ? [] : [...issues.values()].map(issue => ({ ...issue, fields: search.indexed.get(issue.id) ?? issue.fields })).filter(issue => issue.fields.project.id === project &&
        (!types || types.split(', ').includes(issue.fields.issuetype?.id)) &&
        (!ownerField || issue.fields[`customfield_${ownerField}`]?.value === selectedOwner) &&
        (!selectedStatuses || selectedStatuses.includes(issue.fields.status.name)))
        .sort((a, b) => descending ? Number(b.id) - Number(a.id) : Number(a.id) - Number(b.id))
      return response({ issues: visible.slice(offset, end), isLast: end >= visible.length, ...(end < visible.length ? { nextPageToken: String(end) } : {}) })
    }
    if (path === 'issue' && method === 'POST') {
      if (body.fields[config.fields.owner] && !['Avery', 'Taylor', 'Clawson', 'Firstmate'].includes(body.fields[config.fields.owner].value)) return response({}, 400)
      const id = String(nextIssue++)
      const issue = make(id, `${projectId === '10639' ? 'TSW' : 'WORK'}-${Number(id) - 60000}`, projectId, body.fields)
      if (controls.wrongCreate) issue.fields.summary = 'Unexpected Jira summary'
      issues.set(id, issue)
      for (const property of body.properties ?? []) issue.properties[property.key] = property.value
      if (controls.loseCreate) { controls.loseCreate = false; throw new Error('Dropped response containing fixture-scoped-service-token') }
      return response({ id, key: issue.key }, 201)
    }
    if (path.startsWith('attachment/content/')) {
      const id = path.split('/')[2]!
      const body = attachments.get(id) as { sections: Array<{ text: string }> }
      if (dropCompletionAfterRead && body.sections.some(section => section.text.startsWith('Tin Star contract complete: '))) {
        dropCompletionAfterRead = false
        for (const issue of issues.values()) issue.fields.attachment = issue.fields.attachment.filter((file: { id: string }) => file.id !== id)
      }
      return response(body)
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
    if (part === 'changelog' && method === 'GET') {
      const startAt = Number(url.searchParams.get('startAt'))
      const maxResults = Number(url.searchParams.get('maxResults'))
      const entries = history.get(issue.id) ?? []
      return response({ startAt, total: entries.length, values: entries.slice(startAt, startAt + maxResults) })
    }
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
    if (part === 'attachments' && method === 'POST') {
      const file = (init?.body as FormData).get('file') as File
      const id = String(attachments.size + 1)
      attachments.set(id, JSON.parse(await file.text()))
      issue.fields.attachment.push({ id, filename: file.name })
      return response([{ id }], 201)
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
      if (controls.commentResponse === 'unavailable') return response({}, 503)
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
      if (controls.beforeWrite === 'change-handoff-blocker') {
        issue.fields[config.fields.blockerType] = { value: 'Actor' }
        issue.fields[config.fields.blockerTarget] = 'Will'
        issue.fields[config.fields.blockerCondition] = 'Approval needed.'
      }
      if (controls.beforeWrite === 'change-handoff-owner') issue.fields[config.fields.owner] = { value: 'Taylor' }
      const available = controls.transitionList ?? transitions.filter(transition => jiraTransitions[transition.name][0].some(status => status === issue.fields.status.name))
      const offered = available.map(transition => ({
        ...transition, to: { ...transition.to, name: statusName(transition.to.name) },
      }))
      return response({ transitions: offered })
    }
    if ((!part && method === 'PUT') || (part === 'transitions' && method === 'POST')) {
      if (part && controls.refuseTransition) return response({}, 409)
      if (!part && body.fields[config.fields.owner] && !['Avery', 'Taylor', 'Clawson', 'Firstmate', 'Firstmate fleet'].includes(body.fields[config.fields.owner].value)) return response({}, 400)
      if (part) {
        controls.lastTransitionId = body.transition.id
        const to = (controls.transitionList ?? transitions).find(transition => transition.id === body.transition.id)!.to
        appendHistory(issue.id, [{ fieldId: 'status', fromString: issue.fields.status.name, toString: to.name }])
        issue.fields.status = to
      }
      if (body.fields && Object.hasOwn(body.fields, 'assignee')) {
        const accountId = body.fields.assignee?.accountId ?? null
        const from = issue.fields.assignee?.accountId ?? null
        if (accountId !== from) appendHistory(issue.id, [{ fieldId: 'assignee', from, to: accountId }])
        body.fields.assignee = assignees.find(user => user.accountId === accountId) ?? null
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
    return { client, call, sources }
  }
  const jira = () => new JiraWork(parsed.jiraWork!, root, fetcher)
  return { root, connect, make, requests, controls, issues, links, historicalKeys, search, notionCard, appendHistory, assignees, jira,
    dropCompletionOnRead: () => { dropCompletionAfterRead = true } }
}

it('includes matching Jira and legacy Notion cards with independent search coverage', async () => {
  const f = await fixture(config.projectId, true)
  const { call } = await f.connect('Clawson')
  const active = f.make('60101', 'WORK-101', config.projectId, { summary: 'Native pickup fixture', status: { name: 'In Progress' }, duedate: '2026-01-04', [config.fields.owner]: { value: 'Clawson' } })
  const other = f.make('60102', 'WORK-102', config.projectId, { status: { name: 'Queued' }, [config.fields.owner]: { value: 'Taylor' } })
  const canceled = f.make('60103', 'WORK-103', config.projectId, { status: { name: 'Canceled' }, [config.fields.owner]: { value: 'Clawson' } })
  for (const issue of [active, other, canceled]) f.issues.set(issue.id, issue)
  for (let id = 60104; id < 60124; id++) {
    const nonmatching = id % 2 ? other : canceled
    f.issues.set(String(id), f.make(String(id), `WORK-${id - 60000}`, config.projectId, nonmatching.fields))
  }
  const unsupported = f.make('60125', 'WORK-125', config.projectId, { issuetype: { id: '99999', name: 'Bug' }, status: { name: 'Queued' }, [config.fields.owner]: { value: 'Clawson' } })
  f.issues.set(unsupported.id, unsupported)
  const queued = f.make('60124', 'WORK-124', config.projectId, { status: { name: 'Queued' }, [config.fields.owner]: { value: 'Clawson' } })
  f.issues.set(queued.id, queued)
  f.search.pageSize = 1
  const args = { owner: 'Clawson', statuses: ['Queued', 'In Progress'], limit: 100, refresh: true }
  const work = await call('search_work', args)
  expect(work.total).toBe(3)
  expect(work.coverage.intentions).toMatchObject({ status: 'fresh', coverage: 'complete', sources: [
    { source: 'notion', status: 'fresh', coverage: 'complete' }, { source: 'jira', status: 'fresh', coverage: 'complete' },
  ] })
  expect(work.records.map((record: any) => record.card.source)).toMatchObject([
    { id: f.notionCard.id, url: f.notionCard.url, properties: { Owner: { value: 'Clawson' }, Status: { value: 'Queued' }, 'Last touched by': { value: 'Fixture writer' } } },
    { id: `jira:${new URL(config.url).hostname}:${config.projectId}:${active.id}`, url: `${config.url}/browse/${active.key}`, last_edited_time: active.fields.updated,
      archived: false, in_trash: false, properties: { Owner: { value: 'Clawson' }, Status: { value: 'In Progress' }, Name: { value: active.fields.summary },
        'Next check-in': { value: { start: '2026-01-04', end: null, time_zone: null } }, 'Last touched by': { value: null } } },
    { id: `jira:${new URL(config.url).hostname}:${config.projectId}:${queued.id}`, properties: { Status: { value: 'Queued' } } },
  ])
  expect(f.requests.filter(request => request.path === 'search/jql')).toHaveLength(2)
  f.search.pageSize = 100
  expect(await call('search_work', { owner: 'Clawson', history: true })).toMatchObject({ total: 3 })
  const selected = await call('search_work', { owner: 'Clawson', statuses: ['Canceled'] })
  expect(selected.records.find((record: any) => record.card.source.id === `jira:${new URL(config.url).hostname}:${config.projectId}:${canceled.id}`)?.card.source).toMatchObject({
    archived: true, in_trash: false, properties: { Status: { value: 'Canceled' } },
  })
  f.search.pageSize = 1
  f.search.failFrom = 1
  const partial = await call('search_work', args)
  expect(partial.total).toBe(3)
  expect(partial.coverage.intentions).toMatchObject({ status: 'partial', coverage: 'partial', sources: [
    { source: 'notion', coverage: 'complete' }, { source: 'jira', coverage: 'partial' },
  ] })
  f.search.failFrom = 0
  const { call: callCold } = await f.connect('Clawson')
  const unavailable = await callCold('search_work', args)
  expect(unavailable.total).toBe(1)
  expect(unavailable.coverage.intentions).toMatchObject({ status: 'partial', coverage: 'partial', sources: [
    { source: 'notion', coverage: 'complete' }, { source: 'jira', status: 'unknown', coverage: 'unknown' },
  ] })
})

it('shows native Jira owner requests on Desk and leaves ordinary Clawson pickup to search', async () => {
  const f = await fixture('10639', true)
  const { call, sources } = await f.connect('Clawson')
  const owner = new IncomingMessage(new Socket())
  owner.headers['tailscale-user-login'] = 'owner@example.test'
  sources.authorizePulls = async request => request === owner
  const issue = f.make('60101', 'TSW-101', '10639', { status: { name: 'In Progress' }, duedate: '2026-01-04',
    [config.fields.owner]: { value: 'Clawson' }, assignee: f.assignees[0] })
  const queued = f.make('60102', 'TSW-102', '10639', { status: { name: 'Queued' }, [config.fields.owner]: { value: 'Clawson' } })
  const waiting = f.make('60103', 'TSW-103', '10639', { status: { name: 'Waiting For' }, [config.fields.owner]: { value: 'Clawson' },
    [config.fields.blockerType]: { value: 'Actor' }, [config.fields.blockerTarget]: 'Will', [config.fields.blockerCondition]: 'Approve the proposed change' })
  const review = f.make('60104', 'TSW-104', '10639', { status: { name: 'Ready for Review' }, [config.fields.owner]: { value: 'Clawson' },
    assignee: { displayName: 'Will', accountId: 'other-account' } })
  for (const card of [issue, queued, waiting, review]) f.issues.set(card.id, card)
  f.search.directoryUnavailable = true
  const pickup = await call('search_work', { owner: 'Clawson', statuses: ['Queued', 'In Progress'] })
  expect(pickup.records.map((record: any) => record.card.source.url)).toEqual([f.notionCard.url, `${config.url}/browse/${issue.key}`, `${config.url}/browse/${queued.key}`])
  expect(buildQueue(await sources.snapshot(false, {}, false, true)).reviews.items).toEqual([])
  expect(pickup.coverage.intentions).toMatchObject({ status: 'fresh', coverage: 'complete' })
  expect((await call('search_work', { refresh: true })).total).toBe(5)
  expect(f.requests.some(request => request.path === 'user/assignable/search')).toBe(false)
  const unavailableReviewer = await sources.queue(owner, undefined, true, 'read')
  expect(unavailableReviewer.needsWill?.flatMap(item => item.evidence.map(link => link.url))).toEqual([`${config.url}/browse/${waiting.key}`])
  f.search.directoryUnavailable = false
  const authorized = await sources.queue(owner, undefined, false, 'read')
  const ownerUrls = [issue, waiting].map(card => `${config.url}/browse/${card.key}`).sort()
  const urls = (items: typeof authorized.items) => items.flatMap(item => item.evidence.map(link => link.url)).sort()
  expect(urls(authorized.items)).toEqual(ownerUrls)
  expect(urls(authorized.needsWill!)).toEqual(ownerUrls)
  expect(authorized.reviews.items).toEqual([])
  expect(authorized.needsWill?.find(item => item.evidence.some(link => link.url.endsWith('/TSW-103')))).toMatchObject({
    action: 'Approve the proposed change', oneTouch: false,
  })
  issue.fields.assignee = { displayName: f.assignees[0]!.displayName, accountId: 'other-account' }
  const wrongAccount = await sources.queue(owner, undefined, true, 'read')
  expect(urls(wrongAccount.needsWill!)).toEqual([`${config.url}/browse/${waiting.key}`])
  delete issue.fields.assignee
  expect((await sources.queue(owner, undefined, true, 'read')).coverage.intentions.coverage).toBe('partial')
  issue.fields.assignee = f.assignees[0]
  await sources.queue(owner, undefined, true, 'read')
  const assigned = (queue: typeof authorized) => queue.needsWill?.find(item => item.evidence.some(link => link.url === `${config.url}/browse/${issue.key}`))
  expect(assigned(authorized)).toMatchObject({ title: 'Fixture', checkpoint: '2026-01-04', readiness: 'needs-readiness-verification', oneTouch: false,
    sources: [{ kind: 'jira', coverage: 'complete' }] })
  expect(authorized.coverage.intentions).toMatchObject({ status: 'fresh', coverage: 'complete', sources: [{ source: 'notion' }, { source: 'jira', coverage: 'complete' }] })
  f.search.directoryUnavailable = true
  const directoryReads = f.requests.filter(request => request.path === 'user/assignable/search').length
  expect(await call('update_work', { kind: 'jira_edit', operation_id: 'directory-outage-comment',
    card_id: 'jira:sample.atlassian.net:10639:60101', note: 'Pickup acknowledged.' })).toMatchObject({ outcome: 'saved' })
  expect(f.requests.filter(request => request.path === 'user/assignable/search')).toHaveLength(directoryReads)
  f.search.directoryUnavailable = false
  f.controls.rejectSearch = true
  const partial = await sources.queue(owner, undefined, false, 'read')
  expect(partial.coverage.intentions).toMatchObject({ status: 'partial', coverage: 'partial' })
  expect(partial.reviews).toMatchObject({ complete: true, warning: null })
  expect(assigned(partial)).toMatchObject({ readiness: 'needs-readiness-verification', sources: [{ status: 'stale' }] })
  f.controls.rejectSearch = false
  f.search.pageSize = 1
  f.search.failFrom = 1
  f.search.failureStatus = 403
  const denied = await sources.queue(owner, undefined, true, 'read')
  expect(denied.needsWill).toEqual([])
  expect((await sources.queueDisplay(owner)).needsWill).toEqual([])
  expect((await call('search_work', { owner: 'Clawson', statuses: ['Queued', 'In Progress'] })).total).toBe(1)
  const anonymous = await sources.queue(undefined, undefined, false, 'read')
  expect(anonymous.items).toEqual([])
  expect(anonymous.needsWill).toEqual([])
})

const mergeSelection = { operation_id: '39f71a89-d20e-4846-bd37-590d69f25348', targets: Array.from({ length: 10 }, (_, i) => ({
  url: `https://github.com/example/fixture-project-with-a-long-name-${i}/pull/${i + 1}`, head: 'a'.repeat(40),
})) }
const mergeActor = 'owner@example.test'
function mergePlan() {
  const head = mergeSelection.targets[0]!.head
  const read = async (path: string) => {
    if (/\/pulls\/\d+$/.test(path)) return { head: { sha: head }, base: { ref: 'main' }, state: 'open', merged: false, draft: false, mergeable: true }
    if (path.includes('/rules/')) return []
    if (path.includes('/branches/')) return { protection: { required_status_checks: { contexts: ['CI'] } } }
    if (path.includes('/check-runs')) return { total_count: 1, check_runs: [{ name: 'CI', head_sha: head, status: 'completed', conclusion: 'success', app: { id: 1 } }] }
    if (path.includes('/status?')) return { total_count: 0, sha: head, statuses: [] }
    throw new Error('Unexpected fixture request')
  }
  return prepareClawsonMerge(mergeSelection, mergeActor, read, () => Date.parse('2026-01-05T02:00:00Z'))
}

it('queues one Jira admin-merge handoff and lets Clawson pick up, comment and return it by card ID', async () => {
  const f = await fixture()
  const { call, sources } = await f.connect('Clawson')
  const prepare = vi.fn(mergePlan)
  const submit = () => sources.workflow.createClawsonMerge(mergeSelection, mergeActor, prepare)
  const [first, second] = await Promise.all([submit(), submit()])
  expect(first).toMatchObject({ outcome: 'saved', operation_id: mergeSelection.operation_id, card: { owner: 'Clawson', status: 'Queued', name: 'Admin merge 10 PRs across 10 repositories', due_date: '2026-01-04' } })
  expect(second).toEqual(first)
  const card = first.card as { id: string; description: string }
  const plan = await mergePlan()
  expect(card.description).toContain(plan.brief)
  expect(card.description).toContain(plan.script)
  expect(card.description).toContain('Post one comment per PR')
  const lookup = { owner: 'Clawson', statuses: ['Queued', 'In Progress'], limit: 100 }
  f.controls.staleSearch = true
  const pickedUp = await call('search_work', lookup)
  f.controls.staleSearch = false
  expect(pickedUp).toMatchObject({ total: 1, coverage: { intentions: { status: 'fresh', coverage: 'complete' } }, records: [{ card: { source: { id: card.id } } }] })
  expect(await call('get_work', { card_id: card.id })).toMatchObject({ outcome: 'available', card: { description: card.description }, comments: [] })
  const work = { card_id: card.id }
  const queuedIssue = f.issues.get('60001')!
  queuedIssue.fields[config.fields.owner] = { value: 'Firstmate' }
  expect(await call('search_work', { ...lookup, refresh: true })).toMatchObject({ total: 0, coverage: { intentions: { coverage: 'complete' } } })
  queuedIssue.fields[config.fields.owner] = { value: 'Clawson' }
  expect(await call('transition_work', { ...work, operation_id: 'begin-fixture', verb: 'Start', evidence: 'Pickup acknowledged.' })).toMatchObject({ outcome: 'saved', card: { status: 'In Progress' } })
  expect(await call('update_work', { ...work, operation_id: 'report-fixture', kind: 'jira_edit', note: 'Fixture report for the requester.' })).toMatchObject({ outcome: 'saved' })
  const issue = [...f.issues.values()].find(issue => card.id.endsWith(`:${issue.id}`))!
  f.search.indexed.set(issue.id, { ...issue.fields })
  expect(await call('update_work', { ...work, operation_id: 'return-fixture', kind: 'jira_edit', owner: 'Firstmate' })).toMatchObject({ outcome: 'saved', card: { owner: 'Firstmate' } })
  expect(await call('search_work', { ...lookup, refresh: true })).toMatchObject({ total: 0 })
  expect(await call('get_work', work)).toMatchObject({ outcome: 'available', card: { owner: 'Firstmate', status: 'In Progress' }, comments: expect.arrayContaining([
    expect.objectContaining({ body: 'Fixture report for the requester.\n\nRecorded via Tin Star (Clawson)' }),
  ]) })
  expect(await call('update_work', { ...work, operation_id: 'requester-fixture', kind: 'jira_edit', owner: 'Taylor' })).toMatchObject({ outcome: 'saved', card: { owner: 'Taylor' } })
  const { sources: restarted } = await f.connect()
  expect(await restarted.workflow.createClawsonMerge(mergeSelection, mergeActor, prepare)).toMatchObject({ outcome: 'saved', code: 'already-saved', card: { id: card.id } })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue')).toHaveLength(1)
})

it('rechecks an undispatched merge handoff and rejects changed fields before Fast-track', async () => {
  const f = await fixture()
  const { sources } = await f.connect()
  vi.spyOn(sources.jiraWork!, 'create').mockRejectedValueOnce(new Error('Interrupted before dispatch'))
  const prepare = vi.fn(mergePlan)
  expect(await sources.workflow.createClawsonMerge(mergeSelection, mergeActor, prepare)).toMatchObject({ outcome: 'partially-saved' })
  prepare.mockRejectedValueOnce(new Error('Head changed'))
  expect(await sources.workflow.createClawsonMerge(mergeSelection, mergeActor, prepare)).toMatchObject({ outcome: 'not-saved', message: 'Head changed' })
  expect(f.requests.some(request => request.method === 'POST' && request.path === 'issue')).toBe(false)
  f.controls.beforeWrite = 'change-handoff-owner'
  expect(await sources.workflow.createClawsonMerge(mergeSelection, mergeActor, prepare)).toMatchObject({ outcome: 'partially-saved', code: 'queue-unconfirmed' })
  expect(f.requests.some(request => request.method === 'POST' && request.path.endsWith('/transitions'))).toBe(false)
  expect(f.issues.get('60001')?.fields.status.name).toBe('Backlog')
})

it('rejects a blocker added during the Fast-track offer read', async () => {
  const f = await fixture()
  const { sources } = await f.connect()
  f.controls.beforeWrite = 'change-handoff-blocker'
  expect(await sources.workflow.createClawsonMerge(mergeSelection, mergeActor, mergePlan)).toMatchObject({ outcome: 'partially-saved', code: 'queue-unconfirmed' })
  expect(f.requests.some(request => request.method === 'POST' && request.path.endsWith('/transitions'))).toBe(false)
})

it.each(['issue/60101', 'issue/60101/comment'])('purges cached pickup after a direct denial on %s', async path => {
  const f = await fixture()
  const { call } = await f.connect('Clawson')
  const issue = f.make('60101', 'WORK-101', config.projectId, { status: { name: 'Queued' }, [config.fields.owner]: { value: 'Clawson' } })
  f.issues.set(issue.id, issue)
  const lookup = { owner: 'Clawson', statuses: ['Queued'] }
  expect(await call('search_work', lookup)).toMatchObject({ total: 1 })
  f.search.deniedRead = path
  expect(await call('get_work', { card_id: 'jira:sample.atlassian.net:10001:60101' })).toMatchObject({ outcome: 'unavailable' })
  expect(await call('search_work', lookup)).toMatchObject({ total: 0 })
})

it.each(['creation', 'transition'])('recovers an admin-merge handoff after losing the Jira %s response', async phase => {
  const f = await fixture()
  f.issues.set('60101', f.make('60101', 'WORK-101', config.projectId))
  f.search.pageSize = 1
  const { sources } = await f.connect()
  const prepare = vi.fn(mergePlan)
  prepare.mockRejectedValueOnce(new Error('Head changed'))
  expect(await sources.workflow.createClawsonMerge(mergeSelection, mergeActor, prepare)).toMatchObject({ outcome: 'not-saved', code: 'merge-refused' })
  expect(f.requests).toEqual([])
  if (phase === 'creation') f.controls.loseCreate = true
  else f.controls.loseEdit = true
  const uncertain = await sources.workflow.createClawsonMerge(mergeSelection, mergeActor, prepare)
  expect(uncertain).toMatchObject({ outcome: 'partially-saved' })
  expect(uncertain.card).toBeUndefined()
  prepare.mockRejectedValue(new Error('Head no longer available'))
  const { sources: restarted } = await f.connect()
  expect(await restarted.workflow.createClawsonMerge({ ...mergeSelection, targets: [mergeSelection.targets[0]!] }, mergeActor, prepare)).toMatchObject({ code: 'operation-conflict' })
  expect(await restarted.workflow.createClawsonMerge(mergeSelection, mergeActor, prepare)).toMatchObject({ outcome: 'saved', card: { status: 'Queued', owner: 'Clawson' } })
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue')).toHaveLength(1)
  expect(f.requests.filter(request => request.method === 'POST' && request.path.endsWith('/transitions'))).toHaveLength(1)
})

it('publishes update_work schemas that accept Notion IDs for shared updates', async () => {
  const { client } = await (await fixture()).connect()
  const { tools } = await client.listTools()
  const ajv = addFormats(new Ajv({ strict: false }))
  const schema = tools.find(tool => tool.name === 'update_work')!.inputSchema
  const update = ajv.compile(schema)
  const rootId = schema.properties?.card_id
  expect(rootId).toBeDefined()
  const validateId = ajv.compile(rootId as object)
  const notion = 'a'.repeat(32)
  const jira = `jira:${new URL(config.url).hostname}:${config.projectId}:60001`
  expect(validateId(notion)).toBe(true)
  expect(validateId(jira)).toBe(true)
  expect(validateId('invalid-card-id')).toBe(false)
  const operation_id = 'schema-proof'
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
  const jiraEdit = { kind: 'jira_edit', operation_id, note: 'Fixture' }
  expect(update({ ...jiraEdit, card_id: jira })).toBe(true)
  expect(update({ ...jiraEdit, card_id: notion })).toBe(false)
})

it('assigns only an exact Jira display name', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const created = await call('create_work', { provider: 'jira', operation_id: 'create', name: 'Assignee fixture', owner: 'Avery' })
  const edit = (operation_id: string, assignee: string) => call('update_work',
    { kind: 'jira_edit', card_id: created.card.id, operation_id, assignee })
  const writes = () => f.requests.filter(request => request.method === 'PUT')
  expect(await edit('ambiguous', 'Robyn')).toMatchObject({ outcome: 'not-saved', code: 'invalid-work' })
  expect(await edit('missing', 'Nobody')).toMatchObject({ outcome: 'not-saved', code: 'invalid-work' })
  expect(await edit('prefix', 'Will')).toMatchObject({ outcome: 'not-saved', code: 'invalid-work' })
  expect(writes()).toHaveLength(0)
  const assigned = await edit('assign', 'William Gathright')
  expect(assigned).toMatchObject({ outcome: 'saved', card: { assignee: 'William Gathright', owner: 'Avery' } })
  expect(await edit('assign', 'William Gathright')).toMatchObject({ outcome: 'saved', code: 'already-saved' })
  const card_id = created.card.id
  const reads = await Promise.all([
    call('get_work', { card_id, details: true }),
    call('get_work', { card_id, details: false }),
  ])
  const moved = await call('transition_work', { card_id, operation_id: 'prioritize-assigned', verb: 'Prioritize' })
  const linked = await call('link_work', { card_id, operation_id: 'link-assigned', action: 'add', target_key: 'OTHER-1', type: 'Blocks', direction: 'inward' })
  expect(created.card).not.toHaveProperty('assignee_id')
  for (const result of [assigned, ...reads, moved, linked]) {
    expect(result.card).toMatchObject({ assignee: 'William Gathright' })
    expect(result.card).not.toHaveProperty('assignee_id')
  }
  expect(writes()).toHaveLength(1)
})

async function tswFixture() {
  const f = await fixture('10639')
  const home = '/fixture/fm-unrelated-basename'
  const file = join(f.root, 'snapshot.json')
  const sources = new ReconciliationSources({ warnings: [], fleet: [
    { home, label: 'fleet', snapshotFile: file }, { home: '/fixture/fm-offline', snapshotFile: join(f.root, 'missing.json') },
  ] })
  const { call } = await f.connect()
  const create = (type: string) => call('create_work', {
    provider: 'jira', operation_id: 'create-' + type, name: `Synthetic ${type}`, description: 'Complete this workflow test.',
  })
  const publish = async (tasks: unknown[], records: unknown[] = []) => {
    await writeFile(file, JSON.stringify({ schema: 'fm-fleet-snapshot.v1', fm_home: home, generated: new Date().toISOString(),
      main_inventory: { valid: true }, tasks, backlog: { present: true, records } }))
  }
  const run = async (apply: boolean, maxCards = 5) => runTswStatusSync(await sources.fleetSnapshot(true), {
    jira: f.jira(), stateFile: join(f.root, 'status-checkpoints.json'), apply, maxCards, audit: async () => {},
  })
  return { ...f, call, create, publish, run }
}

const fixturePull = 'https://github.com/fixture/project/pull/123'
const tswTask = (key: string, detail = '', yolo = 'off', overrides: Record<string, unknown> = {}) => ({
  id: 'task-' + key, kind: 'crewmate', spawn_gen: 'attempt-1', yolo, endpoint: { exists: true },
  current_state: { state: detail ? 'done' : 'working', detail, freshness: 'fresh' },
  backlog: { id: 'task-' + key, body_lines: [`card: ${key}`] },
  pr: { url: detail ? fixturePull : null }, ...overrides,
})

it('blocks both card keys in conflicting dispatch copies even with separate live candidates', async () => {
  const f = await tswFixture()
  await f.create('first')
  await f.create('second')
  const candidates = [tswTask('TSW-1'), tswTask('TSW-2')]
  const conflicting = tswTask('TSW-1', '', 'off', {
    id: 'conflict', backlog: { id: 'conflict', body_lines: ['card: TSW-1'] },
  })
  await f.publish([...candidates, conflicting], [{ id: 'conflict', body_lines: ['card: TSW-2'] }])
  const blocked = await f.run(true)
  expect(blocked.plans).toEqual([])
  expect(blocked.audits.filter(entry => entry.result === 'conflicting-card-declarations').map(entry => entry.cardId))
    .toEqual(['TSW-1', 'TSW-2'])
  expect(f.issues.get('60001')!.fields.status.name).toBe('Backlog')
  expect(f.issues.get('60002')!.fields.status.name).toBe('Backlog')
  await f.publish(candidates)
  expect(await f.run(true)).toMatchObject({ stopped: false })
  expect(f.issues.get('60001')!.fields.status.name).toBe('In Progress')
  expect(f.issues.get('60002')!.fields.status.name).toBe('In Progress')
})

it('walks TSW from Backlog through review and merge, preserves idempotence and skips another project', async () => {
  const f = await tswFixture()
  await f.create('delivery')
  await f.publish([tswTask('TSW-1'), tswTask('OTHER-1')])
  const dry = await f.run(false)
  expect(dry.plans).toMatchObject([{ event: { target: 'In Progress', actor: 'Firstmate fleet' }, from: 'Backlog',
    steps: [{ owner: 'Firstmate fleet' }, { verb: 'Fast-track' }, { verb: 'Start' }] }])
  expect(dry.audits).toContainEqual(expect.objectContaining({ home: '/fixture/fm-offline', result: 'snapshot-unknown-unknown' }))
  expect(f.issues.get('60001')!.fields.status.name).toBe('Backlog')
  expect(await f.run(true)).toMatchObject({ stopped: false })
  expect(await f.run(true)).toMatchObject({ plans: [] })
  const issue = f.issues.get('60001')!
  expect(issue.fields.status.name).toBe('In Progress')

  const green = 'checks green: PR ready for review'
  await f.publish([tswTask('TSW-1', 'Checks green: PR ready for review')])
  expect(await f.run(true)).toMatchObject({ plans: [] })
  expect(issue.fields.status.name).toBe('In Progress')
  await f.publish([tswTask('TSW-1', green, 'on')])
  expect(await f.run(true)).toMatchObject({ plans: [] })
  expect(issue.fields.assignee).toBeNull()
  await f.publish([tswTask('TSW-1', green)])
  // Lose an edit response after Jira has committed it. A new adapter instance
  // reconciles the saved operation and submits once, without adding a duplicate note.
  f.controls.loseEdit = true
  expect(await f.run(true)).toMatchObject({ stopped: true })
  expect(await f.run(true)).toMatchObject({ stopped: false })
  expect(issue.fields.status.name).toBe('Ready for Review')
  expect(issue.fields.assignee.displayName).toBe('William Gathright')
  const mergeNotes = issue.comments.map(comment => adfText(comment.body)).filter(note => note.startsWith('Will: merge'))
  expect(mergeNotes).toHaveLength(1)
  expect(mergeNotes[0]).toContain(`Will: merge ${fixturePull}`)
  expect(mergeNotes[0]).toContain('Recorded via Tin Star (Firstmate fleet)')

  f.appendHistory(issue.id, [{ fieldId: 'status', from: '9', to: '10', fromString: 'Ready for Review', toString: 'Ready for Review' }], 'workflow-admin')
  await f.publish([], [{ id: 'task-TSW-1', body_lines: ['card: TSW-1'], completion: { verb: 'merged', date: '2026-11-23' }, pr_url: fixturePull }])
  expect(await f.run(true)).toMatchObject({ stopped: false })
  expect(issue.fields.status.name).toBe('Done')
  expect(issue.comments.map(comment => adfText(comment.body))).toContainEqual(expect.stringContaining(`Accept Final via Tin Star (Firstmate fleet)\nEvidence: First Mate reported delivery for task-TSW-1. ${fixturePull}`))
  expect(await f.run(true)).toMatchObject({ plans: [] })
  expect(f.requests.some(request => request.path.includes('OTHER-1') || request.path.includes('70001'))).toBe(false)
})

it('blocks review without overwriting an owner assignee', async () => {
  const f = await tswFixture()
  await f.create('owner protection')
  await f.publish([tswTask('TSW-1')])
  await f.run(true)
  const issue = f.issues.get('60001')!
  issue.fields.assignee = { displayName: 'Project Owner', accountId: 'owner-account' }
  f.appendHistory(issue.id, [{ fieldId: 'assignee', from: null, to: 'owner-account' }])
  await f.publish([tswTask('TSW-1', 'checks green: PR held for merge')])
  expect(await f.run(true)).toMatchObject({ stopped: false, plans: [], audits: expect.arrayContaining([
    expect.objectContaining({ result: 'reviewer-blocked' }),
  ]) })
  expect(issue.fields.status.name).toBe('In Progress')
  expect(issue.fields.assignee.accountId).toBe('owner-account')
})

it('preserves the owner’s Reject Review until First Mate supplies a new event', async () => {
  const f = await tswFixture()
  await f.create('Reject Review')
  const detail = 'checks green: PR ready for review'
  await f.publish([tswTask('TSW-1', detail)])
  await f.run(true)
  const issue = f.issues.get('60001')!
  expect(issue.fields.status.name).toBe('Ready for Review')
  f.appendHistory(issue.id, [{ fieldId: 'status', fromString: 'Ready for Review', toString: 'Queued' }], 'owner-account')
  issue.fields.status = { name: 'Queued' }
  for (const apply of [false, true, true]) {
    expect(await f.run(apply)).toMatchObject({ plans: [], stopped: false })
    expect(issue.fields.status.name).toBe('Queued')
  }
  await f.publish([tswTask('TSW-1', detail, 'off', { pr: { url: 'https://github.com/fixture/project/pull/124' } })])
  expect(await f.run(true)).toMatchObject({ stopped: false })
  expect(issue.fields.status.name).toBe('Ready for Review')
})

it('preserves Reject Review made via the shared Jira service account', async () => {
  const f = await tswFixture()
  await f.create('MCP Reject Review')
  await f.publish([tswTask('TSW-1', 'checks green: PR ready for review')])
  await f.run(true)
  const card = await f.jira().readTswCard('TSW-1')
  expect(card.status).toBe('Ready for Review')
  expect(await f.call('transition_work', {
    card_id: card.id, operation_id: 'owner-action', verb: 'Reject Review', to: 'Queued', reason: 'Try again',
  })).toMatchObject({ outcome: 'saved', card: { status: 'Queued' } })
  expect(await f.run(true)).toMatchObject({ plans: [], stopped: false })
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('Queued')
})

it('preserves the owner’s Park when the earlier worker event returns after review', async () => {
  const f = await tswFixture()
  await f.create('Park')
  await f.publish([tswTask('TSW-1')])
  await f.run(true)
  const issue = f.issues.get('60001')!
  expect(issue.fields.status.name).toBe('In Progress')
  await f.publish([tswTask('TSW-1', 'checks green: PR ready for review')])
  await f.run(true)
  expect(issue.fields.status.name).toBe('Ready for Review')
  f.appendHistory(issue.id, [{ fieldId: 'status', fromString: 'Ready for Review', toString: 'Backlog' }], 'owner-account')
  issue.fields.status = { name: 'Backlog' }
  await f.publish([tswTask('TSW-1')])
  expect(await f.run(true)).toMatchObject({ plans: [], stopped: false })
  expect(issue.fields.status.name).toBe('Backlog')
  await f.publish([tswTask('TSW-1', '', 'off', { spawn_gen: 'attempt-2' })])
  expect(await f.run(true)).toMatchObject({ stopped: false })
  expect(issue.fields.status.name).toBe('In Progress')
})

it('preserves an owner reopen when the completed worker disappears', async () => {
  const f = await tswFixture()
  await f.create('reopened completion')
  const completion = { id: 'backlog-delivery', body_lines: ['card: TSW-1'],
    completion: { verb: 'done', date: '2026-11-23' }, pr_url: fixturePull }
  await f.publish([tswTask('TSW-1', '', 'off', { backlog: { id: completion.id, body_lines: completion.body_lines } })], [completion])
  expect(await f.run(true)).toMatchObject({ stopped: false })
  const card = await f.jira().readTswCard('TSW-1')
  expect(card.status).toBe('Done')
  expect(await f.call('transition_work', {
    card_id: card.id, operation_id: 'owner-reopen', verb: 'Reopen', to: 'Queued', reason: 'More work is needed.',
  })).toMatchObject({ outcome: 'saved', card: { status: 'Queued' } })

  await f.publish([], [completion])
  expect(await f.run(true)).toMatchObject({ plans: [], stopped: false, audits: expect.arrayContaining([
    expect.objectContaining({ cardId: 'TSW-1', result: 'event-already-applied' }),
  ]) })
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('Queued')
})

it('replans a rejected Fast-track with a new operation ID on the next pass', async () => {
  const f = await tswFixture()
  await f.create('rejected Fast-track')
  await f.publish([tswTask('TSW-1')])
  f.controls.refuseTransition = true
  const first = await f.run(true)
  expect(first.stopped).toBe(true)
  const rejected = first.audits.find(entry => entry.result === 'write-rejected')!
  expect(rejected.operationId).toMatch(/-queued$/)
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('Backlog')

  f.controls.refuseTransition = false
  const second = await f.run(true)
  expect(second.stopped).toBe(false)
  expect(second.audits).toContainEqual(expect.objectContaining({
    result: 'verified', operationId: `${rejected.operationId}-attempt-2`,
  }))
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('In Progress')
})

it.each(['edit', 'transition'] as const)('retries an unapplied dispatched TSW %s once with a derived ID', async kind => {
  const f = await tswFixture()
  await f.create('dispatch gap')
  await f.publish([tswTask('TSW-1')])
  const [method, path] = kind === 'edit' ? ['PUT', 'issue/60001'] : ['POST', 'issue/60001/transitions']
  f.controls.beforeWrite = `${method} ${path}`
  const first = await f.run(true)
  expect(first.stopped).toBe(true)
  const original = first.audits.find(entry => entry.result === 'partially-saved')!.operationId
  const retry = await f.run(true)
  expect(retry.stopped).toBe(false)
  expect(retry.audits).toContainEqual(expect.objectContaining({ result: 'dispatch-retry', operationId: `${original}-retry-1` }))
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('In Progress')
  const writes = () => f.requests.filter(request => request.method === method && request.path === path).length
  expect(writes()).toBe(kind === 'edit' ? 2 : 3)
  await f.run(true)
  expect(writes()).toBe(kind === 'edit' ? 2 : 3)
})

it.each(['review note', 'transition'] as const)('resumes the persisted TSW retry for a %s after losing confirmation', async kind => {
  const f = await tswFixture()
  await f.create('retry confirmation')
  await f.publish([tswTask('TSW-1')])
  await f.run(true)
  const issue = f.issues.get('60001')!
  const isReview = kind === 'review note'
  if (isReview) {
    issue.fields.assignee = f.assignees[0]
    await f.publish([tswTask('TSW-1', 'checks green: PR ready for review')])
  } else {
    await f.publish([], [{ id: 'landed', body_lines: ['card: TSW-1'], completion: { verb: 'done' }, pr_url: fixturePull }])
  }
  const [method, path] = isReview ? ['PUT', 'issue/60001'] : ['POST', 'issue/60001/transitions']
  f.controls.beforeWrite = `${method} ${path}`
  const first = await f.run(true)
  const original = first.audits.find(entry => entry.result === 'partially-saved')!.operationId
  if (isReview) f.controls.loseEdit = true
  else f.controls.commentResponse = 'wrong-id'
  const retry = await f.run(true)
  const operationId = `${original}-retry-1`
  expect(retry).toMatchObject({ stopped: isReview, audits: expect.arrayContaining([
    expect.objectContaining({ result: 'dispatch-retry', operationId }),
  ]) })
  issue.comments.unshift(...Array.from({ length: 51 }, (_, index) => ({ id: `newer-${index}`, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Newer comment' }] }] } })))
  const writeCount = f.requests.filter(request => request.path === path && request.method === method ||
    request.path === 'issue/60001/comment' && request.method === 'POST').length
  f.controls.commentResponse = undefined
  expect(await f.run(true)).toMatchObject({ stopped: false, audits: expect.arrayContaining([
    expect.objectContaining({ result: isReview ? 'verified' : 'note-repaired', operationId }),
  ]) })
  expect(f.requests.filter(request => request.path === path && request.method === method ||
    request.path === 'issue/60001/comment' && request.method === 'POST'))
    .toHaveLength(writeCount + Number(isReview))
  expect(issue.fields.status.name).toBe(isReview ? 'Ready for Review' : 'Done')
  expect(issue.comments.filter(comment => adfText(comment.body).includes(`Operation: ${operationId}`))).toHaveLength(1)
})

it('retries the review edit if Jira applied the assignee but omitted the merge note', async () => {
  const f = await tswFixture()
  await f.create('partial review')
  await f.publish([tswTask('TSW-1')])
  await f.run(true)
  await f.publish([tswTask('TSW-1', 'checks green: PR ready for review')])
  f.controls.omitComment = true
  expect(await f.run(true)).toMatchObject({ stopped: true })
  expect(await f.jira().readTswCard('TSW-1')).toMatchObject({ status: 'In Progress', assignee: 'William Gathright' })
  f.controls.omitComment = false
  expect(await f.run(true)).toMatchObject({ stopped: false, audits: expect.arrayContaining([
    expect.objectContaining({ result: 'dispatch-retry', operationId: expect.stringMatching(/-edit-review-retry-1$/) }),
  ]) })
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('Ready for Review')
})

it.each(['Fast-track', 'Complete Directly'] as const)('recovers evidence for a landed %s without repeating the transition', async verb => {
  const f = await tswFixture()
  await f.create('recover transition note')
  await f.publish([tswTask('TSW-1')])
  if (verb === 'Complete Directly') {
    await f.run(true)
    await f.publish([], [{ id: 'landed', body_lines: ['card: TSW-1'], completion: { verb: 'done' }, pr_url: fixturePull }])
  }
  f.controls.commentResponse = 'rejected'
  const first = await f.run(true)
  expect(first.stopped).toBe(false)
  const operationId = first.audits.find(entry => entry.result === 'landed-note-pending')!.operationId
  expect((await f.jira().readTswCard('TSW-1')).status).toBe(verb === 'Fast-track' ? 'In Progress' : 'Done')
  f.controls.commentResponse = undefined
  if (verb === 'Complete Directly') await f.publish([])
  const resumed = await f.run(true)
  expect(resumed).toMatchObject({ stopped: false, audits: expect.arrayContaining([
    expect.objectContaining({ result: 'note-repaired', operationId }),
  ]) })
  const issue = f.issues.get('60001')!
  expect(issue.fields.status.name).toBe(verb === 'Fast-track' ? 'In Progress' : 'Done')
  expect(f.requests.filter(request => request.method === 'POST' && request.path === 'issue/60001/transitions')).toHaveLength(verb === 'Fast-track' ? 2 : 3)
  const notes = issue.comments.map(comment => adfText(comment.body))
  expect(notes.filter(note => note.includes(`Operation: ${operationId}`))).toHaveLength(1)
  if (verb === 'Complete Directly') expect(notes.some(note => note.includes(fixturePull))).toBe(true)
})

it('skips a deferred Fast-track note after the owner cancels the card', async () => {
  const f = await tswFixture()
  await f.create('canceled after Fast-track')
  await f.publish([tswTask('TSW-1')])
  f.controls.commentResponse = 'rejected'
  const first = await f.run(true)
  const operationId = first.audits.find(entry => entry.result === 'landed-note-pending' && entry.operationId?.endsWith('-queued'))!.operationId
  const issue = f.issues.get('60001')!
  expect(issue.fields.status.name).toBe('In Progress')
  f.appendHistory(issue.id, [{ fieldId: 'status', fromString: issue.fields.status.name, toString: 'Canceled' }], 'workflow-admin')
  issue.fields.status = { name: 'Canceled' }
  f.controls.commentResponse = undefined
  const writesBefore = f.requests.filter(request => request.method !== 'GET').length

  const resumed = await f.run(true)
  expect(resumed.audits).toContainEqual(expect.objectContaining({
    result: 'note-repair-abandoned', detail: 'card-canceled', operationId,
  }))
  expect(issue.fields.status.name).toBe('Canceled')
  expect(f.requests.filter(request => request.method !== 'GET')).toHaveLength(writesBefore)
})

it('repairs the oldest note first without consuming the forward-write allowance', async () => {
  const f = await tswFixture()
  await f.create('forward')
  await f.create('newer repair')
  await f.create('older repair')
  await f.publish([tswTask('TSW-2'), tswTask('TSW-3')])
  await f.run(true)
  const complete = (key: string) => f.publish([], [{ id: `landed-${key}`, body_lines: [`card: ${key}`], completion: { verb: 'done' }, pr_url: fixturePull }])
  f.controls.commentResponse = 'rejected'
  await complete('TSW-3')
  await f.run(true, 1)
  await complete('TSW-2')
  await f.run(true, 1)
  f.controls.commentResponse = undefined
  await f.publish([tswTask('TSW-1')])
  const first = await f.run(true, 1)
  expect(first.audits.filter(entry => entry.result === 'note-repaired').map(entry => entry.cardId)).toEqual(['TSW-3'])
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('In Progress')
  const second = await f.run(true, 1)
  expect(second.audits.filter(entry => entry.result === 'note-repaired').map(entry => entry.cardId)).toEqual(['TSW-2'])
})

it('completes a linked PR from the CI monitor merge detail after worker exit', async () => {
  const f = await tswFixture()
  await f.create('CI monitor merge')
  await f.publish([tswTask('TSW-1', 'checks green: PR merged (ci monitor ended)', 'on', {
    endpoint: { exists: false, agent_alive: 'dead' },
    hints: { last_event_text: 'done [at=1]: checks green' },
  })])
  expect(await f.run(true)).toMatchObject({ stopped: false })
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('Done')
  expect(f.issues.get('60001')!.comments.map(comment => adfText(comment.body))).toContainEqual(
    expect.stringContaining(`Complete Directly via Tin Star (Firstmate fleet)\nEvidence: First Mate reported delivery for task-TSW-1. ${fixturePull}`),
  )
})

it.each(['issue/60001', 'issue/60001/comment'])('preserves a repair through repeated pre-write failures on %s', async path => {
  const f = await tswFixture()
  await f.create('transient repair read failure')
  await f.publish([tswTask('TSW-1')])
  await f.run(true)
  await f.publish([], [{ id: 'landed', body_lines: ['card: TSW-1'], completion: { verb: 'done' }, pr_url: fixturePull }])
  f.controls.commentResponse = 'rejected'
  const initial = await f.run(true)
  const operationId = initial.audits.find(entry => entry.result === 'landed-note-pending')!.operationId
  await f.publish([])
  f.controls.commentResponse = undefined
  const writes = () => f.requests.filter(request => request.path === 'issue/60001/comment' && request.method === 'POST').length
  const previousWrites = writes()
  for (let pass = 0; pass < 3; pass++) {
    f.controls.beforeWrite = `GET ${path}`
    expect((await f.run(true)).audits).toContainEqual(expect.objectContaining({ result: 'note-repair-pending', operationId }))
    expect(writes()).toBe(previousWrites)
  }
  expect((await f.run(true)).audits).toContainEqual(expect.objectContaining({ result: 'note-repaired', operationId }))
  expect(writes()).toBe(previousWrites + 1)
})

it.each(['rejected', 'unavailable'] as const)('bounds repair POSTs when the comment service is %s', async commentResponse => {
  const f = await tswFixture()
  await f.create('abandon unavailable note')
  await f.publish([tswTask('TSW-1')])
  f.controls.commentResponse = commentResponse
  await f.run(true)
  const issue = f.issues.get('60001')!
  expect(issue.fields.status.name).toBe('In Progress')
  const posts = () => f.requests.filter(request => request.method === 'POST' && request.path === 'issue/60001/comment').length
  for (let pass = 1; pass <= 3; pass++) {
    const run = await f.run(true)
    expect(run.stopped).toBe(false)
    expect(posts()).toBe(2 + pass * 2)
    expect(run.audits.filter(entry => entry.result === (pass === 3 ? 'note-repair-abandoned' : 'note-repair-pending'))).toHaveLength(2)
  }
  await f.run(true)
  expect(posts()).toBe(8)
})

it('uses a ready owner-merge PR to pass through Start after its worker exits', async () => {
  const f = await tswFixture()
  await f.create('ready PR')
  await f.publish([tswTask('TSW-1', 'checks green: PR ready for review', 'off', { endpoint: { exists: false, agent_alive: 'dead' } })])
  expect(await f.run(true)).toMatchObject({ stopped: false, plans: [{
    steps: [{ kind: 'jira_edit' }, { verb: 'Fast-track' }, { verb: 'Start' }, { kind: 'jira_edit' }, { verb: 'Submit for Review' }],
  }] })
  expect(await f.jira().readTswCard('TSW-1')).toMatchObject({ status: 'Ready for Review', assignee: 'William Gathright', assignee_id: 'will-account' })
})

it.each(['dead', 'unknown'] as const)('leaves a retained endpoint in Backlog with %s activity evidence', async activity => {
  const f = await tswFixture()
  await f.create('retained endpoint')
  await f.publish([tswTask('TSW-1', '', 'off', {
    endpoint: { exists: true, agent_alive: activity },
    current_state: { state: activity === 'dead' ? 'working' : 'unknown', freshness: 'fresh' },
    backlog: { id: 'task-TSW-1', state: 'in_flight', body_lines: ['card: TSW-1'] },
  })])
  expect(await f.run(true)).toMatchObject({ plans: [] })
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('Backlog')
})

it('blocks review when only a similarly named user is assignable', async () => {
  const f = await tswFixture()
  f.assignees[0]!.displayName = 'William Gathright Jr'
  await f.create('review')
  await f.publish([tswTask('TSW-1', 'checks green: PR ready for review')])
  expect(await f.run(true)).toMatchObject({ stopped: false, plans: [], audits: expect.arrayContaining([
    expect.objectContaining({ result: 'reviewer-blocked', cardId: 'TSW-1' }),
  ]) })
  expect(await f.jira().readTswCard('TSW-1')).toMatchObject({ status: 'Backlog', assignee: null })
})

it('starts a mate-merged green PR only with live worker evidence', async () => {
  const f = await tswFixture()
  await f.create('mate merge')
  const publish = (agent_alive: string) => f.publish([tswTask('TSW-1', 'checks green: PR ready for review', 'on', {
    endpoint: { exists: true, agent_alive },
    current_state: { state: 'working', detail: 'checks green: PR ready for review', freshness: 'fresh' },
  })])
  await publish('dead')
  expect(await f.run(true)).toMatchObject({ plans: [] })
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('Backlog')
  await publish('alive')
  expect(await f.run(true)).toMatchObject({ stopped: false })
  expect(await f.jira().readTswCard('TSW-1')).toMatchObject({ status: 'In Progress', assignee: null })
})

it('starts a completed Backlog issue before completing it with its published pull request', async () => {
  const f = await tswFixture()
  await f.create('direct')
  const completion = { id: 'landed', body_lines: ['card: TSW-1'], completion: { verb: 'done', date: '2026-11-23' } }
  await f.publish([], [completion])
  expect(await f.run(true)).toMatchObject({ plans: [], audits: expect.arrayContaining([
    expect.objectContaining({ result: 'completion-without-pull-evidence' }),
  ]) })
  await f.publish([], [{ ...completion, pr_url: fixturePull }])
  expect(await f.run(true)).toMatchObject({ stopped: false, plans: [{
    from: 'Backlog', steps: [{ kind: 'jira_edit' }, { verb: 'Fast-track' }, { verb: 'Start' }, { verb: 'Complete Directly' }],
  }] })
  expect((await f.jira().readTswCard('TSW-1')).status).toBe('Done')
})

it('creates Jira work by default through the advertised MCP tool', async () => {
  const f = await fixture()
  const { client, call } = await f.connect()
  const creation = (await client.listTools()).tools.find(tool => tool.name === 'create_work')!
  expect(creation.description).toContain('Jira TSW')
  expect(creation.description).not.toContain('Notion')
  expect(await call('create_work', { operation_id: 'default-provider', name: 'Review fixture coverage' }))
    .toMatchObject({ outcome: 'saved', card: { status: 'Backlog', name: 'Review fixture coverage' } })
  expect(f.requests.filter(({ method, path }) => method === 'POST' && path === 'issue')).toHaveLength(1)
})

it.each([false, true])('records and queues a verified Jira handoff after create (lost reply: %s)', async loseCreate => {
  const f = await fixture()
  f.controls.loseCreate = loseCreate
  const first = await f.connect()
  const input = {
    submission_id: 'approval', target: { external_ref: 'fixture:approval' }, title: 'Verify handoff', area: 'Engineering', owner: 'Avery',
    objective: 'Verify native handoff', spec_markdown: '## Exact approved text\n\n| Words | Spacing |\n| A |   B |\n🧪'.repeat(200),
    acceptance_criteria: ['Read back every chunk'], decisions: [], forbidden_approaches: [], references: [],
  }
  const handoff = (await first.client.listTools()).tools.find(tool => tool.name === 'submit_handoff')!
  expect(handoff.description).toContain('create a Jira TSW ticket')
  expect(handoff.description).not.toContain('Notion')
  const validate = addFormats(new Ajv({ strict: false })).compile(handoff.inputSchema)
  expect(validate(input)).toBe(true)
  const nativeCandidate = { ...input, target: { ...input.target, candidate_ids: ['jira:sample.atlassian.net:10001:60001'] } }
  expect(validate(nativeCandidate)).toBe(false)
  expect(await first.client.callTool({ name: 'submit_handoff', arguments: nativeCandidate })).toMatchObject({ isError: true })
  const nativeId = nativeCandidate.target.candidate_ids[0]
  const existingTarget = { ...input, target: { card_id: nativeId } }
  expect(validate(existingTarget)).toBe(true)
  const nativeParent = { ...input, target: { card_id: 'a'.repeat(32) }, parent_card_id: nativeId }
  expect(validate(nativeParent)).toBe(false)
  expect(await first.client.callTool({ name: 'submit_handoff', arguments: nativeParent })).toMatchObject({ isError: true })
  for (const provider of ['jira', 'notion']) {
    const argumentsWithProvider = { ...input, target: { ...input.target, provider } }
    expect(validate(argumentsWithProvider)).toBe(false)
    const badTarget = await first.client.callTool({ name: 'submit_handoff', arguments: argumentsWithProvider })
    expect(badTarget).toMatchObject({ isError: true })
  }
  expect(f.requests.filter(({ method, path }) => method === 'POST' && path === 'issue')).toHaveLength(0)
  const firstAttempt = await first.call('submit_handoff', input)
  if (loseCreate) expect(firstAttempt).toMatchObject({ outcome: 'partially-saved' })
  else {
    expect(firstAttempt).toMatchObject({ outcome: 'saved', record: { state: 'created' } })
    expect(f.requests.filter(({ path }) => path.startsWith('attachment/content/'))).toHaveLength(
      f.requests.filter(({ method, path }) => method === 'POST' && path.endsWith('/attachments')).length)
  }
  const { call } = await f.connect()
  const result = await call('submit_handoff', input)
  expect(result).toMatchObject({ outcome: 'saved', record: { full_spec_readback: 'verified' }, assignment: { status: 'Queued', owner: 'Avery' } })
  const read = await call('get_work', { card_id: result.record.card_id, implementation_contract: { limit: 20 } })
  expect(read.card.description).toBe('Read the verified implementation contract through Tin Star before starting work.')
  expect(read.implementation_contract).toMatchObject({ verified: true, manifest: { hash: result.record.spec_hash } })
  const exact = read.implementation_contract.chunks.map((chunk: { text: string }) => chunk.text).join('')
  expect(exact).toContain(`# Objective\n${input.objective}`)
  expect(exact).toContain(input.spec_markdown)
  expect(exact).toContain(input.area)
  expect(f.requests.filter(({ method, path }) => method === 'POST' && path === 'issue')).toHaveLength(1)
  const completion = f.requests.map(({ method, path }) => method === 'POST' && path.endsWith('/attachments')).lastIndexOf(true)
  const queue = f.requests.findIndex(({ method, path }) => method === 'POST' && path.endsWith('/transitions'))
  expect(completion).toBeGreaterThan(0)
  expect(queue).toBeGreaterThan(completion)
})

it('keeps the external reference claimed after a contradictory Jira creation readback', async () => {
  const f = await fixture()
  f.controls.wrongCreate = true
  const first = await f.connect()
  const input = {
    submission_id: 'approval', target: { external_ref: 'fixture:approval' }, title: 'Verify handoff', area: 'Engineering', owner: 'Avery',
    objective: 'Verify native handoff', spec_markdown: 'Approved spec',
    acceptance_criteria: ['Read back the contract'], decisions: [], forbidden_approaches: [], references: [],
  }
  expect(await first.call('submit_handoff', input)).toMatchObject({ outcome: 'partially-saved' })
  f.controls.wrongCreate = false
  const second = await f.connect('Other agent')
  expect(await second.call('submit_handoff', input)).toMatchObject({ recovery: { code: 'create-unconfirmed' } })
  expect(f.requests.filter(({ method, path }) => method === 'POST' && path === 'issue')).toHaveLength(1)
})

it('keeps the handoff in Backlog when the completion marker disappears before verification', async () => {
  const f = await fixture()
  const { call } = await f.connect()
  const input = {
    submission_id: 'approval', target: { external_ref: 'fixture:approval' }, title: 'Verify handoff', area: 'Engineering', owner: 'Avery',
    objective: 'Verify native handoff', spec_markdown: 'Approved spec',
    acceptance_criteria: ['Read back the contract'], decisions: [], forbidden_approaches: [], references: [],
  }
  f.dropCompletionOnRead()
  expect(await call('submit_handoff', input)).toMatchObject({
    outcome: 'partially-saved', recovery: { code: 'contract-incomplete' },
    record: { full_spec_readback: 'incomplete' }, assignment: { status: 'Backlog' },
  })
  expect(f.requests.filter(({ method, path }) => method === 'POST' && path.endsWith('/transitions'))).toHaveLength(0)
  expect(await call('submit_handoff', input)).toMatchObject({
    outcome: 'saved', record: { full_spec_readback: 'verified' }, assignment: { status: 'Queued' },
  })
  expect(f.requests.filter(({ method, path }) => method === 'POST' && path === 'issue')).toHaveLength(1)
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
  expect(validate({ operation_id: 'schema', name: 'Consolidate fixtures' })).toBe(true)
  expect(validate({ provider: 'notion', operation_id: 'schema', name: 'Consolidate fixtures' })).toBe(false)
  const rejected = await client.callTool({ name: 'create_work', arguments: { provider: 'notion', operation_id: 'legacy', name: 'Consolidate fixtures' } })
  expect(rejected).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Jira is the only creation target') }] })
  const card_id = created.card.id
  const issue = f.issues.get('60001')!
  expect(issue.fields.assignee).toBeNull()
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
  for (const options of [{ lease_token: 'lease' }, { refresh: false }]) {
    expect(validate({ card_id, ...options })).toBe(false)
    const before = f.requests.length
    const result = await client.callTool({ name: 'get_work', arguments: { card_id, ...options } })
    expect(result.isError).toBe(true)
    expect(f.requests).toHaveLength(before)
  }
  expect(validate({ card_id: 'a'.repeat(32), refresh: true, implementation_contract: {} })).toBe(true)
  f.issues.get('60001')!.fields.project = { id: '10002' }
  const before = f.requests.length
  expect(await call('get_work', { card_id, implementation_contract: {} })).toMatchObject({ outcome: 'unavailable' })
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
    outcome: 'saved', code: 'already-saved', card: { status: 'In Progress' },
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

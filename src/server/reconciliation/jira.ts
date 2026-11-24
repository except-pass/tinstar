import { sourceWriteDispatched } from './cardLeases'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { JiraConfig } from './config'
import type { WorkCard, WorkData } from './workReader'
import type { WorkScope } from './notion'
import { scopeMatches } from './workReader'
import { CachedObservation, retainMissing } from './observation'
import { jiraCardPrefix, isJiraCard } from '../../shared/workIdentity'
import { FIRST_MATE_TASKS, readWorkerLinks } from './workerLinks'
import { record } from './values'

export const JIRA_SYNTHETIC_LABEL = 'tinstar-synthetic'
const fieldTypes: Record<string, string> = {
  Name: 'title', Status: 'status', Owner: 'select', Area: 'select', 'Last touched by': 'rich_text',
  'Will action': 'multi_select', 'Waiting For': 'rich_text', 'Waiting For Type': 'select', 'Waiting For ID': 'rich_text',
  'Delegated To': 'rich_text', 'Next check-in': 'date', 'Due Date': 'date', 'Start Date': 'date',
  Priority: 'select', 'Sub-area': 'select', Attention: 'select', Initiative: 'select', Epic: 'select',
  'Parent item': 'relation', 'Sub-item': 'relation', Link: 'url', 'Next action': 'rich_text', [FIRST_MATE_TASKS]: 'rich_text',
}
const nativeFields: Record<string, string> = { Name: 'summary', 'Due Date': 'duedate', 'Start Date': 'customfield_10015' }
export const jiraPropertyKey = (name: string) => `tinstar.workflow.${encodeURIComponent(name)}`
/** Jira Review 10078 is Tin Star Ready for Review. The id pin stops a same-named status from taking that transition. */
const readyForReviewStatusId = '10078'
const logicalStatus = (name: string, id?: unknown) => name === 'To Do' ? 'Todo' : name === 'In Review' ? 'In review' : name === 'Review' && String(id) === readyForReviewStatusId ? 'Ready for Review' : name
const nativeStatus = (name: string) => name === 'Todo' ? 'To Do' : name === 'In review' ? 'In Review' : name === 'Ready for Review' ? 'Review' : name
export class JiraWriteError extends Error {
  constructor(readonly status: number, readonly method: string, public partial = false) { super(`Jira HTTP ${status}`) }
}
export class JiraAttachmentPreflightError extends Error {}
export class JiraMappingError extends Error {}
export class JiraConflictError extends Error {}
export interface JiraSection { id: string; type: string; text: string }
export const jiraText = (text: string) => ({ type: 'doc', version: 1, content: text.split('\n').map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) })
/** Read plain ADF without treating ordinary prose as workflow evidence. Unknown
 * structures make the read fail rather than proving a receipt is absent. */
export function adfText(value: unknown, allowUnsupported: boolean | 'omit' = false): string {
  if (value == null) return ''
  const node = record(value), type = node.type
  if (type === 'text') return String(node.text ?? '')
  if (type === 'hardBreak') return '\n'
  if (type === 'mention') return allowUnsupported === 'omit' ? '' : String(record(node.attrs).text ?? record(node.attrs).id ?? '')
  if (type === 'emoji') return allowUnsupported === 'omit' ? '' : String(record(node.attrs).text ?? record(node.attrs).shortName ?? '')
  if (type === 'inlineCard') return allowUnsupported === 'omit' ? '' : String(record(node.attrs).url ?? '')
  if (!['doc', 'paragraph', 'heading', 'codeBlock', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'panel', 'table', 'tableRow', 'tableCell', 'tableHeader', 'rule'].includes(String(type))) {
    if (allowUnsupported) return allowUnsupported === 'omit' ? '' : '[Rich content in Jira]'
    throw new Error(`Unsupported Jira document node: ${String(type)}`)
  }
  if (node.content !== undefined && !Array.isArray(node.content)) throw new Error('Malformed Jira document')
  return (node.content as unknown[] | undefined ?? []).map(item => adfText(item, allowUnsupported)).join(['paragraph', 'heading', 'codeBlock'].includes(String(type)) ? '' : '\n')
}
const decodeProperty = (wire: unknown, type: string): unknown => {
  const p = record(wire)
  if (type === 'title' || type === 'rich_text') return (Array.isArray(p[type]) ? p[type] : []).map(v => record(record(v).text).content ?? record(v).plain_text ?? '').join('')
  if (type === 'select' || type === 'status') return p[type] === null ? null : record(p[type]).name
  if (type === 'multi_select' || type === 'relation') return (Array.isArray(p[type]) ? p[type] : []).map(v => record(v)[type === 'relation' ? 'id' : 'name'])
  if (type === 'date') return p.date ?? null
  return p[type] ?? null
}

const jiraFetch = (input: string, init?: RequestInit) => {
  init?.signal?.throwIfAborted()
  if (init?.method && init.method !== 'GET' && !input.endsWith('/search/jql')) sourceWriteDispatched()
  return fetch(input, init)
}

/** Jira's bounded REST transport is shared by the pilot and the native work project. */
export class JiraClient {
  constructor(private baseUrl: string, private authorization: string, protected fetcher: typeof jiraFetch = jiraFetch) {}
  protected async response(path: string, init: RequestInit = {}, fetcher = this.fetcher) {
    const deadline = AbortSignal.timeout(20_000)
    const response = await fetcher(`${this.baseUrl}/rest/api/3/${path}`, { ...init,
      redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline, headers: { Accept: 'application/json',
        // Node fetch sends Accept-Language: *. Jira then translates built-in status
        // names (To Do, In Progress, Decision, Canceled), and the named-transition
        // matcher misses transitions Jira is offering. Ask for the English names
        // this contract compares.
        'Accept-Language': 'en',
        'X-Force-Accept-Language': 'true',
        Authorization: this.authorization,
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
    if (!response.ok) { await response.body?.cancel(); throw new JiraWriteError(response.status, init.method ?? 'GET') }
    return response
  }
  protected async request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, fetcher = this.fetcher): Promise<Record<string, any>> {
    const response = await this.response(path, { method, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, fetcher)
    return response.status === 204 ? {} : this.json(response)
  }
  protected async contractSections(cardId: string, attachments: unknown, signal?: AbortSignal, fetcher = this.fetcher, cache?: Map<string, JiraSection[]>) {
    if (!Array.isArray(attachments)) throw new Error('Jira attachment inventory unavailable')
    const sections: JiraSection[] = []
    const contracts = attachments.filter(attachment => /^[1-9][0-9]*$/.test(attachment.id) &&
      /^tinstar-contract-[a-f0-9-]+\.json$/.test(attachment.filename))
      .sort((a, b) => Number(a.id) - Number(b.id))
    for (const attachment of contracts) {
      const cacheKey = `${cardId}:attachment:${attachment.id}`
      const cached = cache?.get(cacheKey)
      if (cached) { sections.push(...cached); continue }
      const batch: JiraSection[] = []
      const body = await this.json(await this.response(`attachment/content/${attachment.id}?redirect=false`, { signal }, fetcher))
      if (body.schema !== 'tinstar.contract-sections.v1' || !Array.isArray(body.sections)) throw new Error('Invalid Jira contract attachment')
      for (const [index, section] of body.sections.entries()) {
        if (typeof section.text !== 'string' || !['paragraph', 'heading_2', 'code'].includes(section.type)) throw new Error('Malformed Jira contract section')
        batch.push({ id: `${cacheKey}:${index}`, type: section.type, text: section.text })
      }
      cache?.set(cacheKey, batch)
      sections.push(...batch)
    }
    return sections
  }
  protected async uploadContract(issueId: string, sections: Array<{ type: string; text: string }>) {
    const form = new FormData()
    form.append('file', new Blob([JSON.stringify({ schema: 'tinstar.contract-sections.v1', sections })], { type: 'application/json' }), `tinstar-contract-${randomUUID()}.json`)
    sourceWriteDispatched()
    const response = await this.response(`issue/${issueId}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, body: form })
    await response.body?.cancel()
  }
  protected async json(response: Response): Promise<Record<string, any>> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Jira response missing')
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 4 * 1024 * 1024) throw new Error('Jira response too large')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
}

/** Bounded TSSPIKE reader/writer. It has no configuration mutation endpoints. */
export class JiraAdapter extends JiraClient {
  constructor(readonly config: JiraConfig, fetcher: typeof jiraFetch = jiraFetch,
    private backgroundFetcher = fetcher, private parallelFetcher = fetcher) {
    const [, pilotSite, pilotProjectId] = jiraCardPrefix.split(':')
    if (config.url !== `https://${pilotSite}` || config.projectId !== pilotProjectId) throw new Error('Jira pilot is restricted to TSSPIKE 10638')
    super(config.url, `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`, fetcher)
  }
  private issueId(id: string) {
    if (!isJiraCard(id)) throw new Error('Jira source identity mismatch')
    return id.slice(jiraCardPrefix.length)
  }
  private assertIssue(raw: Record<string, any>) {
    if (!/^[1-9][0-9]*$/.test(raw.id) || raw.fields?.project?.id !== '10638' || raw.fields.project.key !== 'TSSPIKE' || !raw.fields.labels?.includes(JIRA_SYNTHETIC_LABEL)) throw new Error('Issue is outside the authorized synthetic TSSPIKE scope')
  }
  async issue(id: string, signal?: AbortSignal, fetcher = this.fetcher) {
    const itemId = this.issueId(id)
    const raw = await this.request(`issue/${itemId}?fields=summary,status,project,issuetype,updated,labels,description,attachment,duedate,customfield_10015&properties=*all`, 'GET', undefined, signal, fetcher)
    this.assertIssue(raw)
    if (raw.id !== itemId) throw new Error('Jira issue identity changed')
    return raw
  }
  project() {
    return this.request('project/10638').then(project => {
      if (project.id !== '10638' || project.key !== 'TSSPIKE' || project.style !== 'next-gen') throw new Error('Unexpected Jira project scope')
      return project
    })
  }
  async statuses() {
    const response = await this.response('project/10638/statuses')
    const body = await this.json(response)
    if (!Array.isArray(body)) throw new Error('Jira project status inventory unavailable')
    const task = body.find((type: any) => type.id === '10582')
    if (!task || !Array.isArray(task.statuses)) throw new Error('TSSPIKE Task workflow unavailable')
    return task.statuses.map((status: any) => ({ id: String(status.id), name: logicalStatus(String(status.name), status.id) })) as Array<{ id: string; name: string }>
  }
  schema() { return { properties: Object.fromEntries(Object.entries(fieldTypes).map(([name, type]) => [name, { type }])) } }
  card(raw: Record<string, any>): WorkCard {
    this.assertIssue(raw)
    if (typeof raw.fields.updated !== 'string' || typeof raw.fields.status?.name !== 'string') throw new Error('Incomplete Jira card read')
    const properties: WorkCard['properties'] = {}
    for (const [name, type] of Object.entries(fieldTypes)) {
      const stored = raw.properties?.[jiraPropertyKey(name)]
      if (stored && (stored.type !== type || !Object.hasOwn(stored, 'value'))) throw new Error(`Invalid Jira metadata for ${name}`)
      let value: unknown = stored?.value ?? (['multi_select', 'relation'].includes(type) ? [] : type === 'rich_text' ? '' : null)
      if (name === 'Name') value = raw.fields.summary
      else if (name === 'Status') value = logicalStatus(raw.fields.status.name, raw.fields.status.id)
      else if (nativeFields[name]) value = raw.fields[nativeFields[name]!] ? { start: raw.fields[nativeFields[name]!], end: null, time_zone: null } : null
      properties[name] = { id: jiraPropertyKey(name), type, value, hasMore: false,
        ...(name === FIRST_MATE_TASKS ? { workerLinks: readWorkerLinks({ type: 'rich_text', rich_text: typeof value === 'string' ? (value.match(/[\s\S]{1,2000}/g) ?? []).map(plain_text => ({ plain_text })) : [] }) } : {}) }
    }
    return { id: jiraCardPrefix + raw.id, url: `${this.config.url}/browse/${raw.key}`, last_edited_time: raw.fields.updated,
      archived: false, in_trash: false, properties,
      source: { provider: 'jira', instanceId: this.config.url, collectionId: '10638', itemId: raw.id, displayKey: raw.key, synthetic: true } }
  }
  async read(id: string, signal?: AbortSignal, background = false) { return this.card(await this.issue(id, signal, background ? this.backgroundFetcher : this.fetcher)) }
  private payload(properties: Record<string, unknown>) {
    const fields: Record<string, unknown> = {}, metadata: Array<{ key: string; value: unknown }> = []
    let status: string | undefined
    for (const [name, wire] of Object.entries(properties)) {
      const type = fieldTypes[name]
      if (!type) throw new Error(`Unsupported Jira property: ${name}`)
      const value = decodeProperty(wire, type)
      if (name === 'Status') { status = String(value); continue }
      if (nativeFields[name]) {
        if (type === 'date') {
          const date = value === null ? null : record(value).start
          if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new JiraMappingError(`${name}: Jira's native date field requires YYYY-MM-DD; a timestamp cannot be silently truncated`)
          fields[nativeFields[name]!] = date
        } else fields[nativeFields[name]!] = value
      } else {
        if (['Parent item', 'Sub-item'].includes(name) && (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !isJiraCard(id)))) throw new Error('Jira relations require exact same-provider card identities')
        const entry = { key: jiraPropertyKey(name), value: { type, value } }
        if (Buffer.byteLength(JSON.stringify(entry.value), 'utf8') > 32768) throw new JiraMappingError(`${name} exceeds Jira's 32 KiB issue-property limit; nothing was truncated`)
        metadata.push(entry)
      }
    }
    return { fields, properties: metadata, status }
  }
  validateProperties(properties: Record<string, unknown>) { this.payload(properties) }
  async patch(id: string, properties: Record<string, unknown>) {
    // All input limits and available transitions are checked before any write.
    const payload = this.payload(properties), itemId = this.issueId(id)
    const before = await this.issue(id)
    const target = payload.status && nativeStatus(payload.status)
    const current = before.fields.status
    const alreadyThere = target === 'Review' ? current?.name === 'Review' && String(current?.id) === readyForReviewStatusId : current?.name === target
    const transition = target && !alreadyThere ? await this.transitionId(id, target) : undefined
    let mutated = false
    try {
      if (Object.keys(payload.fields).length || payload.properties.length) {
        await this.issue(id)
        await this.request(`issue/${itemId}`, 'PUT', { fields: payload.fields, properties: payload.properties })
        mutated = true
      }
      if (transition) {
        await this.issue(id)
        await this.request(`issue/${itemId}/transitions`, 'POST', { transition: { id: transition } })
        mutated = true
      }
      return await this.read(id)
    } catch (error) {
      if (error instanceof JiraWriteError) error.partial = mutated
      throw error
    }
  }
  private async transitionId(id: string, name: string) {
    const body = await this.request(`issue/${this.issueId(id)}/transitions`)
    if (!Array.isArray(body.transitions)) throw new Error('Incomplete Jira transitions')
    const candidates = body.transitions.filter((t: any) => t.to?.name === name && t.isAvailable !== false && (name !== 'Review' || String(t.to?.id) === readyForReviewStatusId))
    if (candidates.length !== 1) throw new JiraMappingError(`Jira status ${name} has no unique available native transition`)
    return String(candidates[0].id)
  }
  async create(properties: Record<string, unknown>, sections: Array<{ type: string; text: string }>, beforeWrite?: () => Promise<void>) {
    const payload = this.payload(properties)
    if (payload.status && !(await this.statuses()).some(status => status.name === payload.status)) throw new JiraMappingError(`TSSPIKE Task lacks native status ${payload.status}`)
    await this.project() // exact scope evidence immediately before issue creation
    await beforeWrite?.()
    const created = await this.request('issue', 'POST', { fields: { ...payload.fields, project: { id: '10638' }, issuetype: { id: '10582' },
      labels: [JIRA_SYNTHETIC_LABEL], description: { type: 'doc', version: 1, content: sections.map(section => this.sectionNode(section)) } }, properties: payload.properties })
    const id = jiraCardPrefix + created.id
    await this.issue(id)
    if (payload.status) await this.patch(id, { Status: { status: { name: payload.status } } })
    return this.read(id)
  }
  async list(background = false) {
    const fetcher = background ? this.backgroundFetcher : this.parallelFetcher
    const cards: WorkCard[] = []; let next: string | undefined
    const cursors = new Set<string>(), signal = AbortSignal.timeout(20_000)
    for (let page = 0; page < 20; page++) {
      // Enhanced search allows only five properties. Read exact issue metadata
      // separately so an omitted property never masquerades as an empty value.
      const body = await this.request('search/jql', 'POST', {
        jql: `project = 10638 AND labels = "${JIRA_SYNTHETIC_LABEL}" ORDER BY id`, maxResults: 100,
        fields: ['project', 'labels'], ...(next ? { nextPageToken: next } : {}),
      }, signal, fetcher)
      if (!Array.isArray(body.issues) || typeof body.isLast !== 'boolean') throw new Error('Incomplete Jira search')
      for (const raw of body.issues) {
        this.assertIssue(raw)
        cards.push(this.card(await this.issue(jiraCardPrefix + raw.id, signal, fetcher)))
      }
      if (body.isLast) return { cards, hasMore: false }
      if (typeof body.nextPageToken !== 'string' || cursors.has(body.nextPageToken)) throw new Error('Invalid Jira search cursor')
      next = body.nextPageToken; cursors.add(next)
    }
    return { cards, hasMore: true }
  }
  observation(scope: WorkScope) {
    return new CachedObservation<WorkData>(async background => {
      const { cards, hasMore } = await this.list(background)
      return { observedAt: new Date().toISOString(), coverage: hasMore ? 'partial' as const : 'complete' as const,
        data: { dataSourceId: jiraCardPrefix.slice(0, -1), schema: {}, cards: cards.filter(card => scopeMatches(card, scope)), hasMore,
          truncatedRelations: [] as Array<{ pageId: string; property: string }>, missingSchemaProperties: [] as string[], scope: 'TSSPIKE synthetic issues only' } }
    }, 60_000, 120_000, 'Jira source unavailable; no absence or successful-write conclusion', Date.now,
    (previous, current) => ({ ...current, cards: retainMissing(previous.cards, current.cards, card => card.id) }))
  }
  async notes(id: string, signal?: AbortSignal, background?: boolean, onPage?: (notes: Array<{ id: string; text: string; author?: string; createdAt?: string }>) => void) {
    const fetcher = background === undefined ? this.fetcher : background ? this.backgroundFetcher : this.parallelFetcher
    await this.issue(id, signal, fetcher)
    const notes: Array<{ id: string; text: string; author?: string; createdAt?: string }> = []
    for (let start = 0, page = 0; page < 5; page++) {
      const body = await this.request(`issue/${this.issueId(id)}/comment?startAt=${start}&maxResults=100`, 'GET', undefined, signal, fetcher)
      signal?.throwIfAborted()
      if (!Array.isArray(body.comments) || !Number.isInteger(body.total) || body.startAt !== start) throw new Error('Incomplete Jira comments')
      const rows = body.comments.map((note: any) => ({ id: note.id, text: adfText(note.body), author: note.author?.accountId, createdAt: note.created }))
      notes.push(...rows)
      onPage?.(rows)
      start += body.comments.length
      if (start >= body.total) return notes
      if (!body.comments.length) break
    }
    throw new Error('Jira comments truncated; cannot establish absence of a receipt')
  }
  async note(id: string, text: string) {
    await this.issue(id)
    await this.request(`issue/${this.issueId(id)}/comment`, 'POST', { body: jiraText(text) })
  }
  private sectionNode(section: { type: string; text: string }) {
    return { type: section.type === 'heading_2' ? 'heading' : 'paragraph', ...(section.type === 'heading_2' ? { attrs: { level: 2 } } : {}), content: section.text ? [{ type: 'text', text: section.text }] : [] }
  }
  async sections(id: string, contracts = false, signal?: AbortSignal, background?: boolean): Promise<JiraSection[]> {
    const fetcher = background === undefined ? this.fetcher : background ? this.backgroundFetcher : this.parallelFetcher
    const issue = await this.issue(id, signal, fetcher), doc = record(issue.fields.description)
    const sections: JiraSection[] = (Array.isArray(doc.content) ? doc.content : []).map((node, index) => ({ id: `${id}:description:${index}`, type: record(node).type === 'heading' ? 'heading_2' : 'paragraph', text: adfText(node) }))
    if (contracts) {
      sections.push(...await this.contractSections(id, issue.fields.attachment, signal, fetcher))
    }
    return sections
  }
  async section(id: string, name: string, desired: string, expected?: string) {
    const issue = await this.issue(id), doc = record(issue.fields.description)
    const nodes: unknown[] = Array.isArray(doc.content) ? doc.content : []
    const prefix = `Tin Star section: ${name}`
    const matches = nodes.map((node, index) => ({ text: adfText(node), index })).filter(node => node.text.split('\n')[0] === prefix)
    if (matches.length > 1 || expected !== undefined && (matches[0]?.text ?? '') !== expected) throw new JiraConflictError('Jira managed section changed; refresh before replacing it')
    if (matches[0]?.text === desired) return
    const content = [...nodes], node = this.sectionNode({ type: 'paragraph', text: desired })
    if (matches[0]) content[matches[0].index] = node
    else content.push(node)
    const current = await this.issue(id)
    if (!isDeepStrictEqual(current.fields.description, issue.fields.description)) throw new JiraConflictError('Jira Description changed during editing; current prose was preserved')
    await this.request(`issue/${this.issueId(id)}`, 'PUT', { fields: { description: { ...doc, type: 'doc', version: 1, content } } })
    if ((await this.sections(id)).filter(section => section.text === desired).length !== 1) throw new Error('Jira section readback differs')
  }
  async appendContract(id: string, sections: Array<{ type: string; text: string }>) {
    // Native immutable attachment batches reuse the existing contract manifests,
    // pending-batch latch and exact chunk/hash readback. No shadow body store.
    await this.issue(id)
    await this.uploadContract(this.issueId(id), sections)
  }
}

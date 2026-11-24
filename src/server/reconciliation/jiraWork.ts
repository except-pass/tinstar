import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquireLock } from '../infra/lock'
import type { JiraWorkConfig } from './config'
import { adfText, JiraAttachmentPreflightError, JiraClient, JiraWriteError, jiraText, type JiraSection } from './jira'
import { CachedObservation, retainMissing } from './observation'
import { mergePublication } from './ownerRequestEvidence'
import {
  checkJiraTransition, editJiraDecisions, formatJiraDecisions, jiraTransitionDestination, jiraWorkIdentity, JiraWorkInputError, readJiraDecisions,
  type JiraCreate, type JiraEdit, type JiraExternalBlocker, type JiraLink, type JiraTransition,
} from './jiraWorkRules'
import { CreationReceipts } from './workflowReceipts'
import { tswKey, tswProjectId } from './tswSnapshot'
import { scopeMatches, type WorkCard, type WorkData } from './workReader'
import type { WorkScope } from './notion'

const createProperty = 'tinstar.work.create'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const accessDenied = (error: unknown) => error instanceof JiraWriteError && (error.status === 401 || error.status === 403)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const calendarDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const nativeId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d*$/.test(id)
const reviewStatus = 'Ready for Review'
type OwnerIssue = {
  id: string; key: string; url: string
  decisions: ReturnType<typeof readJiraDecisions>
  reviewAssigned: boolean
  merges: Array<NonNullable<ReturnType<typeof mergePublication>> & { comment: string; createdAt: number; coordinator?: boolean }>
  notesUnavailable?: boolean
  reviewAfter?: number
  readComments?: Set<string>
  warning?: string
}
type ReviewChange = { fieldId?: string; field?: string; fromString?: string; toString?: string }

function text(value: unknown, unsupported: true | 'omit' = true) {
  if (typeof value === 'string') return value
  return adfText(value, unsupported)
}
class JiraWorkUnconfirmed extends Error {}
class JiraCreateContradiction extends JiraWorkUnconfirmed {}
class JiraAuditRejected extends JiraWorkUnconfirmed {}
const isWriteRejection = (error: unknown): error is JiraWriteError =>
  error instanceof JiraWriteError && error.method !== 'GET' && error.status >= 400 && error.status < 500 && error.status !== 408
type Link = { id: string; type_id: string; type: string; label: string; direction: 'inward' | 'outward'; target_key: string; target_id: string }
type Issue = {
  id: string; issue_id: string; key: string; url: string; project_id: string; issue_type: string; status: string; name: string;
  description: string; instructionText: string; owner: string | null; decisions: string; decisionDocument: any; updated_at: string; due_date: string | null; links: Link[];
  blockerConditionText: string;
  assignee: string | null; assignee_id: string | null;
  externalBlocker: { type: string | null; target: string; unblocks_when: string };
}
type Attempt = {
  marker: string
  dispatched: boolean
  dispatch: () => Promise<void>
  confirm: (card: Issue) => ReturnType<JiraWork['saved']>
}
type WriteInput = JiraCreate | JiraEdit | JiraTransition | JiraLink
export type JiraWorkCard = ReturnType<JiraWork['view']>
export type JiraHistoryCursor = { total: number; last: string | null }
export type JiraTrackedChange = { field: 'status' | 'assignee'; from: string | null; to: string | null; byService: boolean; occurredAt: number | null; entryId: string }
const coordinatorReviewNote = (body: string) => /^Operation: tsw-[a-f0-9]{64}-edit-review(?:-(?:attempt-\d+|retry-1))*$/m.test(body)
type BeforeWrite = (current: JiraWorkCard) => void | Promise<void>

/** Native Jira work records share Tin Star's MCP and Jira transport. This
 * adapter only calls issue APIs and has no dispatch or Jira admin capability. */
export class JiraWork extends JiraClient {
  private readonly receipts: CreationReceipts
  private readonly site: string
  private readonly confirmed = new Map<string, { card: WorkCard; until: number }>()
  accessRevision = 0
  private readonly scoped = new Map<string, { scope: WorkScope; observation: CachedObservation<WorkData> }>()
  private reviewHistoryCursor?: string
  readonly ownerRequests = new CachedObservation(() => this.readOwnerRequests(), 20_000, 60_000,
    'Jira owner requests unavailable; retained records require verification.', Date.now, (previous: OwnerIssue[], current: OwnerIssue[]) =>
      retainMissing(previous, current, issue => issue.id), (previous, current) => {
    const known = new Map(previous?.map(issue => [issue.id, issue]))
    return current.map(issue => {
      if (!issue.notesUnavailable) return issue
      const retained = (known.get(issue.id)?.merges ?? []).filter(merge =>
        merge.createdAt > (issue.reviewAfter ?? -Infinity) && !issue.readComments?.has(merge.comment))
      return { ...issue, merges: [...issue.merges, ...retained] }
    })
  })
  constructor(private readonly config: JiraWorkConfig, private readonly root: string, fetcher?: (input: string, init?: RequestInit) => Promise<Response>, private readonly onAccessDenied?: () => void) {
    super(`https://api.atlassian.com/ex/jira/${config.cloudId}`, `Bearer ${config.token}`, fetcher)
    this.site = new URL(config.url).hostname
    this.receipts = new CreationReceipts(root)
  }

  protected override async request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const revision = this.accessRevision
    try { return await super.request(path, method, body, signal) }
    catch (error) {
      if ((method === 'GET' && path.startsWith('issue/') || path === 'search/jql') && accessDenied(error) && revision === this.accessRevision) this.discardObservations()
      throw error
    }
  }

  private qualified(id: string) { return `jira:${this.site}:${this.config.projectId}:${id}` }

  private boardFields() {
    const { owner, blockerType, blockerTarget, blockerCondition } = this.config.fields
    return ['project', 'issuetype', 'summary', 'status', 'updated', 'duedate', owner, blockerType, blockerTarget, blockerCondition]
  }

  private boardFieldsFrom(raw: Record<string, any>) {
    const fields = raw.fields, { owner, blockerType, blockerTarget, blockerCondition } = this.config.fields
    if (!nativeId(raw.id) || !nonempty(raw.key) || !/^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(raw.key) ||
      fields?.project?.id !== this.config.projectId || !nativeId(fields.issuetype?.id) ||
      !nonempty(fields.summary) || !nonempty(fields.status?.name) || !nonempty(fields.updated) ||
      !calendarDate(fields.updated.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(fields.updated) ||
      !Number.isFinite(Date.parse(fields.updated)) ||
      (fields.duedate !== null && !calendarDate(fields.duedate)) ||
      (fields[owner] !== null && !nonempty(fields[owner]?.value)) ||
      (fields[blockerType] !== null && !['Actor', 'Event'].includes(fields[blockerType]?.value)) ||
      (fields[blockerTarget] !== null && typeof fields[blockerTarget] !== 'string') ||
      (fields[blockerCondition] !== null && typeof fields[blockerCondition] !== 'string' && fields[blockerCondition]?.type !== 'doc')) {
      throw new Error('Incomplete Jira work issue')
    }
    return { issue_id: raw.id, key: raw.key, name: fields.summary as string, status: fields.status.name as string, updated_at: fields.updated as string,
      owner: fields[owner]?.value as string ?? null, due_date: fields.duedate as string | null,
      externalBlocker: { type: fields[blockerType]?.value as string ?? null, target: text(fields[blockerTarget]), unblocks_when: text(fields[blockerCondition], 'omit') } }
  }

  private projectCard(issue: Pick<Issue, 'issue_id' | 'key' | 'name' | 'status' | 'updated_at' | 'owner' | 'due_date' | 'externalBlocker'>): WorkCard {
    const property = (id: string | null, type: string, value: unknown) => ({ id, type, value, hasMore: false })
    const request = issue.status === 'Waiting For' && issue.externalBlocker.type === 'Actor' &&
      issue.externalBlocker.target.trim().toLowerCase() === 'will'
    const id = this.qualified(issue.issue_id)
    const card: WorkCard = {
      id, url: `${this.config.url}/browse/${encodeURIComponent(issue.key)}`,
      last_edited_time: issue.updated_at, archived: issue.status === 'Canceled', in_trash: false,
      source: { provider: 'jira', instanceId: this.config.url, collectionId: this.config.projectId, itemId: issue.issue_id, displayKey: issue.key, synthetic: false },
      properties: {
        Name: property('summary', 'title', issue.name), Status: property('status', 'status', issue.status),
        Owner: property(this.config.fields.owner, 'select', issue.owner),
        'Waiting For': property(this.config.fields.blockerTarget, 'rich_text', request ? 'Will' : null),
        'Next action': property(this.config.fields.blockerCondition, 'rich_text', request ? issue.externalBlocker.unblocks_when : null),
        'Next check-in': property('duedate', 'date', issue.due_date ? { start: issue.due_date, end: null, time_zone: null } : null),
        'Last touched by': property(null, 'rich_text', null),
      },
    }
    return card
  }

  private discardObservations() {
    this.accessRevision++
    this.confirmed.clear()
    this.observation.discard()
    this.ownerRequests.discard()
    for (const { observation } of this.scoped.values()) observation.discard()
    this.onAccessDenied?.()
  }

  readonly observation = this.observeProject()
  observationFor({ owner, statuses }: WorkScope) {
    if (!owner || !statuses?.length) return this.observation
    const scope = { owner, statuses: [...new Set(statuses)].sort() }
    const key = JSON.stringify(scope)
    const cached = this.scoped.get(key)
    if (cached) return cached.observation
    if (this.scoped.size >= 100) this.scoped.delete(this.scoped.keys().next().value!)
    const fieldId = this.config.fields.owner.slice('customfield_'.length)
    const filter = ` AND cf[${fieldId}] = ${JSON.stringify(owner)} AND status IN (${scope.statuses.map(status => JSON.stringify(status)).join(', ')})`
    const observation = this.observeProject(filter, scope)
    this.scoped.set(key, { scope, observation })
    return observation
  }

  private observeProject(filter = '', scope?: WorkScope) {
    return new CachedObservation<WorkData>(async () => {
      const cards = new Map<string, WorkCard>(), seen = new Set<string>()
      const signal = AbortSignal.timeout(20_000)
      let cursor: string | undefined, complete = false, invalidRow = false
      // Bound the project census and preserve pages already read if a later request fails.
      for (let page = 0; page < 20; page++) {
        try {
          const result = await this.request('search/jql', 'POST', {
            jql: `project = ${this.config.projectId} AND issuetype IN (${Object.values(this.config.issueTypes).join(', ')})${filter} ORDER BY id`, fields: this.boardFields(),
            maxResults: 100, ...(cursor ? { nextPageToken: cursor } : {}),
          }, signal)
          if (!Array.isArray(result.issues)) throw new Error('Incomplete Jira work search page')
          for (const row of result.issues) {
            try {
              const projected = this.boardFieldsFrom(row)
              if (!Object.values(this.config.issueTypes).includes(row.fields.issuetype.id)) throw new Error('Unexpected Jira issue type in search')
              const card = this.projectCard(projected)
              cards.set(card.id, card)
            } catch { invalidRow = true }
          }
          if (result.isLast === true) { complete = !invalidRow; break }
          cursor = result.nextPageToken
          if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('Invalid Jira work search cursor')
          seen.add(cursor)
        } catch (error) {
          if (accessDenied(error)) throw error
          if (!cards.size) throw error
          break
        }
      }
      for (const [id, { card, until }] of this.confirmed) {
        if (until <= Date.now()) { this.confirmed.delete(id); continue }
        const indexed = cards.get(id)
        if (indexed && Date.parse(indexed.last_edited_time) > Date.parse(card.last_edited_time)) continue
        cards.delete(id)
        try {
          const raw = await this.request(`issue/${this.id(id)}?fields=${this.boardFields().join(',')}`, 'GET', undefined, signal)
          if (raw.id !== this.id(id) || !nativeId(raw.fields?.project?.id) || !nativeId(raw.fields?.issuetype?.id)) throw new Error('Jira issue identity could not be confirmed')
          if (raw.fields?.project?.id !== this.config.projectId || !Object.values(this.config.issueTypes).includes(raw.fields?.issuetype?.id)) continue
          const current = this.projectCard(this.boardFieldsFrom(raw))
          if (!scope || scopeMatches(current, scope)) cards.set(id, current)
        } catch (error) {
          if (accessDenied(error)) throw error
          if (!(error instanceof JiraWriteError && error.status === 404)) complete = false
        }
      }
      return { observedAt: new Date().toISOString(), coverage: complete ? 'complete' : 'partial',
        data: { dataSourceId: `jira:${this.site}:${this.config.projectId}`, schema: {}, cards: [...cards.values()], hasMore: !complete,
          truncatedRelations: [], missingSchemaProperties: [], scope: 'Configured Jira work project' } }
    }, 60_000, 120_000, 'Jira work project read failed; verify project access', Date.now,
      (previous, current) => ({ ...current, cards: retainMissing(previous.cards.filter(card => !this.confirmed.has(card.id)), current.cards, card => card.id) }))
  }

  private id(cardId: string) {
    const id = jiraWorkIdentity(cardId)
    if (id?.site !== this.site || id.projectId !== this.config.projectId) throw new JiraWorkInputError('Ticket is outside the configured Jira site and project')
    return id.issueId
  }

  private async checkProject(id: string, signal?: AbortSignal) {
    const issue = await this.request(`issue/${id}?fields=project`, 'GET', undefined, signal)
    if (issue.id !== id || issue.fields?.project?.id !== this.config.projectId) {
      throw new JiraWorkInputError('Ticket is outside the configured Jira project')
    }
  }

  private async read(id: string, allowOtherTypes = false, signal?: AbortSignal): Promise<Issue> {
    await this.checkProject(id, signal)
    const fields = [...this.boardFields(), 'assignee', 'description', 'issuelinks', this.config.fields.decisions]
    const raw = await this.request(`issue/${id}?fields=${fields.join(',')}`, 'GET', undefined, signal)
    const f = raw.fields
    if (raw.id !== id || f?.project?.id !== this.config.projectId) {
      throw new JiraWorkInputError('Jira readback did not confirm the configured issue identity and project')
    }
    const projection = this.boardFieldsFrom(raw)
    const issueType = Object.entries(this.config.issueTypes).find(([, typeId]) => typeId === f.issuetype?.id)?.[0]
    if ((!issueType && (!allowOtherTypes || !nativeId(f.issuetype?.id))) ||
      (f.assignee !== null && (!nonempty(f.assignee?.displayName) || !nonempty(f.assignee?.accountId))) || !Array.isArray(f.issuelinks) || Object.values(this.config.fields).some(field => !Object.hasOwn(f, field))) {
      throw new Error('Incomplete Jira work readback')
    }
    const links = f.issuelinks.map((link: Record<string, any>): Link => {
      const direction = link.inwardIssue ? 'inward' : 'outward'
      const target = link[direction + 'Issue']
      if (!nativeId(link.id) || !nativeId(link.type?.id) || !nativeId(target?.id) || typeof target.key !== 'string') throw new Error('Incomplete Jira issue link readback')
      return { id: link.id, type_id: link.type.id, type: link.type.name, label: link.type[direction], direction, target_key: target.key, target_id: target.id }
    })
    const { decisions, blockerCondition } = this.config.fields
    return {
      ...projection, id: this.qualified(id), url: `${this.config.url}/browse/${encodeURIComponent(raw.key)}`,
      assignee: f.assignee?.displayName ?? null, assignee_id: f.assignee?.accountId ?? null,
      project_id: this.config.projectId, issue_type: issueType ?? f.issuetype.name ?? f.issuetype.id,
      description: text(f.description), instructionText: text(f.description, 'omit'), decisions: text(f[decisions]), decisionDocument: f[decisions], links,
      blockerConditionText: text(f[blockerCondition], 'omit'),
      externalBlocker: { ...projection.externalBlocker, unblocks_when: text(f[blockerCondition]) },
    }
  }

  private nativeBlockers(issue: Issue) {
    return issue.links.filter(link => link.direction === 'inward' && link.type_id === this.config.blocksLinkTypeId)
  }

  private externalPresent(issue: Issue) {
    return Object.values(issue.externalBlocker).some(Boolean)
  }

  private linkView({ target_id: _target, ...link }: Link) { return link }

  private blocker(issue: Issue) {
    const native = this.nativeBlockers(issue)
    const external = issue.externalBlocker
    const count = native.length + Number(this.externalPresent(issue))
    if (count > 1) throw new JiraWorkInputError('Jira has multiple primary blockers; choose one before transitioning')
    if (native.length) return { type: 'Jira' as const, link: this.linkView(native[0]!) }
    if (!count) return null
    if ((external.type !== 'Actor' && external.type !== 'Event') || !/^\S+$/.test(external.target) || !issue.blockerConditionText.trim()) {
      throw new JiraWorkInputError('Correct the external blocker type, identifier and unblock condition')
    }
    return external as JiraExternalBlocker
  }

  private view(issue: Issue) {
    const { decisions, decisionDocument: _document, instructionText: _instructions, blockerConditionText: _condition, externalBlocker, ...card } = issue
    let decision_questions, blocker
    const warnings: string[] = []
    try { decision_questions = readJiraDecisions(decisions) } catch (error) { warnings.push((error as Error).message) }
    try { blocker = this.blocker(issue) } catch (error) { warnings.push((error as Error).message) }
    return { ...card, links: issue.links.map(link => this.linkView(link)), decision_questions, decision_text: decisions, blocker,
      ...(blocker === undefined ? { external_blocker_fields: externalBlocker } : {}), ...(warnings.length ? { warnings } : {}) }
  }

  private async notes(issueId: string, startAt = 0, signal?: AbortSignal) {
    await this.checkProject(issueId, signal)
    const body = await this.request(`issue/${issueId}/comment?startAt=${startAt}&maxResults=50&orderBy=-created`, 'GET', undefined, signal)
    if (!Array.isArray(body.comments) || !Number.isSafeInteger(body.total) || body.total < 0 || body.startAt !== startAt ||
      body.comments.length > body.total - startAt || !body.comments.length && startAt < body.total) throw new Error('Incomplete Jira comment readback')
    await this.checkProject(issueId, signal)
    return { comments: body.comments.map((comment: Record<string, any>) => ({
      id: comment.id, body: comment.visibility == null ? text(comment.body) : undefined, created_at: comment.created, updated_at: comment.updated, author_id: comment.author?.accountId,
    })), total: body.total as number }
  }

  /** A review note can precede the move into review. Exclude notes from before
   * the last exit from review so a new review cycle cannot revive an old ask. */
  private async previousReviewExit(issueId: string, signal: AbortSignal) {
    let after = -Infinity
    let offset = 0
    for (let page = 0; page < 5; page++) {
      const history = await this.request(`issue/${issueId}/changelog?startAt=${offset}&maxResults=100`, 'GET', undefined, signal)
      if (history.startAt !== offset || !Number.isSafeInteger(history.total) || !Array.isArray(history.values)) throw new Error('Incomplete Jira review history')
      for (const row of history.values) {
        if (!Array.isArray(row.items)) throw new Error('Incomplete Jira review history')
        if (row.items.some((item: ReviewChange) => (item.fieldId ?? item.field) === 'status' &&
            item.fromString === reviewStatus && item.toString !== reviewStatus)) {
          if (!Number.isFinite(Date.parse(row.created))) throw new Error('Jira review history has no timestamp')
          after = Math.max(after, Date.parse(row.created))
        }
      }
      offset += history.values.length
      if (offset >= history.total) return after
      if (!history.values.length) break
    }
    throw new Error('Jira review history exceeds the read budget')
  }

  private async readOwnerRequests() {
    const signal = AbortSignal.timeout(12_000)
    const issues = new Map<string, OwnerIssue>()
    const decisions = this.config.fields.decisions
    const jql = `project = ${this.config.projectId} AND status NOT IN (Done, Canceled) AND (cf[${decisions.slice('customfield_'.length)}] IS NOT EMPTY OR status = "${reviewStatus}") ORDER BY id`
    const fields = ['project', 'status', 'assignee', decisions]
    const cursors = new Set<string>()
    let nextPageToken: string | undefined, last = false
    for (let page = 0; page < 10 && !last; page++) {
      try {
        const body = await this.request('search/jql', 'POST', { jql, maxResults: 100, fields, ...(nextPageToken ? { nextPageToken } : {}) }, signal)
        if (!Array.isArray(body.issues) || typeof body.isLast !== 'boolean') throw new Error('Incomplete Jira owner census')
        for (const raw of body.issues) {
          const f = raw.fields
          if (!nativeId(raw.id) || !/^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(raw.key) || f?.project?.id !== this.config.projectId ||
              typeof f.status?.name !== 'string' || !Object.hasOwn(f, decisions) || !Object.hasOwn(f, 'assignee')) {
            throw new Error('Jira search did not confirm issue identity, project and request fields')
          }
          if (['Done', 'Canceled'].includes(f.status.name)) continue
          const issue: OwnerIssue = { id: this.qualified(raw.id), key: raw.key, url: `${this.config.url}/browse/${raw.key}`,
            decisions: [], merges: [],
            // Matches the native assignee used by the TSW status coordinator.
            reviewAssigned: f.status.name === reviewStatus && f.assignee?.displayName === 'William Gathright' && !!f.assignee?.accountId && f.assignee.active !== false }
          try { issue.decisions = readJiraDecisions(text(f[decisions])).filter(item => item.answer === undefined) }
          catch { issue.warning = 'Decision Questions could not be read.' }
          issues.set(raw.id, issue)
        }
        last = body.isLast
        if (!last) {
          if (typeof body.nextPageToken !== 'string' || cursors.has(body.nextPageToken)) throw new Error('Invalid Jira search cursor')
          nextPageToken = body.nextPageToken
          cursors.add(body.nextPageToken)
        }
      } catch (error) {
        if (!issues.size) throw error
        break
      }
    }
    const candidates = [...issues].filter(([, issue]) => issue.reviewAssigned)
    const start = candidates.findIndex(([id]) => id === this.reviewHistoryCursor) + 1
    const reviews = [...candidates.slice(start), ...candidates.slice(0, start)]
    let serviceAccount: Promise<string> | undefined
    for (let offset = 0; offset < reviews.length; offset += 4) {
      const batch = reviews.slice(offset, offset + 4)
      if (!signal.aborted) this.reviewHistoryCursor = batch.at(-1)?.[0]
      await Promise.all(batch.map(async ([id, issue]) => {
        try {
          signal.throwIfAborted()
          const after = await this.previousReviewExit(id, signal)
          issue.reviewAfter = after
          const seen = issue.readComments = new Set<string>()
          let startAt = 0
          let total: number | undefined
          let boundary: Awaited<ReturnType<JiraWork['notes']>>['comments'][number] | undefined
          for (let page = 0; page < 5; page++) {
            const notes = await this.notes(id, startAt, signal)
            const overlaps = total !== undefined && isDeepStrictEqual(notes.comments[0], boundary)
            let shifted = total !== undefined && (notes.total !== total || !overlaps)
            const comments = overlaps ? notes.comments.slice(1) : notes.comments
            total = notes.total
            let reachedPreviousCycle = false
            for (const note of comments) {
              const createdAt = Date.parse(note.created_at)
              if (!nativeId(note.id) || !Number.isFinite(createdAt) || seen.has(note.id)) {
                shifted = true
                continue
              }
              seen.add(note.id)
              if (createdAt <= after) reachedPreviousCycle = true
              if (!note.body || createdAt <= after) continue
              for (const line of note.body.split(/\r?\n/)) {
                const pull = mergePublication(line, true)
                if (pull) {
                  const coordinator = !!pull.head && !!note.author_id && coordinatorReviewNote(note.body) &&
                    note.author_id === await (serviceAccount ??= this.serviceAccountId(signal))
                  issue.merges.push({ ...pull, comment: note.id, createdAt, coordinator })
                }
              }
            }
            if (shifted) throw new Error('Jira comment history shifted between pages')
            const end = startAt + notes.comments.length
            if (end >= total || reachedPreviousCycle) return
            if (!comments.length) throw new Error('Incomplete Jira comment history')
            boundary = notes.comments.at(-1)
            startAt = end - 1
          }
          throw new Error('Jira comment history exceeds the read budget')
        } catch {
          issue.notesUnavailable = true
          issue.warning = [issue.warning, 'Current merge notes or review history could not be verified.'].filter(Boolean).join(' ')
        }
      }))
    }
    return { observedAt: new Date().toISOString(), coverage: last ? 'complete' as const : 'partial' as const, data: [...issues.values()] }
  }

  async get(cardId: string, details: boolean) {
    try {
      const card = this.view(await this.read(this.id(cardId)))
      if (!details) return { outcome: 'available', card }
      try {
        const page = await this.notes(card.issue_id)
        return { outcome: 'available', card, comments: page.comments.map(({ updated_at: _updated, ...comment }) => comment), more_comments: page.total > page.comments.length }
      } catch (error) { if (accessDenied(error)) throw error; return { outcome: 'available', card, warnings: ['Jira comments could not be read'] } }
    } catch (error) { return { outcome: 'unavailable', message: this.message(error) } }
  }

  async readTswCard(key: string) {
    return this.view(await this.readTswIssue(key))
  }

  readTswTargets(keys: readonly string[]) {
    return new CachedObservation<WorkData>(async () => {
      const signal = AbortSignal.timeout(20_000)
      const cards: WorkCard[] = []
      let complete = true
      for (let offset = 0; offset < keys.length; offset += 4) {
        signal.throwIfAborted()
        const batch = await Promise.all(keys.slice(offset, offset + 4).map(async key => {
          try { return this.projectCard(await this.readTswIssue(key, signal)) }
          catch (error) {
            if (accessDenied(error)) throw error
            if (!(error instanceof JiraWriteError && error.status === 404)) complete = false
            return null
          }
        }))
        cards.push(...batch.filter(card => card !== null))
      }
      return { observedAt: new Date().toISOString(), coverage: complete ? 'complete' : 'partial',
        data: { dataSourceId: `jira:${this.site}:${this.config.projectId}`, schema: {}, cards, hasMore: !complete,
          truncatedRelations: [], missingSchemaProperties: [], scope: 'Declared TSW targets' } }
    }, 60_000, 120_000, 'Jira dispatch target read failed').get()
  }

  private async readTswIssue(key: string, signal?: AbortSignal) {
    if (this.config.projectId !== tswProjectId || !tswKey(key)) throw new JiraWorkInputError('Status sync requires an exact TSW issue key')
    const target = await this.resolveLinkTarget(key, signal)
    if (target.key !== key || target.projectId !== tswProjectId) throw new JiraWorkInputError('Jira key no longer identifies this TSW issue')
    const issue = await this.read(target.id, false, signal)
    if (issue.key !== key) throw new JiraWorkInputError('Jira key changed while reading the TSW issue')
    return issue
  }

  async statusHistory(cardId: string, after: JiraHistoryCursor = { total: 0, last: null }) {
    const id = this.id(cardId)
    await this.checkProject(id)
    const page = async (offset: number, count: number) => {
      const result = await this.request(`issue/${id}/changelog?startAt=${offset}&maxResults=${count}`)
      if (!Number.isSafeInteger(result.total) || result.total < 0 || result.startAt !== offset || !Array.isArray(result.values) ||
        result.values.some(entry => !nativeId(entry.id) || !Array.isArray(entry.items))) throw new Error('Incomplete Jira change history')
      return { total: result.total as number, values: result.values as Array<{ id: string; created?: string; author?: { accountId?: string }; items: Array<Record<string, any>> }> }
    }
    const changes: JiraTrackedChange[] = []
    let offset = Math.max(0, after.total - 1)
    let last = after.last
    let service: string | undefined
    for (;;) {
      const result = await page(offset, 100)
      if (result.total < after.total || offset < result.total && !result.values.length ||
          after.total > 0 && offset === after.total - 1 && result.values[0]?.id !== after.last) {
        throw new Error('Jira change history no longer contains the saved baseline')
      }
      for (const entry of result.values.slice(Math.max(0, after.total - offset))) {
        last = entry.id
        for (const item of entry.items) {
          const field = item.fieldId ?? item.field
          if (field !== 'status' && field !== 'assignee') continue
          const from = field === 'status' ? item.fromString : item.from
          const to = field === 'status' ? item.toString : item.to
          // Jira may migrate between native status IDs with the same name.
          if (field === 'status' && (typeof from !== 'string' || typeof to !== 'string') ||
              field === 'assignee' && (from != null && typeof from !== 'string' || to != null && typeof to !== 'string')) {
            throw new Error('Incomplete Jira status or assignee history')
          }
          if (from === to) continue
          service ??= await this.serviceAccountId()
          const timestamp = Date.parse(entry.created ?? '')
          changes.push({ field, from: from ?? null, to: to ?? null, byService: entry.author?.accountId === service,
            occurredAt: Number.isFinite(timestamp) ? timestamp : null, entryId: entry.id })
        }
      }
      offset += result.values.length
      if (offset >= result.total) return { cursor: { total: result.total, last }, changes }
    }
  }

  owns(cardId: string) {
    const identity = jiraWorkIdentity(cardId)
    return identity?.site === this.site && identity.projectId === this.config.projectId
  }

  async handoffCard(cardId: string): Promise<WorkCard> {
    const card = await this.read(this.id(cardId))
    const field = (type: string, value: unknown) => ({ id: null, type, value, hasMore: false })
    return { id: card.id, url: card.url, last_edited_time: card.updated_at, archived: false, in_trash: false,
      properties: { Name: field('title', card.name), Owner: field('select', card.owner), Status: field('status', card.status) } }
  }

  private readonly handoffAttachments = new AsyncLocalStorage<Map<string, JiraSection[]>>()

  withHandoffAttachments<T>(perform: () => T) {
    return this.handoffAttachments.run(new Map(), perform)
  }

  async handoffSections(cardId: string) {
    const id = this.id(cardId)
    const issue = await this.request(`issue/${id}?fields=project,attachment`)
    if (issue.id !== id || issue.fields?.project?.id !== this.config.projectId) {
      throw new JiraWorkInputError('Ticket is outside the configured Jira project')
    }
    const sections = await this.contractSections(cardId, issue.fields.attachment, undefined, this.fetcher, this.handoffAttachments.getStore())
    await this.checkProject(id)
    return sections
  }

  async appendHandoffSections(cardId: string, sections: Array<{ type: string; text: string }>) {
    const id = this.id(cardId)
    try { await this.checkProject(id) }
    catch (error) { throw new JiraAttachmentPreflightError(this.message(error), { cause: error }) }
    await this.uploadContract(id, sections)
  }

  private message(error: unknown) {
    if (error instanceof JiraWorkInputError || error instanceof JiraWorkUnconfirmed) return error.message
    if (error instanceof JiraWriteError) return `Jira returned HTTP ${error.status}`
    return 'Jira request, response or retry record unavailable'
  }

  private saved(issue: Issue, already = false) {
    return { outcome: 'saved' as const, code: already ? 'already-saved' : 'confirmed', card: this.view(issue) }
  }

  private receiptKey(actor: string, operationId: string) {
    return JSON.stringify(['jira-work', this.config.cloudId, this.config.projectId, actor, operationId])
  }

  async writeDispatched(actor: string, operationId: string) {
    return (await this.receipts.get(this.receiptKey(actor, operationId)))?.jiraWork?.dispatched === true
  }

  private async mutate<T extends (ReturnType<JiraWork['saved']> & { message?: string }) | { outcome: 'card-canceled' }>(
    verb: string, input: WriteInput, actor: string, run: (attempt: Attempt) => Promise<T>, retryRateLimit = false, preflight?: () => Promise<unknown>,
  ) {
    const key = this.receiptKey(actor, input.operation_id)
    const marker = `tinstar.work.${digest(key)}`
    let pending = false
    let sent = false
    const cardId = 'card_id' in input ? input.card_id : undefined
    let unlock: Awaited<ReturnType<typeof acquireLock>> | undefined
    try {
      let preflightComplete = false
      if (preflight) {
        const prior = await this.receipts.get(key)
        if (prior && prior.input !== verb) throw new JiraWorkInputError('Operation ID was used for another operation kind')
        if (!prior?.jiraWork?.dispatched && !prior?.jiraWork?.outcome) {
          await preflight()
          preflightComplete = true
        }
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      // Link and blocker edits share a lock so two local callers cannot create
      // conflicting primaries or overwrite an answer derived from the same read.
      unlock = await acquireLock(join(this.root, 'jira-work-writes.lock'))
      const revision = this.accessRevision
      const prior = await this.receipts.get(key)
      if (prior && prior.input !== verb) throw new JiraWorkInputError('Operation ID was used for another operation kind')
      if (prior?.jiraWork?.outcome) return prior.jiraWork.outcome
      const dispatched = prior?.jiraWork?.dispatched === true
      pending = dispatched
      if (preflight && !dispatched && !preflightComplete) throw new JiraWorkInputError('Jira dispatch changed during preflight. Retry the same operation.')
      if (!prior) await this.receipts.putJiraWork(key, verb, false)
      return await run({
        marker, dispatched,
        dispatch: async () => {
          await this.receipts.putJiraWork(key, verb, true)
          pending = true
          sent = true
        },
        confirm: issue => {
          const card = this.projectCard(issue)
          if (revision !== this.accessRevision) throw new JiraWorkUnconfirmed('Jira access changed during the operation')
          if (this.confirmed.size >= 100) this.confirmed.delete(this.confirmed.keys().next().value!)
          this.confirmed.set(card.id, { card, until: Date.now() + 120_000 })
          const newer = (prior: WorkCard) => Date.parse(prior.last_edited_time) > Date.parse(card.last_edited_time)
          const update = (data: WorkData, current?: WorkCard) => data.cards.some(prior => prior.id === card.id && newer(prior))
            ? data : { ...data, cards: [...data.cards.filter(prior => prior.id !== card.id), ...(current ? [current] : [])] }
          this.observation.updateData(data => update(data, card), false)
          for (const { scope, observation } of this.scoped.values()) {
            observation.updateData(data => update(data, scopeMatches(card, scope) ? card : undefined), false)
          }
          return this.saved(issue, dispatched)
        },
      })
    } catch (error) {
      if (retryRateLimit && sent && error instanceof JiraWriteError && error.method === 'POST' && error.status === 429) {
        await this.receipts.putJiraWork(key, verb, false)
        return { outcome: 'partially-saved' as const, code: 'unconfirmed' as const, operation_id: input.operation_id, message: 'Jira rate-limited the handoff. Retry the same operation.' }
      }
      const rejected = sent && isWriteRejection(error)
      const unconfirmed = pending && !rejected
      const result = {
        outcome: unconfirmed ? 'partially-saved' as const : 'not-saved' as const,
        code: unconfirmed ? 'unconfirmed' as const : error instanceof JiraWorkInputError ? 'invalid-work' as const : 'jira-unavailable' as const,
        operation_id: input.operation_id, ...(!rejected && cardId ? { card_id: cardId } : {}),
        message: unconfirmed ? `Unconfirmed. Check Jira. ${this.message(error)}` : this.message(error),
      }
      if (rejected || error instanceof JiraCreateContradiction || error instanceof JiraAuditRejected) {
        await this.receipts.putJiraWork(key, verb, true, result)
      }
      return result
    } finally { await unlock?.() }
  }

  private transitionAudit(input: JiraTransition, actor: string) {
    const details = [
      input.reason && `Reason: ${input.reason}`, input.evidence && `Evidence: ${input.evidence}`,
      'disposition' in input && input.disposition && `Disposition: ${input.disposition}`, 'live_revision' in input && input.live_revision && `Live revision: ${input.live_revision}`,
    ].filter(Boolean)
    return details.length ? [`${input.verb} via Tin Star (${actor})`, ...details].join('\n') : undefined
  }

  private commentUpdate(note?: string) {
    return note ? { update: { comment: [{ add: { body: jiraText(note) } }] } } : {}
  }

  private async serviceAccountId(signal?: AbortSignal): Promise<string> {
    const { accountId } = await this.request('myself', 'GET', undefined, signal)
    if (typeof accountId !== 'string' || !accountId) throw new Error('Missing Jira service account identity')
    return accountId
  }

  private async commentBaseline(id: string) {
    const ids = (await this.notes(id)).comments.map(comment => comment.id)
    const { serverTime } = await this.request('serverInfo')
    const time = typeof serverTime === 'string' ? Date.parse(serverTime) : NaN
    if (!Number.isFinite(time)) throw new Error('Missing Jira server time')
    return { ids, time }
  }

  private async checkComment(id: string, note: string | undefined, expected?: string | { ids: unknown[]; time: number }) {
    if (!note) return
    const accountId = await this.serviceAccountId()
    if (typeof expected === 'string') {
      await this.checkProject(id)
      const comment = await this.request(`issue/${id}/comment/${expected}`).catch(error => {
        if (error instanceof JiraWriteError && error.status === 404) {
          throw new JiraWorkUnconfirmed('Jira did not confirm the requested comment')
        }
        throw error
      })
      await this.checkProject(id)
      if (comment.id !== expected || comment.visibility != null || text(comment.body) !== note || comment.author?.accountId !== accountId) {
        throw new JiraWorkUnconfirmed('Jira did not confirm the requested comment')
      }
      return
    }
    const page = await this.notes(id)
    if (!expected) {
      const matches = (comment: typeof page.comments[number]) => comment.body === note && comment.author_id === accountId
      let current = page
      let offset = 0
      for (;;) {
        if (current.comments.some(matches)) return
        offset += current.comments.length
        if (offset >= page.total) break
        current = await this.notes(id, offset)
        if (current.total !== page.total) throw new Error('Jira comments changed during readback')
      }
      throw new JiraWorkUnconfirmed('Jira did not confirm the requested comment')
    }
    const matching = page.comments.filter(comment => {
      const createdAt = Date.parse(comment.created_at)
      if (comment.body !== note || comment.author_id !== accountId) return false
      return !expected.ids.includes(comment.id) && createdAt === Date.parse(comment.updated_at) && createdAt >= expected.time
    })
    if (matching.length !== 1) {
      throw new JiraWorkUnconfirmed('Jira did not confirm the requested comment')
    }
  }

  private async findCreated(stamp: string) {
    // Entity properties are not indexed JQL fields without an app. Only scan
    // this small project's results when reconciling an ambiguous create.
    let cursor: string | undefined
    const matches: string[] = [], seen = new Set<string>()
    do {
      const page = await this.request('search/jql', 'POST', {
        jql: `project = ${this.config.projectId} ORDER BY id DESC`, fields: ['project'], properties: [createProperty],
        maxResults: 100, ...(cursor ? { nextPageToken: cursor } : {}),
      })
      if (!Array.isArray(page.issues)) throw new Error('Incomplete Jira create reconciliation')
      for (const row of page.issues) {
        if (row.fields?.project?.id === this.config.projectId && nativeId(row.id) && row.properties?.[createProperty] === stamp) matches.push(row.id)
      }
      if (page.isLast === true) break
      cursor = page.nextPageToken
      if (!cursor || seen.has(cursor) || seen.size >= 20) throw new JiraWorkUnconfirmed('Jira create reconciliation did not finish')
      seen.add(cursor)
    } while (cursor)
    if (matches.length > 1) throw new JiraWorkUnconfirmed('Jira has not confirmed one matching creation; retry with the same operation ID')
    return matches[0]
  }

  create(input: JiraCreate, actor: string, mergeDueDate?: string, beforeDispatch?: () => Promise<unknown>) {
    return this.mutate(mergeDueDate ? 'clawson-merge' : 'create', input, actor, async attempt => {
      const issueType = input.issue_type ?? 'Task'
      const typeId = this.config.issueTypes[issueType]
      if (!typeId) throw new JiraWorkInputError(`Jira ${issueType} is not configured`)
      const stamp = attempt.marker
      let id: string | undefined
      if (attempt.dispatched) {
        id = await this.findCreated(stamp)
        if (!id) throw new JiraWorkUnconfirmed('Jira search did not find the operation property')
      } else {
        await attempt.dispatch()
        const result = await this.request('issue', 'POST', {
          fields: {
            project: { id: this.config.projectId }, issuetype: { id: typeId }, summary: input.name,
            ...(input.description ? { description: jiraText(input.description) } : {}),
            ...(input.owner ? { [this.config.fields.owner]: { value: input.owner } } : {}),
            ...(mergeDueDate ? { duedate: mergeDueDate } : {}),
          },
          properties: [{ key: createProperty, value: stamp }],
        })
        if (!nativeId(result.id)) throw new JiraWorkUnconfirmed('Jira creation returned no immutable issue ID')
        id = result.id
      }
      const issue = await this.read(id, !attempt.dispatched)
      if (!attempt.dispatched && (issue.issue_type !== issueType || issue.status !== 'Backlog' || issue.name !== input.name ||
        issue.description !== (input.description ?? '') || issue.owner !== (input.owner ?? null))) {
        throw new JiraCreateContradiction('Jira creation readback differs from the requested ticket or Backlog default')
      }
      const source = await this.request(`issue/${id}/properties/${createProperty}`)
      if (source.value !== stamp) {
        const message = 'Jira did not confirm the creation receipt'
        throw attempt.dispatched ? new JiraWorkUnconfirmed(message) : new JiraCreateContradiction(message)
      }
      if (mergeDueDate && (issue.issue_type !== issueType || issue.name !== input.name || issue.owner !== input.owner ||
        issue.description !== input.description || issue.due_date !== mergeDueDate)) {
        throw new JiraWorkUnconfirmed('Jira did not confirm the merge handoff fields and due date')
      }
      return attempt.confirm(issue)
    }, !!mergeDueDate, beforeDispatch)
  }

  private checkEdit(issue: Issue, input: JiraEdit, assigneeId: string | undefined) {
    const equal = (actual: unknown, expected: unknown) => expected === undefined || isDeepStrictEqual(actual, expected)
    const questions = input.add_questions || input.answers ? readJiraDecisions(issue.decisions) : []
    const blocker = input.blocker === undefined ? undefined : input.blocker ?? { type: null, target: '', unblocks_when: '' }
    if (!equal(issue.name, input.name) || !equal(issue.description, input.description === null ? '' : input.description) ||
      !equal(issue.owner, input.owner) || !equal(issue.assignee_id, assigneeId) || !equal(issue.externalBlocker, blocker) ||
      input.add_questions?.some(question => {
        const saved = questions.find(item => item.id === question.id)
        return saved?.question !== question.question || !isDeepStrictEqual(saved.options ?? [], question.options ?? [])
      }) || input.answers?.some(answer => questions.find(item => item.id === answer.id)?.answer !== answer.answer)) {
      throw new JiraWorkUnconfirmed('Jira field readback differs from the requested edit')
    }
  }

  async findAssignableAccount(cardId: string, name: string) {
    const id = this.id(cardId)
    await this.checkProject(id)
    const users = await this.request(`user/assignable/search?${new URLSearchParams({ issueId: id, query: name, maxResults: '1000' })}`)
    if (!Array.isArray(users)) throw new Error('Incomplete Jira assignee search')
    const eligible = users.filter(user => user.active === true && typeof user.accountId === 'string' && user.accountId &&
      typeof user.displayName === 'string')
    const matches = new Set(eligible.filter(user => user.displayName === name).map(user => user.accountId as string))
    return matches.size === 1 ? [...matches][0]! : null
  }

  private editDecisionDocument(issue: Issue, input: JiraEdit) {
    const desired = readJiraDecisions(editJiraDecisions(issue.decisions, input))
    const original = issue.decisionDocument
    if (original == null || typeof original === 'string') return jiraText(formatJiraDecisions(desired))
    const added = new Set(input.add_questions?.map(question => question.id))
    const answers = new Map(desired.filter(item => !added.has(item.id) && input.answers?.some(answer => answer.id === item.id))
      .map(item => [item.id, item.answer!]))
    const headings = [...issue.decisions.matchAll(/^(D[1-9]\d*) \[(?:Open|Answered)\]: /gm)]
    const edits = headings.flatMap((heading, index) => {
      const answer = answers.get(heading[1]!)
      if (answer === undefined) return []
      const status = heading.index + heading[1]!.length + 2
      const end = heading.index + issue.decisions.slice(heading.index, headings[index + 1]?.index).replace(/(?:\n[ \t]*)+$/, '').length
      const lines = answer.replace(/\r\n/g, '\n').split('\n')
      return [{ start: status, end: status + 4, answer: undefined },
        { start: end, end, answer: lines.map((line, i) => ({ type: 'text', text: i ? `    ${line}` : `  Answer: ${line}` })) }]
    })
    const rewrite = (node: any, start: number, blockAnswer?: number): any[] => {
      const end = start + text(node).length
      if (!edits.some(edit => edit.start <= end && edit.end >= start)) return [node]
      if (node.type === 'text' || node.type === 'codeBlock') {
        const codeBlock = node.type === 'codeBlock'
        const value = codeBlock ? text(node) : node.text
        const parts: any[] = []
        let offset = start
        const append = (value: string) => {
          if (value) parts.push(codeBlock ? { type: 'text', text: value } : { ...node, text: value })
        }
        for (const edit of edits) {
          if (edit.answer) {
            if (edit.start <= start || edit.start > end || edit.start === blockAnswer) continue
            append(value.slice(offset - start, edit.start - start))
            if (codeBlock) append('\n' + edit.answer.map(line => line.text).join('\n'))
            else parts.push(...edit.answer.flatMap(line => [{ type: 'hardBreak' }, line]))
            offset = edit.start
          } else if (edit.start < end && edit.end > start) {
            append(value.slice(offset - start, Math.max(offset, edit.start) - start))
            if (edit.start >= start) append('Answered')
            offset = Math.min(end, edit.end)
          }
        }
        append(value.slice(offset - start))
        if (codeBlock) {
          const rewritten = parts.map(part => part.text).join('')
          return [rewritten === value ? node : { ...node, content: [{ type: 'text', text: rewritten }] }]
        }
        return parts.length === 1 && parts[0].text === value ? [node] : parts
      }
      if (!Array.isArray(node.content)) {
        const insertion = edits.find(edit => edit.answer && edit.start !== blockAnswer && edit.start === start + text(node).length)
        return insertion ? [node, ...insertion.answer!.flatMap(line => [{ type: 'hardBreak' }, line])] : [node]
      }
      let offset = start
      const separator = ['paragraph', 'heading', 'codeBlock'].includes(node.type) ? 0 : 1
      const content = node.content.flatMap((child: { type?: string }) => {
        const end = offset + text(child).length
        const answer = node.type === 'doc' && child.type !== 'codeBlock' ? edits.find(edit => edit.answer && edit.start === end) : undefined
        const result = rewrite(child, offset, answer?.start ?? blockAnswer)
        offset = end + separator
        return answer ? [...result, ...answer.answer!.map(line => ({ type: 'paragraph', content: [line] }))] : result
      })
      return [{ ...node, content }]
    }
    const [doc] = rewrite(original, 0)
    const content = [...doc.content ?? []]
    if (added.size) content.push(...jiraText(formatJiraDecisions(desired.filter(item => added.has(item.id)))).content)
    const result = { ...doc, content }
    if (!isDeepStrictEqual(readJiraDecisions(text(result)), desired)) {
      throw new JiraWorkInputError('Could not safely update the Jira Decision document')
    }
    return result
  }

  async tswReviewNote(cardId: string, pull: string) {
    const id = this.id(cardId)
    const signal = AbortSignal.timeout(12_000)
    await this.checkProject(id, signal)
    const after = await this.previousReviewExit(id, signal)
    const account = await this.serviceAccountId(signal)
    let offset = 0
    let boundary: Awaited<ReturnType<JiraWork['notes']>>['comments'][number] | undefined
    let expectedTotal: number | undefined
    const heads = new Set<string>()
    let legacy = false
    let newest: { head: string; createdAt: number; id: string } | undefined
    for (let page = 0; page < 5; page++) {
      const { comments, total } = await this.notes(id, offset, signal)
      if (expectedTotal !== undefined && (expectedTotal !== total || !isDeepStrictEqual(comments[0], boundary))) {
        throw new Error('Jira review comments shifted between pages')
      }
      for (const comment of page ? comments.slice(1) : comments) {
        const body = comment.body
        const createdAt = Date.parse(comment.created_at)
        if (!body || comment.author_id !== account || !nativeId(comment.id) || !(createdAt > after) || !coordinatorReviewNote(body)) continue
        const request = mergePublication(body.split('\n', 1)[0]!, true)
        if (request?.url !== pull || request.conditional) continue
        if (!request.head) { legacy = true; continue }
        heads.add(request.head)
        if (!newest || createdAt > newest.createdAt || createdAt === newest.createdAt && BigInt(comment.id) > BigInt(newest.id)) {
          newest = { head: request.head, createdAt, id: comment.id }
        }
      }
      if (offset + comments.length >= total) return { current: newest?.head ?? (legacy ? null : undefined), heads }
      if (comments.length < 2) break
      expectedTotal = total
      boundary = comments.at(-1)
      offset += comments.length - 1
    }
    throw new Error('Jira review comments exceed the read budget')
  }

  edit(input: JiraEdit, actor: string, beforeWrite?: BeforeWrite) {
    return this.mutate('edit', input, actor, async attempt => {
      const id = this.id(input.card_id)
      const note = input.note ? `${input.note}\n\nRecorded via Tin Star (${actor})` : undefined
      if (!note && [input.name, input.owner, input.assignee, input.description, input.blocker, input.add_questions, input.answers].every(value => value === undefined)) {
        throw new JiraWorkInputError('Supply a ticket edit or comment')
      }
      const baseline = !attempt.dispatched && note ? await this.commentBaseline(id) : undefined
      const current = await this.read(id)
      const assigneeId = input.assignee === undefined ? undefined : await this.findAssignableAccount(input.card_id, input.assignee)
      if (assigneeId === null) {
        throw new JiraWorkInputError('Choose one unambiguous assignable Jira user by display name')
      }
      if (attempt.dispatched) {
        this.checkEdit(current, input, assigneeId)
        await this.checkComment(id, note)
        return attempt.confirm(current)
      }
      if (input.description !== undefined && !input.description?.trim() && current.status === 'Queued') {
        throw new JiraWorkInputError('Return this ticket to To Do before clearing its instructions and success condition')
      }
      if (input.owner === null && !['Backlog', 'Done', 'Canceled'].includes(current.status)) throw new JiraWorkInputError('Owner is required while the ticket is in a work status')
      if (input.blocker && this.nativeBlockers(current).length) throw new JiraWorkInputError('Remove the native Jira blocker before choosing an external blocker')
      const mapping = this.config.fields
      const fields: Record<string, unknown> = {}
      if (input.name !== undefined) fields.summary = input.name
      if (input.owner !== undefined) fields[mapping.owner] = input.owner === null ? null : { value: input.owner }
      if (assigneeId !== undefined) fields.assignee = { accountId: assigneeId }
      if (input.description !== undefined) fields.description = input.description === null ? null : jiraText(input.description)
      if (input.blocker !== undefined) {
        fields[mapping.blockerType] = input.blocker ? { value: input.blocker.type } : null
        fields[mapping.blockerTarget] = input.blocker?.target ?? null
        fields[mapping.blockerCondition] = input.blocker ? jiraText(input.blocker.unblocks_when) : null
      }
      if (input.add_questions || input.answers) fields[mapping.decisions] = this.editDecisionDocument(current, input)
      if (beforeWrite) await beforeWrite(this.view(await this.read(id)))
      await attempt.dispatch()
      await this.request(`issue/${id}`, 'PUT', { fields, ...this.commentUpdate(note) })
      const saved = await this.read(id)
      await this.checkComment(id, note, baseline)
      this.checkEdit(saved, input, assigneeId)
      if (fields[mapping.decisions] && saved.decisions !== text(fields[mapping.decisions])) {
        throw new JiraWorkUnconfirmed('Jira did not confirm the full Decision Questions field')
      }
      return attempt.confirm(saved)
    })
  }

  private async postTransitionAudit(id: string, note: string, deferAudit: boolean, onDispatch?: () => void) {
    const baseline = await this.commentBaseline(id).catch(() => undefined)
    const body = jiraText(note)
    await this.checkProject(id)
    if (deferAudit && (await this.read(id)).status === 'Canceled') return false
    onDispatch?.()
    const posted = await this.request(`issue/${id}/comment`, 'POST', { body }).catch(error => {
      if (isWriteRejection(error)) {
        const Rejected = deferAudit ? JiraWorkUnconfirmed : JiraAuditRejected
        throw new Rejected(`Jira confirmed the destination status but rejected the audit comment (HTTP ${error.status}).`)
      }
      return undefined
    })
    const expected = nativeId(posted?.id) ? posted.id : baseline
    if (!expected) throw new JiraWorkUnconfirmed('Jira did not confirm the requested comment')
    await this.checkComment(id, note, expected)
    return true
  }

  async repairTransitionAudit(input: JiraTransition, actor: string) {
    let dispatched = false
    const result = await this.mutate('transition', input, actor, async attempt => {
      const note = this.transitionAudit(input, actor)
      if (!attempt.dispatched || !note) throw new JiraWorkInputError('No dispatched transition audit to repair')
      const id = this.id(input.card_id)
      try {
        await this.checkComment(id, note)
      } catch (error) {
        if (!(error instanceof JiraWorkUnconfirmed)) throw error
        if (!await this.postTransitionAudit(id, note, true, () => { dispatched = true })) return { outcome: 'card-canceled' }
      }
      return attempt.confirm(await this.read(id))
    })
    return { outcome: result.outcome, dispatched }
  }

  transition(input: JiraTransition, actor: string, beforeWrite?: BeforeWrite, deferAudit = false, handoffPreflight?: () => Promise<unknown>) {
    return this.mutate('transition', input, actor, async attempt => {
      const id = this.id(input.card_id)
      const note = this.transitionAudit(input, actor)
      const readDestination = async (destination: string) => {
        const issue = await this.read(id)
        if (issue.status !== destination) throw new JiraWorkUnconfirmed('Jira did not confirm the requested destination status')
        return issue
      }
      if (attempt.dispatched) {
        const destination = jiraTransitionDestination(input)
        if (!destination) throw new JiraWorkUnconfirmed('Jira did not confirm the requested destination status')
        try {
          await this.checkComment(id, note)
        } catch (error) {
          if (!(error instanceof JiraWorkUnconfirmed)) throw error
          return { ...attempt.confirm(await readDestination(destination)), message: 'The audit note may be missing from Jira.' }
        }
        return attempt.confirm(await readDestination(destination))
      }
      const destination = (issue: Issue) => {
        const blocker = input.verb === 'Block' ? Boolean(this.blocker(issue)) : this.externalPresent(issue) || this.nativeBlockers(issue).length > 0
        return checkJiraTransition({ ...issue, blocker }, input)
      }
      const response = await this.request(`issue/${id}/transitions`)
      const current = await this.read(id)
      const to = destination(current)
      const candidates = response.transitions?.filter((candidate: Record<string, any>) => candidate.name === input.verb && candidate.to?.name === to && candidate.isAvailable !== false)
      if (candidates?.length !== 1 || !nativeId(candidates[0]?.id)) throw new JiraWorkInputError('Jira does not offer the requested named transition to that status')
      if (beforeWrite) await beforeWrite(this.view(current))
      await attempt.dispatch()
      await this.request(`issue/${id}/transitions`, 'POST', { transition: { id: candidates[0].id } }).catch(error => {
        if (!note || isWriteRejection(error)) throw error
      })
      const saved = await readDestination(to)
      if (!note) return attempt.confirm(saved)
      if (!await this.postTransitionAudit(id, note, deferAudit)) {
        throw new JiraWorkUnconfirmed('Jira ticket was canceled before the audit comment could be posted')
      }
      return attempt.confirm(await readDestination(to))
    }, !!handoffPreflight, handoffPreflight)
  }

  private async resolveLinkTarget(key: string, signal?: AbortSignal) {
    const target = await this.request(`issue/${key}?fields=project`, 'GET', undefined, signal)
    if (!nativeId(target.id) || typeof target.key !== 'string' || !nativeId(target.fields?.project?.id)) {
      throw new JiraWorkInputError('Jira did not resolve the link target identity')
    }
    return { id: target.id, key: target.key, projectId: target.fields.project.id }
  }

  private async writeLink(path: string, method: 'POST' | 'DELETE', body?: unknown) {
    const response = await this.response(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    await response.body?.cancel()
  }

  link(input: JiraLink, actor: string) {
    return this.mutate('link', input, actor, async attempt => {
      const id = this.id(input.card_id)
      let card = await this.read(id)
      if (input.action === 'remove') {
        if (!input.link_id || input.target_key || input.type || input.direction) throw new JiraWorkInputError('Remove requires only the link ID from this ticket')
        const present = card.links.some(link => link.id === input.link_id)
        if (attempt.dispatched) {
          if (present) throw new JiraWorkUnconfirmed('Jira has not confirmed removal of the link')
          return attempt.confirm(card)
        }
        if (!present) throw new JiraWorkInputError('This ticket does not have that link ID')
        await attempt.dispatch()
        await this.writeLink(`issueLink/${input.link_id}`, 'DELETE')
        card = await this.read(id)
        if (card.links.some(link => link.id === input.link_id)) throw new JiraWorkUnconfirmed('Jira has not confirmed removal of the link')
        return attempt.confirm(card)
      }
      if (!input.target_key || !input.type || !input.direction || input.link_id) {
        throw new JiraWorkInputError('Add requires target_key, native link type and direction as shown from this ticket')
      }
      const target = await this.resolveLinkTarget(input.target_key)
      if (target.id === id) throw new JiraWorkInputError('Choose another Jira issue')
      const matches = (issue: Issue) => issue.links.some(link => link.target_id === target.id && link.type === input.type && link.direction === input.direction)
      if (!attempt.dispatched && !matches(card)) {
        const types = await this.request('issueLinkType')
        const type = types.issueLinkTypes?.find((candidate: Record<string, any>) => candidate.name === input.type)
        if (!nativeId(type?.id) || typeof type[input.direction] !== 'string') throw new JiraWorkInputError('Choose an available native Jira link type')
        if (type.id === this.config.blocksLinkTypeId) {
          if (input.direction === 'inward' && this.blocker(card)) {
            throw new JiraWorkInputError('Clear the current primary blocker before adding another')
          }
          if (input.direction === 'outward' && target.projectId === this.config.projectId &&
            this.blocker(await this.read(target.id))) {
            throw new JiraWorkInputError('Clear the current primary blocker before adding another')
          }
        }
        await attempt.dispatch()
        const pair = input.direction === 'inward'
          ? { inwardIssue: { key: target.key }, outwardIssue: { id } }
          : { inwardIssue: { id }, outwardIssue: { key: target.key } }
        await this.writeLink('issueLink', 'POST', { ...pair, type: { id: type.id } })
        card = await this.read(id)
      }
      if (!matches(card)) throw new JiraWorkUnconfirmed('Jira has not confirmed the requested link')
      return attempt.confirm(card)
    })
  }
}

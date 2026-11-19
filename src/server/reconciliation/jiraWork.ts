import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquireLock } from '../infra/lock'
import type { JiraWorkConfig } from './config'
import { adfText, JiraClient, JiraWriteError, jiraText } from './jira'
import {
  checkJiraTransition, editJiraDecisions, formatJiraDecisions, jiraWorkIdentity, JiraWorkInputError, readJiraDecisions,
  type JiraCreate, type JiraEdit, type JiraExternalBlocker, type JiraLink, type JiraTransition,
} from './jiraWorkRules'
import { CreationReceipts, type JiraWorkReceiptState } from './workflowReceipts'

const createProperty = 'tinstar.work.create'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const signature = (verb: string, input: object) => digest(JSON.stringify([verb, input], (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value))
const nativeId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d*$/.test(id)
function text(value: unknown) {
  if (typeof value === 'string') return value
  return adfText(value, true)
}
class JiraWorkUnconfirmed extends Error {}
type Link = { id: string; type_id: string; type: string; label: string; direction: 'inward' | 'outward'; target_id: string; target_key: string }
type Issue = {
  id: string; issue_id: string; key: string; url: string; project_id: string; issue_type: string; status: string; name: string;
  description: string; owner: string | null; decisions: string; decisionDocument: any; updated_at: string; links: Link[];
  externalBlocker: { type: string | null; target: string; unblocks_when: string };
}
type Attempt = {
  marker: string
  signature: string
  prior?: Awaited<ReturnType<CreationReceipts['get']>>
  begin: (linkChange?: JiraWorkReceiptState['linkChange']) => Promise<void>
  identify: (cardId: string) => Promise<void>
  confirm: (card: Issue) => Promise<unknown>
}
type WriteInput = JiraCreate | JiraEdit | JiraTransition | JiraLink

/** Native Jira work records share Tin Star's MCP and Jira transport. This
 * adapter only calls issue APIs and has no dispatch or Jira admin capability. */
export class JiraWork extends JiraClient {
  private readonly receipts: CreationReceipts
  private readonly site: string
  constructor(private readonly config: JiraWorkConfig, private readonly root: string, fetcher?: (input: string, init?: RequestInit) => Promise<Response>) {
    super(`https://api.atlassian.com/ex/jira/${config.cloudId}`, `Bearer ${config.token}`, fetcher)
    this.site = new URL(config.url).hostname
    this.receipts = new CreationReceipts(root)
  }

  private qualified(id: string) { return `jira:${this.site}:${this.config.projectId}:${id}` }

  private id(cardId: string) {
    const id = jiraWorkIdentity(cardId)
    if (id?.site !== this.site || id.projectId !== this.config.projectId) throw new JiraWorkInputError('Ticket is outside the configured Jira site and project')
    return id.issueId
  }

  private async read(id: string): Promise<Issue> {
    const fields = ['summary', 'project', 'issuetype', 'status', 'description', 'updated', 'issuelinks', ...Object.values(this.config.fields)]
    const raw = await this.request(`issue/${id}?fields=${fields.join(',')}`)
    const f = raw.fields
    if (!nativeId(raw.id) || raw.id !== id || f?.project?.id !== this.config.projectId || typeof raw.key !== 'string') {
      throw new JiraWorkInputError('Jira readback did not confirm the configured issue identity and project')
    }
    if (!Object.values(this.config.issueTypes).includes(f.issuetype?.id) || typeof f.status?.name !== 'string' || typeof f.summary !== 'string' ||
      typeof f.updated !== 'string' || !Array.isArray(f.issuelinks) || Object.values(this.config.fields).some(field => !Object.hasOwn(f, field))) {
      throw new Error('Incomplete Jira work readback')
    }
    const links = f.issuelinks.map((link: Record<string, any>): Link => {
      const direction = link.inwardIssue ? 'inward' : 'outward'
      const target = link[direction + 'Issue']
      if (!nativeId(link.id) || !nativeId(link.type?.id) || !nativeId(target?.id) || typeof target.key !== 'string') throw new Error('Incomplete Jira issue link readback')
      return { id: link.id, type_id: link.type.id, type: link.type.name, label: link.type[direction], direction, target_id: target.id, target_key: target.key }
    })
    const { owner, decisions, blockerType, blockerTarget, blockerCondition } = this.config.fields
    return {
      id: this.qualified(id), issue_id: id, key: raw.key, url: `${this.config.url}/browse/${encodeURIComponent(raw.key)}`,
      project_id: this.config.projectId, issue_type: f.issuetype.id === this.config.issueTypes.Task ? 'Task' : 'Epic',
      name: f.summary, status: f.status.name, updated_at: f.updated, owner: f[owner]?.value ?? null,
      description: text(f.description), decisions: text(f[decisions]), decisionDocument: f[decisions], links,
      externalBlocker: { type: f[blockerType]?.value ?? null, target: text(f[blockerTarget]), unblocks_when: text(f[blockerCondition]) },
    }
  }

  private nativeBlockers(issue: Issue) {
    return issue.links.filter(link => link.direction === 'inward' && link.type_id === this.config.blocksLinkTypeId)
  }

  private externalPresent(issue: Issue) {
    return Object.values(issue.externalBlocker).some(Boolean)
  }

  private blocker(issue: Issue) {
    const native = this.nativeBlockers(issue)
    const external = issue.externalBlocker
    const count = native.length + Number(this.externalPresent(issue))
    if (count > 1) throw new JiraWorkInputError('Jira has multiple primary blockers; choose one before transitioning')
    if (native.length) return { type: 'Jira' as const, link: native[0]! }
    if (!count) return null
    if ((external.type !== 'Actor' && external.type !== 'Event') || !/^\S+$/.test(external.target) || !external.unblocks_when.trim()) {
      throw new JiraWorkInputError('Correct the external blocker type, identifier and unblock condition')
    }
    return external as JiraExternalBlocker
  }

  private view(issue: Issue) {
    const { decisions, decisionDocument: _document, externalBlocker, ...card } = issue
    let decision_questions, blocker
    const warnings: string[] = []
    try { decision_questions = readJiraDecisions(decisions) } catch (error) { warnings.push((error as Error).message) }
    try { blocker = this.blocker(issue) } catch (error) { warnings.push((error as Error).message) }
    return { ...card, decision_questions, decision_text: decisions, blocker,
      ...(blocker === undefined ? { external_blocker_fields: externalBlocker } : {}), ...(warnings.length ? { warnings } : {}) }
  }

  private async notes(issueId: string, startAt = 0) {
    const body = await this.request(`issue/${issueId}/comment?startAt=${startAt}&maxResults=50&orderBy=-created`)
    if (!Array.isArray(body.comments) || !Number.isInteger(body.total) || body.startAt !== startAt) throw new Error('Incomplete Jira comment readback')
    return { comments: body.comments.map((comment: Record<string, any>) => ({
      id: comment.id, body: comment.visibility == null ? text(comment.body) : undefined, created_at: comment.created, author_id: comment.author?.accountId,
    })), total: body.total as number }
  }

  async get(cardId: string, details: boolean) {
    try {
      const card = this.view(await this.read(this.id(cardId)))
      if (!details) return { outcome: 'available', card }
      try {
        const page = await this.notes(card.issue_id)
        return { outcome: 'available', card, comments: page.comments, more_comments: page.total > page.comments.length }
      } catch { return { outcome: 'available', card, warnings: ['Jira comments could not be read'] } }
    } catch (error) { return { outcome: 'unavailable', message: this.message(error) } }
  }

  private message(error: unknown) {
    if (error instanceof JiraWorkInputError || error instanceof JiraWorkUnconfirmed) return error.message
    if (error instanceof JiraWriteError) return `Jira returned HTTP ${error.status}`
    return 'Jira request, response or retry record unavailable'
  }

  private saved(issue: Issue, already = false) {
    return { outcome: 'saved', code: already ? 'already-saved' : 'confirmed', card: this.view(issue) }
  }

  private async mutate(verb: string, input: WriteInput, actor: string, run: (attempt: Attempt) => Promise<unknown>) {
    const key = JSON.stringify(['jira-work', this.config.cloudId, this.config.projectId, actor, input.operation_id])
    const marker = `tinstar.work.${digest(key)}`
    const hash = signature(verb, input)
    let pending = false
    let begun = false
    let cardId = 'card_id' in input ? input.card_id : undefined
    let unlock: Awaited<ReturnType<typeof acquireLock>> | undefined
    try {
      if (cardId) this.id(cardId)
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      // Link and blocker edits share a lock so two local callers cannot create
      // conflicting primaries or overwrite an answer derived from the same read.
      unlock = await acquireLock(join(this.root, 'jira-work-writes.lock'))
      const prior = await this.receipts.get(key)
      if (prior && prior.input !== hash) throw new JiraWorkInputError('Operation ID was used for different input; use a new ID')
      cardId = prior?.cardId ?? cardId
      pending = Boolean(prior)
      if (prior?.jiraWork?.confirmed && cardId) return this.saved(await this.read(this.id(cardId)), true)
      const persist = async (confirmed: boolean, state: JiraWorkReceiptState = {}) => {
        await this.receipts.putJiraWork(key, hash, cardId, { ...state, ...(confirmed ? { confirmed: true } : {}) })
      }
      return await run({
        marker, signature: hash, prior,
        begin: async linkChange => {
          await persist(false, { startedAt: prior?.jiraWork?.startedAt ?? Date.now(), linkChange })
          pending = true
          begun = true
        },
        identify: async id => {
          cardId = id
          await persist(false)
        },
        confirm: async card => {
          cardId = card.id
          await persist(true)
          return this.saved(card, Boolean(prior))
        },
      })
    } catch (error) {
      if (begun && error instanceof JiraWriteError && error.method !== 'GET' && error.status >= 400 && error.status < 500 && error.status !== 408) {
        // An explicit rejection can be retried. A lost/ambiguous response is
        // reconciled from Jira before a mutation may be reported as saved.
        try { await this.receipts.remove(key); pending = false } catch { /* preserve uncertain state */ }
      }
      return { outcome: pending ? 'partially-saved' : 'not-saved',
        code: pending ? 'unconfirmed' : error instanceof JiraWorkInputError ? 'invalid-work' : 'jira-unavailable',
        operation_id: input.operation_id, ...(cardId ? { card_id: cardId } : {}), message: this.message(error) }
    } finally { await unlock?.() }
  }

  private transitionAudit(input: JiraTransition, actor: string) {
    const details = [
      input.reason && `Reason: ${input.reason}`, input.evidence && `Evidence: ${input.evidence}`,
      input.disposition && `Disposition: ${input.disposition}`, input.live_revision && `Live revision: ${input.live_revision}`,
    ].filter(Boolean)
    return details.length ? [`${input.verb} via Tin Star (${actor})`, ...details].join('\n') : undefined
  }

  private writeBody(attempt: Attempt, note?: string) {
    return {
      properties: [{ key: attempt.marker, value: attempt.signature }],
      ...(note ? { update: { comment: [{ add: { body: jiraText(`${note}\n\nTin Star receipt: ${attempt.marker}`) } }] } } : {}),
    }
  }

  private async checkReceipt(id: string, attempt: Attempt, note?: string) {
    try {
      const stored = await this.request(`issue/${id}/properties/${attempt.marker}`)
      if (stored.value !== attempt.signature) throw new JiraWorkUnconfirmed('Jira has not confirmed the write receipt')
    } catch (error) {
      if (error instanceof JiraWriteError && error.status === 404) return false
      throw error
    }
    if (note) {
      const expected = `${note}\n\nTin Star receipt: ${attempt.marker}`
      for (let start = 0; ; ) {
        const page = await this.notes(id, start)
        if (page.comments.some((comment: { body: string }) => comment.body === expected)) return true
        start += page.comments.length
        if (!page.comments.length || start >= page.total || start >= 500) break
      }
      throw new JiraWorkUnconfirmed('Jira did not confirm the requested comment')
    }
    return true
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

  create(input: JiraCreate, actor: string) {
    return this.mutate('create', input, actor, async attempt => {
      const issueType = input.issue_type ?? 'Task'
      const typeId = this.config.issueTypes[issueType]
      if (!typeId) throw new JiraWorkInputError(`Jira ${issueType} is not configured`)
      const stamp = attempt.marker
      let id = attempt.prior?.cardId ? this.id(attempt.prior.cardId) : attempt.prior ? await this.findCreated(stamp) : undefined
      const recovered = id !== undefined
      if (!id) {
        await attempt.begin()
        const result = await this.request('issue', 'POST', {
          fields: {
            project: { id: this.config.projectId }, issuetype: { id: typeId }, summary: input.name,
            ...(input.description ? { description: jiraText(input.description) } : {}),
            ...(input.owner ? { [this.config.fields.owner]: { value: input.owner } } : {}),
          },
          properties: [{ key: createProperty, value: stamp }],
        })
        if (!nativeId(result.id)) throw new JiraWorkUnconfirmed('Jira creation returned no immutable issue ID')
        id = result.id
        await attempt.identify(this.qualified(id))
      }
      const issue = await this.read(id)
      if (!recovered && (issue.issue_type !== issueType || issue.status !== 'Backlog' || issue.name !== input.name ||
        issue.description !== (input.description ?? '') || issue.owner !== (input.owner ?? null))) {
        throw new JiraWorkUnconfirmed('Jira creation readback differs from the requested ticket or Backlog default')
      }
      const source = await this.request(`issue/${id}/properties/${createProperty}`)
      if (source.value !== stamp) throw new JiraWorkUnconfirmed('Jira did not confirm the creation receipt')
      return attempt.confirm(issue)
    })
  }

  private checkEdit(issue: Issue, input: JiraEdit) {
    const equal = (actual: unknown, expected: unknown) => expected === undefined || isDeepStrictEqual(actual, expected)
    const questions = input.add_questions || input.answers ? readJiraDecisions(issue.decisions) : []
    const contains = (id: string, key: 'answer' | 'question' | 'options', value: unknown) =>
      equal(questions.find(question => question.id === id)?.[key], value)
    const blocker = input.blocker === undefined ? undefined : input.blocker ?? { type: null, target: '', unblocks_when: '' }
    if (!equal(issue.name, input.name) || !equal(issue.description, input.description === null ? '' : input.description) ||
      !equal(issue.owner, input.owner) || !equal(issue.externalBlocker, blocker) ||
      input.add_questions?.some(question => !contains(question.id, 'question', question.question) || !contains(question.id, 'options', question.options?.length ? question.options : undefined)) ||
      input.answers?.some(answer => !contains(answer.id, 'answer', answer.answer))) {
      throw new JiraWorkUnconfirmed('Jira field readback differs from the requested edit')
    }
  }

  private editDecisionDocument(issue: Issue, input: JiraEdit) {
    const desired = readJiraDecisions(editJiraDecisions(issue.decisions, input))
    const original = issue.decisionDocument
    if (original == null || typeof original === 'string') return jiraText(formatJiraDecisions(desired))
    const nodes: unknown[] = original.content ?? []
    const answers = new Set(input.answers?.map(answer => answer.id))
    const content: unknown[] = []
    for (let index = 0; index < nodes.length; ) {
      const node = nodes[index++]
      const headings = [...text(node).matchAll(/^D[1-9]\d*(?= \[)/gm)].map(match => match[0])
      const id = headings[0]
      if (!headings.some(heading => answers.has(heading))) {
        content.push(node)
        continue
      }
      if (headings.length !== 1 || !text(node).startsWith(id!)) {
        throw new JiraWorkInputError('Put each Decision question on its own Jira paragraph before answering it')
      }
      while (index < nodes.length && !/^D[1-9]\d* \[/m.test(text(nodes[index]))) index++
      const following = index
      while (index > 0 && text(nodes[index - 1]) === '') index--
      content.push(...jiraText(formatJiraDecisions(desired.filter(item => item.id === id))).content, ...nodes.slice(index, following))
      index = following
    }
    const added = new Set(input.add_questions?.map(question => question.id))
    if (added.size) content.push(...jiraText(formatJiraDecisions(desired.filter(item => added.has(item.id)))).content)
    return { ...original, content }
  }

  edit(input: JiraEdit, actor: string) {
    return this.mutate('edit', input, actor, async attempt => {
      const id = this.id(input.card_id)
      const note = input.note ? `${input.note}\n\nRecorded via Tin Star (${actor})` : undefined
      if (attempt.prior && await this.checkReceipt(id, attempt, note)) return attempt.confirm(await this.read(id))
      const current = await this.read(id)
      if (input.description !== undefined && !input.description?.trim() && current.status === 'Queued') {
        throw new JiraWorkInputError('Return this ticket to To Do before clearing its instructions and success condition')
      }
      if (input.owner === null && !['Backlog', 'Done', 'Canceled'].includes(current.status)) throw new JiraWorkInputError('Owner is required while the ticket is in a work status')
      if (input.blocker && this.nativeBlockers(current).length) throw new JiraWorkInputError('Remove the native Jira blocker before choosing an external blocker')
      const mapping = this.config.fields
      const fields: Record<string, unknown> = {}
      if (input.name !== undefined) fields.summary = input.name
      if (input.owner !== undefined) fields[mapping.owner] = input.owner === null ? null : { value: input.owner }
      if (input.description !== undefined) fields.description = input.description === null ? null : jiraText(input.description)
      if (input.blocker !== undefined) {
        fields[mapping.blockerType] = input.blocker ? { value: input.blocker.type } : null
        fields[mapping.blockerTarget] = input.blocker?.target ?? null
        fields[mapping.blockerCondition] = input.blocker ? jiraText(input.blocker.unblocks_when) : null
      }
      if (input.add_questions || input.answers) fields[mapping.decisions] = this.editDecisionDocument(current, input)
      if (Object.keys(fields).length === 0 && !note) throw new JiraWorkInputError('Supply a ticket edit or comment')
      await attempt.begin()
      await this.request(`issue/${id}`, 'PUT', { fields, ...this.writeBody(attempt, note) })
      const saved = await this.read(id)
      if (!await this.checkReceipt(id, attempt, note)) throw new JiraWorkUnconfirmed('Jira did not confirm the edit receipt')
      this.checkEdit(saved, input)
      if (fields[mapping.decisions] && saved.decisions !== text(fields[mapping.decisions])) {
        throw new JiraWorkUnconfirmed('Jira did not confirm the full Decision Questions field')
      }
      return attempt.confirm(saved)
    })
  }

  transition(input: JiraTransition, actor: string) {
    return this.mutate('transition', input, actor, async attempt => {
      const id = this.id(input.card_id)
      const note = this.transitionAudit(input, actor)
      if (attempt.prior && await this.checkReceipt(id, attempt, note)) return attempt.confirm(await this.read(id))
      const current = await this.read(id)
      const blocker = input.verb === 'Block' ? Boolean(this.blocker(current)) : this.externalPresent(current) || this.nativeBlockers(current).length > 0
      const to = checkJiraTransition({ ...current, blocker }, input)
      const response = await this.request(`issue/${id}/transitions`)
      const candidates = response.transitions?.filter((candidate: Record<string, any>) => candidate.name === input.verb && candidate.to?.name === to && candidate.isAvailable !== false)
      if (candidates?.length !== 1 || !nativeId(candidates[0]?.id)) throw new JiraWorkInputError('Jira does not offer the requested named transition to that status')
      await attempt.begin()
      await this.request(`issue/${id}/transitions`, 'POST', { transition: { id: candidates[0].id }, ...this.writeBody(attempt, note) })
      const saved = await this.read(id)
      if (!await this.checkReceipt(id, attempt, note)) throw new JiraWorkUnconfirmed('Jira did not confirm the transition receipt')
      if (saved.status !== to) throw new JiraWorkUnconfirmed('Jira did not confirm the requested destination status')
      return attempt.confirm(saved)
    })
  }

  private async linkInHistory(id: string, action: JiraLink['action'], attempt: Attempt) {
    const receipt = attempt.prior?.jiraWork
    if (!receipt?.startedAt || !receipt.linkChange) return false
    const { targetKey, targetId, label } = receipt.linkChange
    const { accountId } = await this.request('myself')
    if (typeof accountId !== 'string' || !accountId) throw new Error('Missing Jira service account identity')
    const [side, opposite] = action === 'add' ? ['to', 'from'] : ['from', 'to']
    for (let startAt = 0; ; ) {
      const page = await this.request(`issue/${id}/changelog?startAt=${startAt}&maxResults=100`)
      if (page.startAt !== startAt || !Array.isArray(page.values)) throw new Error('Incomplete Jira changelog')
      for (const change of page.values) {
        if (change.author?.accountId !== accountId || !(Date.parse(change.created) >= receipt.startedAt)) continue
        if (!Array.isArray(change.items)) throw new Error('Incomplete Jira changelog items')
        if (change.items.some((item: Record<string, unknown>) =>
          (item.fieldId === 'issuelinks' || item.field === 'Link') &&
          item[opposite] == null && item[opposite + 'String'] == null &&
          (item[side] == null || item[side] === targetId || item[side] === targetKey) &&
          item[side + 'String'] === `This issue ${label} ${targetKey}`)) return true
      }
      if (page.isLast === true) return false
      if (!page.values.length) throw new Error('Incomplete Jira changelog pagination')
      startAt += page.values.length
    }
  }

  private async writeLink(path: string, method: 'POST' | 'DELETE', body?: unknown) {
    const response = await this.response(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    await response.body?.cancel()
  }

  link(input: JiraLink, actor: string) {
    return this.mutate('link', input, actor, async attempt => {
      const id = this.id(input.card_id)
      let card = await this.read(id)
      if (await this.linkInHistory(id, input.action, attempt)) return attempt.confirm(card)
      if (input.action === 'remove') {
        if (!input.link_id || input.target_key || input.type || input.direction) throw new JiraWorkInputError('Remove requires only the link ID from this ticket')
        const link = card.links.find(link => link.id === input.link_id)
        if (!link) throw new JiraWorkInputError('This ticket does not have that link ID')
        await attempt.begin({ targetId: link.target_id, targetKey: link.target_key, label: link.label })
        await this.writeLink(`issueLink/${input.link_id}`, 'DELETE')
        card = await this.read(id)
        if (card.links.some(link => link.id === input.link_id)) throw new JiraWorkUnconfirmed('Jira has not confirmed removal of the link')
        return attempt.confirm(card)
      }
      if (!input.target_key || !input.type || !input.direction || input.link_id) {
        throw new JiraWorkInputError('Add requires target_key, native link type and direction as shown from this ticket')
      }
      const target = await this.request(`issue/${attempt.prior?.jiraWork?.linkChange?.targetId ?? input.target_key}?fields=project`)
      if (!nativeId(target.id) || target.id === id || typeof target.key !== 'string') throw new JiraWorkInputError('Choose another visible Jira issue')
      const matches = (issue: Issue) => issue.links.some(link => link.target_id === target.id && link.type === input.type && link.direction === input.direction)
      if (!matches(card)) {
        const types = await this.request('issueLinkType')
        const type = types.issueLinkTypes?.find((candidate: Record<string, any>) => candidate.name === input.type)
        if (!nativeId(type?.id) || typeof type[input.direction] !== 'string') throw new JiraWorkInputError('Choose an available native Jira link type')
        if (type.id === this.config.blocksLinkTypeId) {
          const blocked = input.direction === 'inward' ? card : target.fields?.project?.id === this.config.projectId ? await this.read(target.id) : null
          if (blocked && this.blocker(blocked)) throw new JiraWorkInputError('Clear the current primary blocker before adding another')
        }
        await attempt.begin({ targetId: target.id, targetKey: target.key, label: type[input.direction] })
        const pair = input.direction === 'inward'
          ? { inwardIssue: { id: target.id }, outwardIssue: { id } }
          : { inwardIssue: { id }, outwardIssue: { id: target.id } }
        await this.writeLink('issueLink', 'POST', { ...pair, type: { id: type.id } })
        card = await this.read(id)
      }
      if (!matches(card)) throw new JiraWorkUnconfirmed('Jira has not confirmed the requested link')
      return attempt.confirm(card)
    })
  }
}

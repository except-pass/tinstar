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
import { CreationReceipts, type JiraFieldChange, type JiraWorkReceiptState } from './workflowReceipts'

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
type Link = { id: string; type_id: string; type: string; label: string; direction: 'inward' | 'outward'; target_key: string }
type Issue = {
  id: string; issue_id: string; key: string; url: string; project_id: string; issue_type: string; status: string; name: string;
  description: string; owner: string | null; decisions: string; decisionDocument: any; updated_at: string; links: Link[];
  externalBlocker: { type: string | null; target: string; unblocks_when: string };
}
type Attempt = {
  key: string
  marker: string
  prior?: Awaited<ReturnType<CreationReceipts['get']>>
  state: JiraWorkReceiptState
  dispatched: boolean
  dispatch: (evidence?: Pick<JiraWorkReceiptState, 'fields' | 'link' | 'priorCommentIds' | 'commentHash' | 'sourceKey'>) => Promise<void>
  contradict: () => Promise<void>
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

  private async checkProject(id: string) {
    const issue = await this.request(`issue/${id}?fields=project`)
    if (issue.id !== id || issue.fields?.project?.id !== this.config.projectId) {
      throw new JiraWorkInputError('Ticket is outside the configured Jira project')
    }
  }

  private async read(id: string, allowOtherTypes = false): Promise<Issue> {
    await this.checkProject(id)
    const fields = ['summary', 'project', 'issuetype', 'status', 'description', 'updated', 'issuelinks', ...Object.values(this.config.fields)]
    const raw = await this.request(`issue/${id}?fields=${fields.join(',')}`)
    const f = raw.fields
    if (!nativeId(raw.id) || raw.id !== id || f?.project?.id !== this.config.projectId || typeof raw.key !== 'string') {
      throw new JiraWorkInputError('Jira readback did not confirm the configured issue identity and project')
    }
    const issueType = Object.entries(this.config.issueTypes).find(([, typeId]) => typeId === f.issuetype?.id)?.[0]
    if ((!issueType && (!allowOtherTypes || !nativeId(f.issuetype?.id))) || typeof f.status?.name !== 'string' || typeof f.summary !== 'string' ||
      typeof f.updated !== 'string' || !Array.isArray(f.issuelinks) || Object.values(this.config.fields).some(field => !Object.hasOwn(f, field))) {
      throw new Error('Incomplete Jira work readback')
    }
    const links = f.issuelinks.map((link: Record<string, any>): Link => {
      const direction = link.inwardIssue ? 'inward' : 'outward'
      const target = link[direction + 'Issue']
      if (!nativeId(link.id) || !nativeId(link.type?.id) || typeof target?.key !== 'string') throw new Error('Incomplete Jira issue link readback')
      return { id: link.id, type_id: link.type.id, type: link.type.name, label: link.type[direction], direction, target_key: target.key }
    })
    const { owner, decisions, blockerType, blockerTarget, blockerCondition } = this.config.fields
    return {
      id: this.qualified(id), issue_id: id, key: raw.key, url: `${this.config.url}/browse/${encodeURIComponent(raw.key)}`,
      project_id: this.config.projectId, issue_type: issueType ?? f.issuetype.name ?? f.issuetype.id,
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
    await this.checkProject(issueId)
    const body = await this.request(`issue/${issueId}/comment?startAt=${startAt}&maxResults=50&orderBy=-created`)
    if (!Array.isArray(body.comments) || !Number.isInteger(body.total) || body.startAt !== startAt) throw new Error('Incomplete Jira comment readback')
    await this.checkProject(issueId)
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
    let sent = false
    let state: JiraWorkReceiptState = {}
    const rejection = (status: number) => ({
      outcome: 'not-saved', code: 'jira-unavailable', operation_id: input.operation_id, message: `Jira returned HTTP ${status}`,
    })
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
      state = prior?.jiraWork ?? {}
      pending = state.dispatchedAt !== undefined
      if (state.confirmed && cardId) {
        pending = true
        return this.saved(await this.read(this.id(cardId), verb === 'create'), true)
      }
      if (state.rejected) return rejection(state.rejected)
      const dispatched = pending
      const persist = () => this.receipts.putJiraWork(key, hash, cardId, state)
      if (!prior) await persist()
      return await run({
        key, marker, prior, state, dispatched,
        dispatch: async evidence => {
          Object.assign(state, evidence, { dispatchedAt: Date.now() })
          await persist()
          pending = true
          sent = true
        },
        contradict: async () => {
          state.contradicted = true
          await persist()
        },
        identify: async id => {
          cardId = id
          await persist()
        },
        confirm: async card => {
          cardId = card.id
          state.confirmed = true
          await persist()
          return this.saved(card, dispatched)
        },
      })
    } catch (error) {
      if (sent && error instanceof JiraWriteError && error.method !== 'GET' && error.status >= 400 && error.status < 500 && error.status !== 408) {
        await this.receipts.putJiraWork(key, hash, cardId, { ...state, rejected: error.status })
        return rejection(error.status)
      }
      return { outcome: pending ? 'partially-saved' : 'not-saved',
        code: pending ? 'unconfirmed' : error instanceof JiraWorkInputError ? 'invalid-work' : 'jira-unavailable',
        operation_id: input.operation_id, ...(cardId ? { card_id: cardId } : {}), message: pending ? `Jira may or may not have applied the operation. Check Jira. ${this.message(error)}` : this.message(error) }
    } finally { await unlock?.() }
  }

  private transitionAudit(input: JiraTransition, actor: string) {
    const details = [
      input.reason && `Reason: ${input.reason}`, input.evidence && `Evidence: ${input.evidence}`,
      input.disposition && `Disposition: ${input.disposition}`, input.verb === 'Deployed' && input.live_revision && `Live revision: ${input.live_revision}`,
    ].filter(Boolean)
    return details.length ? [`${input.verb} via Tin Star (${actor})`, ...details].join('\n') : undefined
  }

  private commentUpdate(note?: string) {
    return note ? { update: { comment: [{ add: { body: jiraText(note) } }] } } : {}
  }

  private async checkComment(id: string, note: string | undefined, attempt: Attempt, evidence?: { accountId: string; from: number; before: number }) {
    if (!note) return
    const { dispatchedAt, priorCommentIds, commentHash } = attempt.state
    if (!dispatchedAt || !priorCommentIds || !commentHash) throw new JiraWorkUnconfirmed('Jira receipt lacks a comment baseline')
    const prefix = JSON.stringify(['jira-work', this.config.cloudId, this.config.projectId]).slice(0, -1) + ','
    const ambiguous = (await this.receipts.entries(prefix)).some(([key, receipt]) => {
      const other = receipt.jiraWork
      return key !== attempt.key && receipt.cardId === this.qualified(id) && other?.dispatchedAt &&
        other.dispatchedAt <= dispatchedAt && !other.confirmed && !other.rejected && other.commentHash === commentHash
    })
    if (ambiguous) throw new JiraWorkUnconfirmed('Jira comment may belong to another unresolved operation')
    const page = await this.notes(id)
    if (!page.comments.some(comment => !priorCommentIds.includes(comment.id) && comment.body === note &&
      (!evidence || (comment.author_id === evidence.accountId &&
        Date.parse(comment.created_at) >= evidence.from && Date.parse(comment.created_at) < evidence.before)))) {
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

  create(input: JiraCreate, actor: string) {
    return this.mutate('create', input, actor, async attempt => {
      const issueType = input.issue_type ?? 'Task'
      const typeId = this.config.issueTypes[issueType]
      if (!typeId) throw new JiraWorkInputError(`Jira ${issueType} is not configured`)
      const stamp = attempt.marker
      if (attempt.state.contradicted) throw new JiraWorkUnconfirmed('Original Jira creation readback contradicted the request')
      let id = attempt.prior?.cardId ? this.id(attempt.prior.cardId) : undefined
      if (attempt.dispatched) {
        id ??= await this.findCreated(stamp)
        if (!id) throw new JiraWorkUnconfirmed('Jira search did not find the operation property')
      } else {
        await attempt.dispatch()
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
      const issue = await this.read(id, true)
      if (!attempt.dispatched && (issue.issue_type !== issueType || issue.status !== 'Backlog' || issue.name !== input.name ||
        issue.description !== (input.description ?? '') || issue.owner !== (input.owner ?? null))) {
        await attempt.contradict()
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
      if (!edits.some(edit => edit.start <= start + text(node).length && edit.end >= start)) return [node]
      if (node.type === 'text') {
        const end = start + node.text.length
        const replacement = edits.find(edit => !edit.answer && edit.start < end && edit.end > start)
        const insertion = edits.find(edit => edit.answer && edit.start !== blockAnswer && edit.start > start && edit.start <= end)
        const slice = (until: number) => replacement
          ? node.text.slice(0, Math.max(0, replacement.start - start)) +
            (replacement.start >= start ? 'Answered' : '') + node.text.slice(replacement.end - start, until)
          : node.text.slice(0, until)
        if (insertion) {
          const before = slice(insertion.start - start)
          const after = node.text.slice(insertion.start - start)
          return [{ ...node, text: before }, ...insertion.answer!.flatMap(line => [{ type: 'hardBreak' }, line]),
            ...(after ? [{ ...node, text: after }] : [])]
        }
        const value = slice(node.text.length)
        return value ? [value === node.text ? node : { ...node, text: value }] : []
      }
      if (!Array.isArray(node.content)) {
        const insertion = edits.find(edit => edit.answer && edit.start !== blockAnswer && edit.start === start + text(node).length)
        return insertion ? [node, ...insertion.answer!.flatMap(line => [{ type: 'hardBreak' }, line])] : [node]
      }
      let offset = start
      const separator = ['paragraph', 'heading', 'codeBlock'].includes(node.type) ? 0 : 1
      const content = node.content.flatMap((child: unknown) => {
        const end = offset + text(child).length
        const answer = node.type === 'doc' ? edits.find(edit => edit.answer && edit.start === end) : undefined
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

  edit(input: JiraEdit, actor: string) {
    return this.mutate('edit', input, actor, async attempt => {
      const id = this.id(input.card_id)
      const note = input.note ? `${input.note}\n\nRecorded via Tin Star (${actor})` : undefined
      if (attempt.dispatched) return this.recover(id, attempt, note)
      const comments = note ? (await this.notes(id)).comments.map(comment => comment.id) : undefined
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
      const previous = {
        summary: current.name, description: current.description, [mapping.owner]: current.owner,
        [mapping.decisions]: current.decisions, [mapping.blockerType]: current.externalBlocker.type,
        [mapping.blockerTarget]: current.externalBlocker.target, [mapping.blockerCondition]: current.externalBlocker.unblocks_when,
      }
      const changes = Object.entries(fields).map(([field, value]) => ({
        field, before: previous[field] ?? '',
        after: text(value && typeof value === 'object' && 'value' in value ? value.value : value),
      })).filter(change => change.before !== change.after)
      await attempt.dispatch({ fields: changes, priorCommentIds: comments, commentHash: note ? digest(note) : undefined })
      await this.request(`issue/${id}`, 'PUT', { fields, ...this.commentUpdate(note) })
      const saved = await this.read(id)
      await this.checkComment(id, note, attempt)
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
      if (attempt.dispatched) return this.recover(id, attempt, note)
      const current = await this.read(id)
      const blocker = input.verb === 'Block' ? Boolean(this.blocker(current)) : this.externalPresent(current) || this.nativeBlockers(current).length > 0
      const to = checkJiraTransition({ ...current, blocker }, input)
      const response = await this.request(`issue/${id}/transitions`)
      const candidates = response.transitions?.filter((candidate: Record<string, any>) => candidate.name === input.verb && candidate.to?.name === to && candidate.isAvailable !== false)
      if (candidates?.length !== 1 || !nativeId(candidates[0]?.id)) throw new JiraWorkInputError('Jira does not offer the requested named transition to that status')
      const comments = note ? (await this.notes(id)).comments.map(comment => comment.id) : undefined
      await attempt.dispatch({ fields: [{ field: 'status', before: current.status, after: to }], priorCommentIds: comments, commentHash: note ? digest(note) : undefined })
      await this.request(`issue/${id}/transitions`, 'POST', { transition: { id: candidates[0].id }, ...this.commentUpdate(note) })
      const saved = await this.read(id)
      await this.checkComment(id, note, attempt)
      if (saved.status !== to) throw new JiraWorkUnconfirmed('Jira did not confirm the requested destination status')
      return attempt.confirm(saved)
    })
  }

  private fieldMatches(item: Record<string, unknown>, change: JiraFieldChange) {
    const field = item.fieldId ?? (item.fieldtype === 'jira' ? item.field : undefined)
    const valueMatches = (side: 'from' | 'to', expected: string) =>
      item[side + 'String'] === expected || (expected === '' && item[side + 'String'] === null && item[side] == null)
    return field === change.field && valueMatches('from', change.before) && valueMatches('to', change.after)
  }

  private async recover(id: string, attempt: Attempt, note?: string) {
    const { dispatchedAt, fields, link } = attempt.state
    if (!dispatchedAt || (!fields?.length && !link)) throw new JiraWorkUnconfirmed('Jira history cannot verify this operation')
    const card = await this.read(id)
    const { accountId } = await this.request('myself')
    if (typeof accountId !== 'string' || !accountId) throw new Error('Missing Jira service account identity')
    const types = link && !link.id ? (await this.request('issueLinkType')).issueLinkTypes : undefined
    const directions = ['inward', 'outward'] as const
    const labels = types?.flatMap((type: Record<string, unknown>) => directions
      .filter(direction => type[direction] === link?.label).map(direction => ({ typeId: type.id, direction })))
    const linkMatches = (item: Record<string, unknown>) => {
      if (!link || (item.fieldId !== 'issuelinks' && item.field !== 'Link')) return false
      if (link.id) return item.fromLinkId === link.id && item.to == null && item.toString == null
      return item.from == null && item.fromString == null &&
        labels?.length === 1 && labels[0].typeId === link.typeId && labels[0].direction === link.direction &&
        (item.to == null || item.to === link.targetKey || nativeId(item.to)) &&
        item.toString === `This issue ${link.label} ${link.targetKey}`
    }
    const prefix = JSON.stringify(['jira-work', this.config.cloudId, this.config.projectId]).slice(0, -1) + ','
    const candidates = (await this.receipts.entries(prefix)).filter(([key, receipt]) => {
      const other = receipt.jiraWork
      return key !== attempt.key && other?.dispatchedAt && !other.rejected &&
        (other.dispatchedAt >= dispatchedAt || !other.confirmed)
    })
    const competing = candidates.filter(([, receipt]) => {
      const other = receipt.jiraWork?.link
      if (link) {
        if (!other) return false
        if (link.id || other.id) return Boolean(link.id && link.id === other.id)
        if (link.typeId !== other.typeId) return false
        return (receipt.cardId === card.id && other.targetKey === link.targetKey && other.direction === link.direction) ||
          (receipt.jiraWork?.sourceKey === link.targetKey && other.targetKey === card.key && other.direction !== link.direction)
      }
      return receipt.cardId === card.id && receipt.jiraWork?.fields?.some(other =>
        fields?.some(field => isDeepStrictEqual(field, other)))
    })
    for (let startAt = 0; ; ) {
      const page = await this.request(`issue/${id}/changelog?startAt=${startAt}&maxResults=100`)
      if (page.startAt !== startAt || !Array.isArray(page.values)) throw new Error('Incomplete Jira changelog')
      for (const change of page.values) {
        const time = Date.parse(change.created)
        if (change.author?.accountId !== accountId || !(time >= dispatchedAt) ||
          competing.some(([, receipt]) => receipt.jiraWork!.dispatchedAt! <= time)) continue
        if (!Array.isArray(change.items)) throw new Error('Incomplete Jira changelog items')
        const items = change.items as Record<string, unknown>[]
        if (link ? items.some(linkMatches) : fields!.every(field => items.some(item => this.fieldMatches(item, field)))) {
          const nextCommentWrite = Math.min(...candidates.filter(([, receipt]) =>
            receipt.cardId === card.id && receipt.jiraWork?.priorCommentIds && receipt.jiraWork.dispatchedAt! > dispatchedAt).map(([, receipt]) => receipt.jiraWork!.dispatchedAt!))
          await this.checkComment(id, note, attempt, { accountId, from: dispatchedAt, before: nextCommentWrite })
          return attempt.confirm(card)
        }
      }
      if (page.isLast === true) throw new JiraWorkUnconfirmed('Jira history did not confirm the dispatched operation')
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
      if (attempt.dispatched) return this.recover(id, attempt)
      let card = await this.read(id)
      if (input.action === 'remove') {
        if (!input.link_id || input.target_key || input.type || input.direction) throw new JiraWorkInputError('Remove requires only the link ID from this ticket')
        const link = card.links.find(link => link.id === input.link_id)
        if (!link) throw new JiraWorkInputError('This ticket does not have that link ID')
        await attempt.dispatch({ link: { id: link.id, typeId: link.type_id, direction: link.direction, targetKey: link.target_key, label: link.label } })
        await this.writeLink(`issueLink/${input.link_id}`, 'DELETE')
        card = await this.read(id)
        if (card.links.some(link => link.id === input.link_id)) throw new JiraWorkUnconfirmed('Jira has not confirmed removal of the link')
        return attempt.confirm(card)
      }
      if (!input.target_key || !input.type || !input.direction || input.link_id) {
        throw new JiraWorkInputError('Add requires target_key, native link type and direction as shown from this ticket')
      }
      const targetKey = input.target_key
      if (targetKey === card.key) throw new JiraWorkInputError('Choose another Jira issue')
      const matches = (issue: Issue) => issue.links.some(link => link.target_key === targetKey && link.type === input.type && link.direction === input.direction)
      if (!matches(card)) {
        const types = await this.request('issueLinkType')
        const type = types.issueLinkTypes?.find((candidate: Record<string, any>) => candidate.name === input.type)
        if (!nativeId(type?.id) || typeof type[input.direction] !== 'string') throw new JiraWorkInputError('Choose an available native Jira link type')
        if (type.id === this.config.blocksLinkTypeId) {
          if (input.direction === 'inward' && this.blocker(card)) {
            throw new JiraWorkInputError('Clear the current primary blocker before adding another')
          }
          if (input.direction === 'outward' && targetKey.startsWith(card.key.slice(0, card.key.lastIndexOf('-') + 1))) {
            const result = await this.request('search/jql', 'POST', {
              jql: `project = ${this.config.projectId} AND key = "${targetKey}"`, fields: ['project'], maxResults: 2,
            })
            const target = result.issues?.find((issue: Record<string, any>) => issue.key === targetKey &&
              issue.fields?.project?.id === this.config.projectId && nativeId(issue.id))
            if (!target || target.id === id) throw new JiraWorkInputError('Choose another issue in the configured Jira project')
            if (this.blocker(await this.read(target.id))) throw new JiraWorkInputError('Clear the current primary blocker before adding another')
          }
        }
        await attempt.dispatch({ sourceKey: card.key, link: { typeId: type.id, direction: input.direction, targetKey, label: type[input.direction] } })
        const pair = input.direction === 'inward'
          ? { inwardIssue: { key: targetKey }, outwardIssue: { id } }
          : { inwardIssue: { id }, outwardIssue: { key: targetKey } }
        await this.writeLink('issueLink', 'POST', { ...pair, type: { id: type.id } })
        card = await this.read(id)
      }
      if (!matches(card)) throw new JiraWorkUnconfirmed('Jira has not confirmed the requested link')
      return attempt.confirm(card)
    })
  }
}

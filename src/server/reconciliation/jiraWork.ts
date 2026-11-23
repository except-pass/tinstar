import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquireLock } from '../infra/lock'
import type { JiraWorkConfig } from './config'
import { adfText, JiraClient, JiraWriteError, jiraText } from './jira'
import {
  checkJiraTransition, editJiraDecisions, formatJiraDecisions, jiraTransitionDestination, jiraWorkIdentity, JiraWorkInputError, readJiraDecisions,
  type JiraCreate, type JiraEdit, type JiraExternalBlocker, type JiraLink, type JiraTransition,
} from './jiraWorkRules'
import { CreationReceipts } from './workflowReceipts'
import { tswKey, tswProjectId } from './tswSnapshot'

const createProperty = 'tinstar.work.create'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const nativeId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d*$/.test(id)
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
  description: string; instructionText: string; owner: string | null; decisions: string; decisionDocument: any; updated_at: string; links: Link[];
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
type BeforeWrite = (current: JiraWorkCard) => void

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
    const fields = ['summary', 'project', 'issuetype', 'status', 'description', 'assignee', 'updated', 'issuelinks', ...Object.values(this.config.fields)]
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
      if (!nativeId(link.id) || !nativeId(link.type?.id) || !nativeId(target?.id) || typeof target.key !== 'string') throw new Error('Incomplete Jira issue link readback')
      return { id: link.id, type_id: link.type.id, type: link.type.name, label: link.type[direction], direction, target_key: target.key, target_id: target.id }
    })
    const { owner, decisions, blockerType, blockerTarget, blockerCondition } = this.config.fields
    return {
      id: this.qualified(id), issue_id: id, key: raw.key, url: `${this.config.url}/browse/${encodeURIComponent(raw.key)}`,
      project_id: this.config.projectId, issue_type: issueType ?? f.issuetype.name ?? f.issuetype.id,
      name: f.summary, status: f.status.name, updated_at: f.updated, owner: f[owner]?.value ?? null,
      assignee: f.assignee?.displayName ?? null, assignee_id: f.assignee?.accountId ?? null,
      description: text(f.description), instructionText: text(f.description, 'omit'), decisions: text(f[decisions]), decisionDocument: f[decisions], links,
      blockerConditionText: text(f[blockerCondition], 'omit'),
      externalBlocker: { type: f[blockerType]?.value ?? null, target: text(f[blockerTarget]), unblocks_when: text(f[blockerCondition]) },
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

  private async notes(issueId: string) {
    await this.checkProject(issueId)
    const body = await this.request(`issue/${issueId}/comment?startAt=0&maxResults=50&orderBy=-created`)
    if (!Array.isArray(body.comments) || !Number.isInteger(body.total) || body.startAt !== 0) throw new Error('Incomplete Jira comment readback')
    await this.checkProject(issueId)
    return { comments: body.comments.map((comment: Record<string, any>) => ({
      id: comment.id, body: comment.visibility == null ? text(comment.body) : undefined, created_at: comment.created, updated_at: comment.updated, author_id: comment.author?.accountId,
    })), total: body.total as number }
  }

  async get(cardId: string, details: boolean) {
    try {
      const card = this.view(await this.read(this.id(cardId)))
      if (!details) return { outcome: 'available', card }
      try {
        const page = await this.notes(card.issue_id)
        return { outcome: 'available', card, comments: page.comments.map(({ updated_at: _updated, ...comment }) => comment), more_comments: page.total > page.comments.length }
      } catch { return { outcome: 'available', card, warnings: ['Jira comments could not be read'] } }
    } catch (error) { return { outcome: 'unavailable', message: this.message(error) } }
  }

  async readTswCard(key: string) {
    if (this.config.projectId !== tswProjectId || !tswKey(key)) throw new JiraWorkInputError('Status sync requires an exact TSW issue key')
    const target = await this.resolveLinkTarget(key)
    if (target.key !== key || target.projectId !== tswProjectId) throw new JiraWorkInputError('Jira key no longer identifies this TSW issue')
    const issue = await this.read(target.id)
    if (issue.key !== key) throw new JiraWorkInputError('Jira key changed while reading the TSW issue')
    return this.view(issue)
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
    let pending = false
    let sent = false
    const cardId = 'card_id' in input ? input.card_id : undefined
    let unlock: Awaited<ReturnType<typeof acquireLock>> | undefined
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      // Link and blocker edits share a lock so two local callers cannot create
      // conflicting primaries or overwrite an answer derived from the same read.
      unlock = await acquireLock(join(this.root, 'jira-work-writes.lock'))
      const prior = await this.receipts.get(key)
      if (prior && prior.input !== verb) throw new JiraWorkInputError('Operation ID was used for another operation kind')
      if (prior?.jiraWork?.outcome) return prior.jiraWork.outcome
      const dispatched = prior?.jiraWork?.dispatched === true
      pending = dispatched
      if (!prior) await this.receipts.putJiraWork(key, verb, false)
      return await run({
        marker, dispatched,
        dispatch: async () => {
          await this.receipts.putJiraWork(key, verb, true)
          pending = true
          sent = true
        },
        confirm: card => this.saved(card, dispatched),
      })
    } catch (error) {
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

  private async serviceAccountId(): Promise<string> {
    const { accountId } = await this.request('myself')
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
    const matching = page.comments.filter(comment => {
      const createdAt = Date.parse(comment.created_at)
      if (comment.body !== note || comment.author_id !== accountId) return false
      return !expected || (!expected.ids.includes(comment.id) && createdAt === Date.parse(comment.updated_at) && createdAt >= expected.time)
    })
    if (expected ? matching.length !== 1 : matching.length === 0) {
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
      return attempt.confirm(issue)
    })
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
      if (beforeWrite) beforeWrite(this.view(await this.read(id)))
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

  private async postTransitionAudit(id: string, note: string, deferAudit: boolean) {
    const baseline = await this.commentBaseline(id).catch(() => undefined)
    await this.checkProject(id)
    const posted = await this.request(`issue/${id}/comment`, 'POST', { body: jiraText(note) }).catch(error => {
      if (isWriteRejection(error)) {
        const Rejected = deferAudit ? JiraWorkUnconfirmed : JiraAuditRejected
        throw new Rejected(`Jira confirmed the destination status but rejected the audit comment (HTTP ${error.status}).`)
      }
      return undefined
    })
    const expected = nativeId(posted?.id) ? posted.id : baseline
    if (!expected) throw new JiraWorkUnconfirmed('Jira did not confirm the requested comment')
    await this.checkComment(id, note, expected)
  }

  async repairTransitionAudit(input: JiraTransition, actor: string) {
    return this.mutate('transition', input, actor, async attempt => {
      const note = this.transitionAudit(input, actor)
      if (!attempt.dispatched || !note) throw new JiraWorkInputError('No dispatched transition audit to repair')
      const id = this.id(input.card_id)
      try {
        await this.checkComment(id, note)
      } catch (error) {
        if (!(error instanceof JiraWorkUnconfirmed)) throw error
        await this.postTransitionAudit(id, note, true)
      }
      return attempt.confirm(await this.read(id))
    })
  }

  transition(input: JiraTransition, actor: string, beforeWrite?: BeforeWrite, deferAudit = false) {
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
      const current = await this.read(id)
      const blocker = input.verb === 'Block' ? Boolean(this.blocker(current)) : this.externalPresent(current) || this.nativeBlockers(current).length > 0
      const to = checkJiraTransition({ ...current, blocker }, input)
      const response = await this.request(`issue/${id}/transitions`)
      const candidates = response.transitions?.filter((candidate: Record<string, any>) => candidate.name === input.verb && candidate.to?.name === to && candidate.isAvailable !== false)
      if (candidates?.length !== 1 || !nativeId(candidates[0]?.id)) throw new JiraWorkInputError('Jira does not offer the requested named transition to that status')
      if (beforeWrite) beforeWrite(this.view(await this.read(id)))
      await attempt.dispatch()
      await this.request(`issue/${id}/transitions`, 'POST', { transition: { id: candidates[0].id } }).catch(error => {
        if (!note || isWriteRejection(error)) throw error
      })
      const saved = await readDestination(to)
      if (!note) return attempt.confirm(saved)
      await this.postTransitionAudit(id, note, deferAudit)
      return attempt.confirm(await readDestination(to))
    })
  }

  private async resolveLinkTarget(key: string) {
    const target = await this.request(`issue/${key}?fields=project`)
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

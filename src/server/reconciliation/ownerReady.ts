import { firstMateRequestSchema, requestAnchor } from '../../shared/deskSource'
import type { OwnerReadyRead, OwnerRequestSource, OwnerMergeAsk, OwnerDecisionAsk } from '../../shared/ownerReady'
import { inventoryPullState, type PullsRead } from '../../shared/pulls'
import { releasePull } from '../../shared/pullIdentity'
import { cardSourceUrl, isJiraCard } from '../../shared/workIdentity'
import { decisionRecordRows, decisionRequests, withdrawnDecisionIds } from '../../shared/workflowRequests'
import type { SourceSnapshot } from '.'
import { hasUnverifiedRetractions, requestHistory, type CardContextRead } from './cardContext'
import { deferredDecisionCard } from './claimPolicy'
import { dispatchForTask } from './dispatchProvenance'
import type { JiraWork } from './jiraWork'
import { declaredRepository, mergePublication, readyHeadPublication, repositoryPublication, requestedHead } from './ownerRequestEvidence'
import { buildQueue } from './queue'
import type { PullReadiness } from './queuePulls'
import { tswEvidence } from './tswSnapshot'
import { jiraWorkReadback } from './workReadback'

type JiraRead = Awaited<ReturnType<JiraWork['ownerRequests']['get']>>
type Bundle = OwnerReadyRead['repositories'][number]
type Card = NonNullable<SourceSnapshot['intentions']['data']>['cards'][number]
const current = (status: string) => status === 'fresh' || status === 'partial'
const tags = (card: Card) => {
  const value = card.properties['Will action']?.value
  return (Array.isArray(value) ? value : [value]).flatMap(tag => typeof tag === 'string' ? [tag.toLowerCase().trim()] : [])
}
export const ownerCards = (snapshot: SourceSnapshot) => (snapshot.intentions.data?.cards ?? []).filter(card =>
  !card.archived && !card.in_trash && !deferredDecisionCard(card) && tags(card).length > 0)
const first = <T>(values: T[]) => {
  const unique = [...new Set(values)]
  return unique.length === 1 ? unique[0]! : null
}
const addSource = <T extends OwnerRequestSource>(items: T[], source: T) => {
  if (!items.some(item => item.kind === source.kind && item.id === source.id)) items.push(source)
}
const cardPull = (card: Card) => first(['Link', 'Evidence'].flatMap(name => {
  const value = card.properties[name]?.value
  const pull = typeof value === 'string' && releasePull(value)
  return pull ? [pull.url] : []
}))

/** Derive current work on demand. Grouping never writes source records or
 * acknowledges an ask. PR identity groups merge asks, while decision identity
 * remains scoped to its own record (even when those records share a card). */
export function ownerReadyRequests(snapshot: SourceSnapshot, histories: Map<string, CardContextRead>, jira?: JiraRead): OwnerReadyRead {
  const warnings: string[] = []
  const groups = new Map<string | null, Bundle>()
  const merges = new Map<string, OwnerMergeAsk>()
  const incompleteJiraPulls = new Set<string>()
  const decisions = new Map<string, { ask: OwnerDecisionAsk; repositories: string[] }>()
  const group = (repository: string | null) => {
    let value = groups.get(repository)
    if (!value) { value = { repository, merges: [], decisions: [] }; groups.set(repository, value) }
    return value
  }
  const addMerge = (source: OwnerRequestSource, url: string | null, head: string | null, fresh: boolean) => {
    const pull = url ? releasePull(url) : null
    const id = pull?.id ?? JSON.stringify([source.kind, source.id])
    let ask = merges.get(id)
    if (!ask) {
      ask = { url: pull?.url ?? null, requestedHeads: [], unverifiedRequest: true, fresh: false, sources: [] }
      merges.set(id, ask)
      group(pull?.repository ?? null).merges.push(ask)
    }
    addSource(ask.sources, { ...source, requestedHead: head })
    if (head && !ask.requestedHeads.includes(head)) ask.requestedHeads.push(head)
    if (head && fresh) ask.unverifiedRequest = false
    ask.fresh ||= fresh
  }
  const addDecision = (id: string, question: string, repository: string | null, fresh: boolean, source: OwnerRequestSource) => {
    let entry = decisions.get(id)
    if (!entry) {
      entry = { ask: { id, question, fresh, sources: [] }, repositories: [] }
      decisions.set(id, entry)
    }
    addSource(entry.ask.sources, source)
    if (repository) entry.repositories.push(repository)
    entry.ask.fresh ||= fresh
  }

  if (jira && jira.coverage !== 'complete') warnings.push(jira.error ?? 'Jira owner request coverage is partial.')
  if (!current(snapshot.intentions.status) || snapshot.intentions.coverage !== 'complete') warnings.push('Board request coverage is incomplete.')
  for (const { source, observation } of snapshot.fleet) if (observation.status !== 'fresh' || observation.coverage !== 'complete') {
    warnings.push(`Fleet coverage for ${source.label ?? source.home} is ${observation.status}/${observation.coverage}.`)
  }
  const fleetRows = snapshot.fleet.flatMap(({ source, observation }) => {
    const backlog = new Map(observation.data?.backlog?.map(row => [row.id, row]))
    return (observation.data?.tasks ?? []).filter(task => task.kind !== 'secondmate').map(task => ({
      home: source.home, task, row: backlog.get(task.backlog.id ?? task.id), fresh: current(observation.status),
    }))
  })
  const jiraIssues = new Map(jira?.data?.map(issue => [issue.key, issue]))
  const repositoriesByDispatch = new Map<string, string[]>()
  for (const { task, row, fresh } of fleetRows) {
    const repository = declaredRepository(row?.repo) ?? declaredRepository(task.project)
    if (!fresh || !repository) continue
    for (const dispatch of [dispatchForTask(task, row), dispatchForTask(task[tswEvidence] ?? {}, row?.[tswEvidence])]) {
      if (dispatch.status === 'card') {
        const known = repositoriesByDispatch.get(dispatch.cardId) ?? []
        known.push(repository)
        repositoriesByDispatch.set(dispatch.cardId, known)
      }
    }
  }
  for (const issue of jiraIssues.values()) {
    const fresh = !!jira && current(jira.status)
    if (issue.warning) warnings.push(`${issue.key} · ${issue.warning}`)
    const repository = issue.repository ?? first([...issue.merges.map(merge => merge.repository), ...(repositoriesByDispatch.get(issue.key) ?? [])])
    for (const decision of issue.decisions) {
      const id = JSON.stringify(['jira', issue.id, decision.id])
      addDecision(id, jiraWorkReadback(decision.question), repository, fresh, { kind: 'jira', id, label: `${issue.key} ${decision.id}`, url: issue.url })
    }
    for (const merge of issue.merges) {
      if (issue.notesUnavailable) incompleteJiraPulls.add(merge.id)
      const id = JSON.stringify([issue.id, merge.comment, merge.head])
      addMerge({ kind: 'jira', id, label: issue.key, url: `${issue.url}?focusedCommentId=${merge.comment}` },
        merge.url, merge.head, fresh && !issue.notesUnavailable && !merge.conditional)
    }
  }

  const boundRequests = new Map<string, string | null>()
  for (const card of ownerCards(snapshot)) {
    const history = histories.get(card.id)
    const historyVerified = history?.outcome === 'available' && !hasUnverifiedRetractions(history)
    if (!historyVerified) warnings.push('Some board request histories could not be verified.')
    const notes = history ? requestHistory(history.blocks) : []
    const actions = tags(card)
    const native = decisionRequests(notes, { multilineQuestion: true }).filter(request => request.requestedFrom?.trim().toLowerCase() === 'will')
    const repository = declaredRepository(card.properties.Repository?.value) ?? first(repositoriesByDispatch.get(card.id) ?? [])
    const fresh = historyVerified && current(snapshot.intentions.status) && !card.properties['Will action']?.hasMore
    const url = cardSourceUrl(card.id)
    const withdrawn = withdrawnDecisionIds(notes)
    const records = decisionRecordRows(notes, 'Tin Star request: ')
    const publishedActions = new Set(records.flatMap(record => typeof record?.action === 'string' ? [record.action.toLowerCase().trim()] : []))
    if (historyVerified) for (const record of records) {
      const source = firstMateRequestSchema.safeParse(record?.source_request)
      if (source.success && withdrawn.has(record.id)) {
        boundRequests.set(JSON.stringify([requestAnchor(source.data), record.source_question, record.source_spawn_gen ?? null]), null)
      }
    }
    for (const request of native) {
      const action = request.action.trim().toLowerCase()
      const id = JSON.stringify(['notion', card.id, request.id])
      // An exact request/generation/question binding can join witnesses.
      if (request.sourceRequest && historyVerified) {
        const binding = JSON.stringify([requestAnchor(request.sourceRequest), request.sourceQuestion, request.sourceSpawnGen ?? null])
        boundRequests.set(binding, request.answered ? null : id)
      }
      if (request.answered || !actions.includes(action)) continue
      const commentId = request.sourceId.replaceAll('-', '')
      const destination = !isJiraCard(card.id) && /^[a-f0-9]{32}$/i.test(commentId) ? `${url}#${commentId}` : null
      const source: OwnerRequestSource = { kind: 'notion', id, label: request.id, url: destination }
      const question = request.question ?? request.action
      if (action === 'merge') {
        const publication = mergePublication(question)
        addMerge(source, publication?.url ?? cardPull(card), publication?.head ?? null, fresh && publication?.conditional === false)
      } else {
        addDecision(id, question, repository ?? repositoryPublication(question), fresh, source)
      }
    }
    const action = card.properties['Next action']?.value ?? card.properties['Next Action']?.value
    if (actions.includes('merge') && !publishedActions.has('merge')) {
      const publication = typeof action === 'string' ? mergePublication(action) : null
      addMerge({ kind: 'notion', id: card.id, label: 'Merge action', url }, publication?.url ?? cardPull(card), publication?.head ?? null,
        fresh && publication?.conditional === false)
    }
    if (actions.includes('decision') && !publishedActions.has('decision') && typeof action === 'string' && action.trim() && !mergePublication(action)) {
      const id = JSON.stringify(['notion', card.id, 'Decision action'])
      addDecision(id, action, repository, fresh, { kind: 'notion', id, label: 'Decision action', url })
    }
  }

  const workers = new Map(fleetRows.map(row => [JSON.stringify([row.home, row.task.id]), row]))
  // Source-local readiness/response bindings come from the existing queue.
  // Its cross-source grouping alone is too broad to identify a decision.
  for (const item of buildQueue(snapshot).items) for (const source of item.sources) {
    if (!source.request?.home || source.request.id === null || !source.question || !source.responseAnchor || source.readiness === 'future-or-conditional') continue
    const { home, taskId } = source.request
    const worker = workers.get(JSON.stringify([home, taskId]))
    const binding = JSON.stringify([source.responseAnchor, source.question, source.generation ?? null])
    if (boundRequests.has(binding) && !boundRequests.get(binding)) continue
    const id = boundRequests.get(binding) ?? JSON.stringify([source.responseAnchor, source.generation ?? null])
    const record: OwnerRequestSource = { kind: 'firstmate', id: source.responseAnchor, label: source.request.id, url: worker?.task.recordUrl ?? null }
    const merge = mergePublication(source.question)
    const fresh = current(source.status)
    const repository = declaredRepository(worker?.row?.repo) ?? declaredRepository(worker?.task.project)
    if (merge) addMerge(record, merge.url, merge.head, fresh && !merge.conditional)
    else if (source.request.kind === 'decision') addDecision(id, source.question, repository, fresh, record)
  }

  for (const { task, row, home, fresh } of fleetRows) {
    if (!fresh || !task.identity.spawn_gen) continue
    const dispatch = dispatchForTask(task[tswEvidence] ?? {}, row?.[tswEvidence])
    const issue = dispatch.status === 'card' ? jiraIssues.get(dispatch.cardId) : undefined
    if (!issue || !current(jira?.status ?? '') || !issue.reviewAssigned || issue.notesUnavailable) continue
    // A registration can change while a Jira request remains open. Only the
    // snapshot's explicit publication, agreeing with its registered head and
    // ticket/URL, can attest the requested revision.
    const publication = readyHeadPublication(task.lastEventText ?? '')
    if (!publication?.head || publication.conditional || publication.head !== requestedHead(task.pr.head) ||
        publication.id !== releasePull(String(task.pr.url))?.id || !issue.merges.some(merge => merge.id === publication.id)) continue
    addMerge({ kind: 'firstmate', id: JSON.stringify([home, task.id, task.identity.spawn_gen]), label: `${issue.key} · worker publication`, url: task.recordUrl ?? null },
      publication.url, publication.head, fresh)
  }

  for (const [id, ask] of merges) if (incompleteJiraPulls.has(id)) ask.unverifiedRequest = true
  for (const { ask, repositories } of decisions.values()) group(first(repositories)).decisions.push(ask)
  return { observedAt: snapshot.generatedAt, repositories: [...groups.values()].sort((a, b) => (a.repository ?? '\uffff').localeCompare(b.repository ?? '\uffff')), warnings: [...new Set(warnings)] }
}

export function verifyOwnerMerges(read: OwnerReadyRead, inventory: PullsRead | null, states: ReadonlyMap<string, PullReadiness>) {
  const pulls = new Map(inventory?.pulls.filter(pull => pull.freshness === 'fresh').map(pull => [pull.id, pull]))
  for (const group of read.repositories) group.merges = group.merges.filter(merge => {
    if (!merge.url) return true
    const scope = inventoryPullState(merge.url, inventory)
    if (scope === 'not-open') return false
    const pull = scope === 'open' ? pulls.get(releasePull(merge.url)!.id) : undefined
    const observed = pull ? states.get(merge.url) : undefined
    const fresh = observed?.status === 'fresh' && (!observed.expiresAt || Date.parse(observed.expiresAt) > Date.now()) &&
      (!pull?.observedAt || Date.parse(observed.observedAt ?? '') >= Date.parse(pull.observedAt))
    if (fresh && (observed.state === 'merged' || observed.state === 'closed')) return false
    const liveHead = fresh ? observed.head : pull?.head ?? null
    const changed = !!liveHead && merge.requestedHeads.some(head => head !== liveHead)
    const ready = fresh && observed.state === 'open' && !observed.draft && observed.checks === 'passed' && observed.mergeability === 'ready'
    merge.live = { head: liveHead, observedAt: (fresh ? observed.observedAt : pull?.observedAt) ?? null,
      state: merge.unverifiedRequest ? 'unverified' : changed ? 'stale' : !fresh ? 'unverified' : ready ? 'ready' : 'pending' }
    return true
  })
  read.repositories = read.repositories.filter(group => group.merges.length || group.decisions.length)
  return read
}

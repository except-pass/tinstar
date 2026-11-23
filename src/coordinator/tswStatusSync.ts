import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { SourceSnapshot } from '../server/reconciliation'
import type { JiraHistoryCursor, JiraTrackedChange, JiraWork, JiraWorkCard } from '../server/reconciliation/jiraWork'
import { jiraTransitionDestination, JiraWorkInputError, type JiraEdit, type JiraTransition } from '../server/reconciliation/jiraWorkRules'
import { acquireLock } from '../server/infra/lock'
import { collectTswEvents, type StatusEvent } from './tswStatusEvents'

type Step = JiraTransition | JiraEdit
type CardState = Pick<JiraWorkCard, 'status' | 'assignee_id' | 'owner'>
type Pending = { eventId: string; input: Step; actor: string; before: CardState; unconfirmed?: number; retry?: boolean; sideIds?: string[] }
type Checkpoint = { cardId: string; cursor: JiraHistoryCursor; eventId: string; completed: string[]; pending?: Pending; statusVersion?: string; appliedSideIds?: string[]; preserveAssignee?: boolean }
type StatusAudit = { provider: 'jira'; time: string; cardId: string | null; result: string; home?: string; task?: string; eventId?: string; operationId?: string; detail?: string }
type Options = {
  jira?: Pick<JiraWork, 'readTswCard' | 'statusHistory' | 'edit' | 'transition' | 'findAssignableAccount'>
  apply: boolean; maxCards?: number; cards?: string[]; stateFile: string
  audit: (entry: StatusAudit) => Promise<void>
  now?: () => number
}

const reviewer = 'William Gathright'
const isEdit = (step: Step): step is JiraEdit => 'kind' in step
const attemptId = ({ input, retry }: Pending) => retry ? `${input.operation_id}-retry-1` : input.operation_id
const cardState = ({ status, assignee_id, owner }: JiraWorkCard): CardState => ({ status, assignee_id, owner })

function plan(event: StatusEvent, card: JiraWorkCard): Step[] | string {
  if (['Done', 'Canceled'].includes(card.status)) return 'terminal-card'
  if (card.status === event.target) return 'already-at-target'
  const queuedFrom = { Backlog: 'Fast-track', 'To Do': 'Queue' } as const
  const queue = queuedFrom[card.status as keyof typeof queuedFrom]
  const active = card.status === 'In Progress'
  const review = card.status === 'Ready for Review'
  if (!queue && card.status !== 'Queued' && !active && !(review && event.target === 'Done')) return 'preserve-current-status'
  if ((queue || card.status === 'Queued' && event.target !== 'Decision' && event.target !== 'Waiting For') && !card.description.trim()) {
    return 'missing-queue-or-start-instructions'
  }
  if (card.blocker === undefined) return 'current-blocker-unreadable'
  if (card.blocker && (event.target !== 'Waiting For' || !!queue || !isDeepStrictEqual(card.blocker, event.blocker))) {
    return 'preserve-current-blocker'
  }

  const steps: Step[] = []
  const base = { card_id: card.id }
  const edit = (label: string, input: Omit<JiraEdit, 'kind' | 'operation_id' | 'card_id'>) => {
    steps.push({ ...base, kind: 'jira_edit', operation_id: `edit-${label}`, ...input })
  }
  const move = (verb: 'Fast-track' | 'Queue' | 'Start' | 'Submit for Review' | 'Accept Final' | 'Complete Directly' | 'Request Decision' | 'Block') => {
    const transition = { ...base, operation_id: '', verb, evidence: event.evidence }
    const destination = jiraTransitionDestination(transition)!
    steps.push({ ...transition, operation_id: destination.toLowerCase().replaceAll(' ', '-') })
  }

  if (!card.owner) edit('owner', { owner: event.owner })
  if (queue) move(queue)
  if (event.target === 'Decision') {
    if (!card.decision_questions) return 'decision-questions-unreadable'
    const existing = card.decision_questions
    let next = Math.max(0, ...existing.map(question => Number(question.id.slice(1)))) + 1
    const requested = new Set(event.questions)
    const add = event.questions.filter(question => !existing.some(item => item.question === question))
    if (!add.length && !existing.some(item => requested.has(item.question) && item.answer === undefined)) return 'source-question-already-answered'
    edit('decision', { assignee: reviewer, ...(add.length ? { add_questions: add.map(question => ({ id: `D${next++}`, question })) } : {}) })
    move('Request Decision')
    return steps
  }
  if (event.target === 'Waiting For') {
    if (!card.blocker) edit('blocker', { blocker: event.blocker })
    move('Block')
    return steps
  }
  if (!active && !review) move('Start')
  if (event.target === 'Ready for Review') {
    edit('review', { assignee: reviewer, note: `Will: merge ${event.pull}` })
    move('Submit for Review')
  }
  if (event.target === 'Done') move(review ? 'Accept Final' : 'Complete Directly')
  return steps
}

async function loadState(file: string): Promise<Record<string, Checkpoint>> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid TSW sync state')
    return data as Record<string, Checkpoint>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function confirms(pending: Pending, card: JiraWorkCard, changes: JiraTrackedChange[]) {
  const { input, before } = pending
  const edit = isEdit(input)
  const status = edit ? before.status : jiraTransitionDestination(input)
  const owner = edit && input.owner !== undefined ? input.owner : before.owner
  const writesAssignee = edit && input.assignee !== undefined
  if (card.status !== status || card.owner !== owner || !writesAssignee && card.assignee_id !== before.assignee_id) return false
  if (edit && writesAssignee && (!card.assignee_id || card.assignee !== input.assignee)) return false
  // Every status or assignee change since the baseline must be explained by
  // this operation. A change followed by a reversal still protects the card.
  const expected = edit
    ? before.assignee_id === card.assignee_id ? [] : [{ field: 'assignee', from: before.assignee_id, to: card.assignee_id, byService: true }]
    : [{ field: 'status', from: before.status, to: status, byService: true }]
  return isDeepStrictEqual(changes.map(({ occurredAt: _occurredAt, entryId: _entryId, ...change }) => change), expected)
}

function statusVersion(changes: JiraTrackedChange[], previous?: string) {
  const change = [...changes].reverse().find(change => change.field === 'status')
  return change ? `${change.occurredAt ?? ''}:${change.entryId}` : previous
}

function identify(step: Step, event: StatusEvent, status: string, version?: string): Step {
  const identity = createHash('sha256').update(JSON.stringify([step.card_id, event.target, event.id, status, version])).digest('hex')
  return { ...step, operation_id: `tsw-${identity}-${step.operation_id}` }
}

/** One bounded TSW pass. The JSON checkpoint records the Jira change-history
 * position after each confirmed write, including intermediate workflow steps. */
export async function runTswStatusSync(fleet: SourceSnapshot['fleet'], options: Options) {
  const now = options.now ?? Date.now
  const { jira, apply, stateFile } = options
  const audits: StatusAudit[] = []
  const plans: Array<{ event: StatusEvent; from?: string; steps?: Step[] }> = []
  const allowed = (key: string) => !options.cards || options.cards.includes(key)
  const audit = async (key: string | null, result: string, details: Partial<StatusAudit> = {}) => {
    const entry = { provider: 'jira' as const, time: new Date(now()).toISOString(), cardId: key, result, ...details }
    await options.audit(entry)
    audits.push(entry)
  }
  if (apply && (!Number.isInteger(options.maxCards) || options.maxCards! < 1 || options.maxCards! > 5)) {
    throw new Error('--apply requires --max-cards between 1 and 5')
  }
  const unlock = apply && jira ? await acquireLock(`${stateFile}.lock`) : undefined
  let processed = 0
  let stopped = false
  try {
    const state = jira ? await loadState(stateFile) : {}
    const { events, findings } = collectTswEvents(fleet, now(), key => state[key]?.appliedSideIds ?? [])
    for (const finding of findings) if (!finding.key || allowed(finding.key)) {
      await audit(finding.key ?? null, finding.reason, { home: finding.home, task: finding.task })
    }
    if (!jira) {
      for (const event of events.filter(event => allowed(event.key))) {
        plans.push({ event })
        await audit(event.key, 'tsw-jira-unconfigured', { home: event.home, task: event.task, eventId: event.id })
      }
      return { plans, audits, stopped: false }
    }
    const save = async (key: string, value: Checkpoint) => {
      state[key] = value
      const temporary = `${stateFile}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      await rename(temporary, stateFile)
    }
    for (const event of events) {
      const { key, home, task, id: eventId } = event
      const log = (result: string, operationId?: string, detail?: string) => audit(key, result, { home, task, eventId, operationId, detail })
      if (!allowed(key)) continue
      if (apply && processed >= options.maxCards!) { await log('batch-limit'); continue }
      const previous = state[key]
      let card: JiraWorkCard
      try {
        card = await jira.readTswCard(key)
        if (['Done', 'Canceled'].includes(card.status) && !previous?.pending) { await log('terminal-card'); continue }
        if (previous && previous.cardId !== card.id) { await log('issue-identity-changed'); continue }
        let history = await jira.statusHistory(card.id, previous?.cursor)
        let checkpoint: Checkpoint = previous ?? { cardId: card.id, cursor: history.cursor, eventId, completed: [] }
        if (history.changes.length && (!checkpoint.pending || !confirms(checkpoint.pending, card, history.changes))) {
          const { pending: _pending, ...prior } = checkpoint
          const pending = checkpoint.pending
          const destination = pending && !isEdit(pending.input) ? jiraTransitionDestination(pending.input) : undefined
          const observedSideIds = pending?.sideIds && history.changes.some(change =>
            change.field === 'status' && change.byService && change.from === pending.before.status && change.to === destination)
            ? pending.sideIds : []
          checkpoint = { ...prior, cursor: history.cursor, statusVersion: statusVersion(history.changes, prior.statusVersion),
            appliedSideIds: [...new Set([...(prior.appliedSideIds ?? []), ...observedSideIds])],
            preserveAssignee: prior.preserveAssignee || history.changes.some(change => change.field === 'assignee') }
          history = { ...history, changes: [] }
          if (apply) await save(key, checkpoint)
          if ('sideIds' in event && event.sideIds.some(id => observedSideIds.includes(id))) {
            await log('side-request-already-applied')
            continue
          }
        }

        // A resumed operation may confirm its original write. If a newer source
        // event arrived, it may not issue the older operation's mutation.
        const execute = async (pending: Pending): Promise<boolean> => {
          const { input: original, actor } = pending
          const operation_id = attemptId(pending)
          const reference = `\nOperation: ${operation_id}`
          const input = isEdit(original)
            ? { ...original, operation_id, ...(original.note && { note: original.note + reference }) }
            : { ...original, operation_id, evidence: original.evidence + reference }
          const alreadyChanged = history.changes.length > 0 &&
            !(pending.retry && isEdit(input) && confirms(pending, card, history.changes))
          const expected = { ...cardState(card), updated_at: card.updated_at, id: card.id, key: card.key }
          const guard = (current: JiraWorkCard) => {
            if (alreadyChanged || pending.eventId !== eventId || ['Done', 'Canceled'].includes(current.status) || event.expiresAt && Date.parse(event.expiresAt) <= now() ||
              !isDeepStrictEqual(expected, { ...cardState(current), updated_at: current.updated_at, id: current.id, key: current.key })) {
              throw new JiraWorkInputError('TSW source or Jira ticket changed before the planned write')
            }
          }
          await log('write-planned', input.operation_id, 'evidence' in input ? input.evidence : undefined)
          const result = isEdit(input) ? await jira.edit(input, actor, guard) : await jira.transition(input, actor, guard)
          card = await jira.readTswCard(key)
          history = await jira.statusHistory(card.id, checkpoint.cursor)
          const outcome = result as { outcome: string; code?: string; message?: string }
          if (outcome.outcome === 'saved' && !outcome.message && card.id === checkpoint.cardId && confirms(pending, card, history.changes)) {
            const { pending: _pending, ...prior } = checkpoint
            checkpoint = { ...prior, cursor: history.cursor, eventId: pending.eventId,
              statusVersion: statusVersion(history.changes, prior.statusVersion),
              appliedSideIds: pending.sideIds ? [...new Set([...(prior.appliedSideIds ?? []), ...pending.sideIds])] : prior.appliedSideIds,
              completed: [...(checkpoint.eventId === pending.eventId ? checkpoint.completed : []), original.operation_id] }
            await save(key, checkpoint)
            await log('verified', input.operation_id, outcome.message)
            return true
          }
          const safeRetry = !history.changes.length && isDeepStrictEqual(cardState(card), pending.before) ||
            isEdit(input) && confirms(pending, card, history.changes)
          if (!history.changes.length && card.id === checkpoint.cardId) {
            if (pending.eventId !== eventId || outcome.outcome === 'not-saved' && !pending.retry) {
              const { pending: _pending, ...prior } = checkpoint
              checkpoint = prior
              await save(key, checkpoint)
              if (pending.eventId !== eventId) return true
            }
          }
          if (outcome.code === 'unconfirmed' && !pending.retry && safeRetry && card.id === checkpoint.cardId &&
            pending.eventId === eventId && (!event.expiresAt || Date.parse(event.expiresAt) > now())) {
            const unconfirmed = (pending.unconfirmed ?? 0) + 1
            const retry = unconfirmed >= 2
            const next = { ...pending, unconfirmed, retry }
            checkpoint = { ...checkpoint, pending: next }
            await save(key, checkpoint)
            if (retry) {
              await log('dispatch-retry', attemptId(next))
              return execute(next)
            }
          }
          const reason = outcome.outcome === 'saved' && outcome.message ? 'unconfirmed-evidence'
            : history.changes.length ? 'unconfirmed-status-or-assignee-change' : outcome.outcome
          await log(reason, input.operation_id, outcome.message)
          stopped = true
          return false
        }

        let resumed = false
        if (checkpoint.pending) {
          if (!apply) { await log('pending-write-needs-confirmation', attemptId(checkpoint.pending)); continue }
          processed++
          resumed = true
          if (!await execute(checkpoint.pending)) continue
        }
        const proposed = plan(event, card)
        if (typeof proposed === 'string') { await log(proposed); continue }
        const steps = proposed.filter(step => checkpoint.eventId !== eventId ||
          !checkpoint.completed.includes(identify(step, event, card.status, checkpoint.statusVersion).operation_id))
        if (!steps.length) { await log('event-already-applied'); continue }
        for (const [index, input] of steps.entries()) {
          if (!isEdit(input) || input.assignee !== reviewer) continue
          if (checkpoint.preserveAssignee || !await jira.findAssignableAccount(card.id, reviewer)) {
            await log(checkpoint.preserveAssignee ? 'preserve-owner-assignee' : 'reviewer-not-assignable', input.operation_id)
            const { assignee: _assignee, ...remaining } = input
            steps[index] = remaining
          }
        }
        const writes = steps.filter(step => !isEdit(step) || step.assignee !== undefined ||
          step.owner !== undefined || step.blocker !== undefined || step.note || step.add_questions?.length)
        plans.push({ event, from: card.status, steps: writes.map(step => identify(step, event, card.status, checkpoint.statusVersion)) })
        if (!apply) { await log('planned'); continue }
        if (!resumed) processed++
        for (const step of writes) {
          const input = identify(step, event, card.status, checkpoint.statusVersion)
          const sideIds = !isEdit(input) && 'sideIds' in event && jiraTransitionDestination(input) === event.target ? event.sideIds : undefined
          const pending = { eventId, input, actor: event.actor, before: cardState(card), sideIds }
          checkpoint = { ...checkpoint, cursor: history.cursor, pending }
          history = { ...history, changes: [] }
          await save(key, checkpoint)
          if (!await execute(pending)) break
        }
      } catch {
        // Transport errors and project mismatch can carry remote details. Keep
        // this audit safe while allowing other independently verified cards.
        await log('tsw-read-or-write-unavailable')
        stopped ||= apply
      }
    }
  } finally { await unlock?.() }
  return { plans, audits, stopped }
}

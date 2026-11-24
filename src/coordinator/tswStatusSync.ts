import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { SourceSnapshot } from '../server/reconciliation'
import type { JiraHistoryCursor, JiraTrackedChange, JiraWork, JiraWorkCard } from '../server/reconciliation/jiraWork'
import { jiraTransitionDestination, JiraWorkInputError, type JiraEdit, type JiraTransition } from '../server/reconciliation/jiraWorkRules'
import { acquireLock } from '../server/infra/lock'
import { collectTswEvents, type StatusEvent } from './tswStatusEvents'

type ReviewNote = Awaited<ReturnType<JiraWork['tswReviewNote']>>
type Edit = Parameters<JiraWork['edit']>[0]
type Step = JiraTransition | Edit
type CardState = Pick<JiraWorkCard, 'status' | 'assignee_id' | 'owner'>
type Pending = { eventId: string; target?: StatusEvent['target']; input: Step; actor: string; before: CardState; unconfirmed?: number; retry?: boolean; rejectedAttempts?: number }
type NoteRepair = { input: JiraTransition; actor: string; attempts: number; queuedAt?: number }
type Checkpoint = { cardId: string; cursor: JiraHistoryCursor; eventId: string; completed: string[]; pending?: Pending; noteRepairs?: NoteRepair[]; statusVersion?: string; preserveAssignee?: boolean; rejectedSteps?: Record<string, number>; handledEvents?: string[]; appliedEvents?: string[] }
type StatusAudit = { provider: 'jira'; time: string; cardId: string | null; result: string; home?: string; task?: string; eventId?: string; operationId?: string; detail?: string }
type Options = {
  jira?: Pick<JiraWork, 'readTswCard' | 'statusHistory' | 'tswReviewNote' | 'edit' | 'transition' | 'findAssignableAccount' | 'repairTransitionAudit'>
  apply: boolean; maxCards?: number; cards?: string[]; stateFile: string
  audit: (entry: StatusAudit) => Promise<void>
  now?: () => number
}

const linearVerbs = ['Fast-track', 'Queue', 'Start', 'Submit for Review', 'Accept Final', 'Complete Directly'] as const
const noteRepairLimit = 3
const stepAttemptLimit = 3
const reviewer = 'William Gathright'
const isEdit = (step: Step): step is Edit => 'kind' in step
function attemptId({ input, retry, rejectedAttempts = 0 }: Pending) {
  const id = rejectedAttempts ? `${input.operation_id}-attempt-${rejectedAttempts + 1}` : input.operation_id
  return retry ? `${id}-retry-1` : id
}
const cardState = ({ status, assignee_id, owner }: JiraWorkCard): CardState => ({ status, assignee_id, owner })

function reviewEdit(event: Extract<StatusEvent, { target: 'Ready for Review' }>, card: JiraWorkCard, existing: ReviewNote): Edit | undefined {
  const submitted = card.status === 'Ready for Review'
  if (submitted && (!existing || existing.head !== event.head)) return
  const publishers = [...new Set([
    ...(existing?.head === event.head ? existing?.publishers ?? [] : []),
    ...event.publishers ?? [],
  ])].sort()
  if (event.head && existing?.head === event.head && publishers.every(name => existing.publishers.includes(name))) return
  return {
    kind: 'jira_edit', card_id: card.id, operation_id: 'edit-review',
    note: `Will: merge ${event.pull}${event.head ? ` head ${event.head}\nPublishers: ${JSON.stringify(publishers)}` : ''}`,
    ...(existing ? { reviewComment: { id: existing.id, body: existing.body } } : { assignee: reviewer }),
  }
}

function plan(event: StatusEvent, card: JiraWorkCard, existing: ReviewNote): Step[] | string {
  if (['Done', 'Canceled'].includes(card.status)) return 'terminal-card'
  if (card.status === event.target) {
    const update = event.target === 'Ready for Review' && event.head && reviewEdit(event, card, existing)
    return update ? [update] : 'already-at-target'
  }
  const queuedFrom = { Backlog: 'Fast-track', 'To Do': 'Queue' } as const
  const queue = queuedFrom[card.status as keyof typeof queuedFrom]
  const active = card.status === 'In Progress'
  const review = card.status === 'Ready for Review'
  if (!queue && card.status !== 'Queued' && !active && !(review && event.target === 'Done')) return 'preserve-current-status'
  if ((queue || card.status === 'Queued') && !card.description.trim()) {
    return 'missing-queue-or-start-instructions'
  }
  if (card.blocker === undefined) return 'current-blocker-unreadable'
  if (card.blocker) return 'preserve-current-blocker'

  const steps: Step[] = []
  const base = { card_id: card.id }
  const edit = (label: string, input: Omit<JiraEdit, 'kind' | 'operation_id' | 'card_id'>) => {
    steps.push({ ...base, kind: 'jira_edit', operation_id: `edit-${label}`, ...input })
  }
  const move = (verb: typeof linearVerbs[number]) => {
    const transition = { ...base, operation_id: '', verb, evidence: event.evidence }
    const destination = jiraTransitionDestination(transition)!
    steps.push({ ...transition, operation_id: destination.toLowerCase().replaceAll(' ', '-') })
  }

  if (!card.owner) edit('owner', { owner: event.owner })
  if (queue) move(queue)
  // A review or completion PR also supplies evidence for an intermediate Start.
  if (!active && !review) move('Start')
  if (event.target === 'Ready for Review') {
    const update = reviewEdit(event, card, existing)
    if (update) steps.push(update)
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
  const identity = createHash('sha256').update(JSON.stringify([step.card_id, event.target, event.id, status, version,
    ...(isEdit(step) && step.reviewComment ? [step.note, step.reviewComment.id, step.reviewComment.body] : [])])).digest('hex')
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
    const { events, findings } = collectTswEvents(fleet, now())
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
    const repairs = Object.entries(state).flatMap(([key, checkpoint]) =>
      (checkpoint.noteRepairs ?? []).map(repair => ({ key, repair })))
      .sort((a, b) => (a.repair.queuedAt ?? 0) - (b.repair.queuedAt ?? 0))
    let lastQueuedAt = repairs.at(-1)?.repair.queuedAt ?? 0
    if (apply) {
      for (const { key, repair } of repairs.filter(({ key }) => allowed(key)).slice(0, options.maxCards!)) {
        const checkpoint = state[key]!
        const { operation_id: operationId } = repair.input
        const result = await (async () => {
          const card = await jira.readTswCard(key)
          if (card.id !== checkpoint.cardId || card.id !== repair.input.card_id) return { outcome: 'issue-identity-changed', dispatched: false }
          return jira.repairTransitionAudit(repair.input, repair.actor)
        })().catch(() => undefined)
        const repaired = result?.outcome === 'saved'
        const skipReason = result?.outcome === 'issue-identity-changed' || result?.outcome === 'card-canceled' ? result.outcome : undefined
        const attempts = repair.attempts + Number(result?.dispatched === true)
        const abandoned = !!skipReason || attempts >= noteRepairLimit
        if (!repaired && !abandoned && attempts === repair.attempts) {
          await audit(key, 'note-repair-pending', { operationId })
          continue
        }
        const noteRepairs = checkpoint.noteRepairs!.flatMap(entry =>
          entry !== repair ? [entry] : repaired || abandoned ? [] : [{ ...entry, attempts }])
        await save(key, { ...checkpoint, noteRepairs })
        await audit(key, repaired ? 'note-repaired' : abandoned ? 'note-repair-abandoned' : 'note-repair-pending', {
          operationId, ...(skipReason && { detail: skipReason }),
        })
      }
    }
    const byKey = new Map<string, StatusEvent | undefined>(events.map(event => [event.key, event]))
    for (const [key, checkpoint] of Object.entries(state)) {
      const input = checkpoint.pending?.input
      if (!byKey.has(key) && input && linearVerbs.some(verb => !isEdit(input) && input.verb === verb)) byKey.set(key, undefined)
    }
    for (const [key, event] of byKey) {
      const previous = state[key]
      const eventId = event?.id ?? previous?.pending?.eventId ?? ''
      const log = (result: string, operationId?: string, detail?: string) =>
        audit(key, result, { home: event?.home, task: event?.task, eventId, operationId, detail })
      if (!allowed(key)) continue
      if (apply && processed >= options.maxCards!) { await log('batch-limit'); continue }
      let card: JiraWorkCard
      try {
        card = await jira.readTswCard(key)
        if (['Done', 'Canceled'].includes(card.status) && !previous?.pending) { await log('terminal-card'); continue }
        if (previous && previous.cardId !== card.id) { await log('issue-identity-changed'); continue }
        let history = await jira.statusHistory(card.id, previous?.cursor)
        let checkpoint: Checkpoint = previous ?? { cardId: card.id, cursor: history.cursor, eventId, completed: [] }
        if (history.changes.length && (!checkpoint.pending || !confirms(checkpoint.pending, card, history.changes))) {
          const { pending, ...prior } = checkpoint
          const handledEvents = new Set(prior.handledEvents)
          if (prior.completed.length) handledEvents.add(prior.eventId)
          if (pending) handledEvents.add(pending.eventId)
          checkpoint = { ...prior, cursor: history.cursor, statusVersion: statusVersion(history.changes, prior.statusVersion),
            preserveAssignee: prior.preserveAssignee || history.changes.some(change => change.field === 'assignee'),
            handledEvents: [...handledEvents] }
          history = { ...history, changes: [] }
          if (apply) await save(key, checkpoint)
        }

        let resumed = false
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
          const submitting = !isEdit(input) && input.verb === 'Submit for Review'
          const reviewerId = submitting && !alreadyChanged && event?.id === pending.eventId
            ? await jira.findAssignableAccount(card.id, reviewer) : null
          let reviewerBlocked = false
          const guard = (current: JiraWorkCard) => {
            if (alreadyChanged || !event || pending.eventId !== event.id || ['Done', 'Canceled'].includes(current.status) || event.expiresAt && Date.parse(event.expiresAt) <= now() ||
              !isDeepStrictEqual(expected, { ...cardState(current), updated_at: current.updated_at, id: current.id, key: current.key })) {
              throw new JiraWorkInputError('TSW source or Jira ticket changed before the planned write')
            }
            if (submitting && (!reviewerId || current.assignee_id !== reviewerId || current.assignee !== reviewer)) {
              reviewerBlocked = true
              throw new JiraWorkInputError('TSW review requires the exact reviewer assignment')
            }
          }
          await log('write-planned', input.operation_id, 'evidence' in input ? input.evidence : undefined)
          const result = isEdit(input) ? await jira.edit(input, actor, guard) : await jira.transition(input, actor, guard, true)
          card = await jira.readTswCard(key)
          history = await jira.statusHistory(card.id, checkpoint.cursor)
          const outcome = result as { outcome: string; code?: string; message?: string; card_id?: string }
          const attempts = (pending.rejectedAttempts ?? 0) + 1 + Number(!!pending.retry)
          if (outcome.outcome === 'not-saved' && outcome.code === 'jira-unavailable' && outcome.card_id === undefined) {
            const { pending: _pending, ...prior } = checkpoint
            checkpoint = { ...prior, rejectedSteps: { ...prior.rejectedSteps, [original.operation_id]: attempts } }
            await save(key, checkpoint)
            await log(attempts >= stepAttemptLimit ? 'rejected-cap-reached' : 'write-rejected', operation_id, outcome.message)
            stopped = true
            return false
          }
          const verified = outcome.outcome === 'saved' && !outcome.message
          const missingNote = !isEdit(input) && (outcome.code === 'unconfirmed' || outcome.outcome === 'saved' && !!outcome.message)
          if ((verified || missingNote) && card.id === checkpoint.cardId && confirms(pending, card, history.changes)) {
            const { pending: _pending, ...prior } = checkpoint
            const appliedEvents = new Set(prior.appliedEvents)
            if (prior.eventId !== pending.eventId && prior.completed.length) appliedEvents.add(prior.eventId)
            const target = pending.target ?? (event?.id === pending.eventId ? event.target : undefined)
            if (card.status === target) appliedEvents.add(pending.eventId)
            if (missingNote) lastQueuedAt = Math.max(now(), lastQueuedAt + 1)
            checkpoint = { ...prior, cursor: history.cursor, eventId: pending.eventId,
              appliedEvents: [...appliedEvents].slice(-50),
              statusVersion: statusVersion(history.changes, prior.statusVersion),
              noteRepairs: missingNote ? [...(prior.noteRepairs ?? []), { input, actor, attempts: 0, queuedAt: lastQueuedAt }] : prior.noteRepairs,
              completed: [...(checkpoint.eventId === pending.eventId ? checkpoint.completed : []), original.operation_id] }
            await save(key, checkpoint)
            await log(missingNote ? 'landed-note-pending' : 'verified', input.operation_id, outcome.message)
            return true
          }
          const safeRetry = !history.changes.length && isDeepStrictEqual(cardState(card), pending.before) ||
            isEdit(input) && confirms(pending, card, history.changes)
          const atDestination = !isEdit(input) && card.status === jiraTransitionDestination(input)
          if (!atDestination && !history.changes.length && card.id === checkpoint.cardId) {
            if (pending.eventId !== event?.id || outcome.outcome === 'not-saved' && !pending.retry) {
              const { pending: _pending, ...prior } = checkpoint
              checkpoint = prior
              await save(key, checkpoint)
              if (pending.eventId !== event?.id) return true
            }
          }
          if (outcome.code === 'unconfirmed' && !pending.retry && attempts < stepAttemptLimit && safeRetry && card.id === checkpoint.cardId &&
            event?.id === pending.eventId && (!event.expiresAt || Date.parse(event.expiresAt) > now())) {
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
          const reason = reviewerBlocked ? 'reviewer-blocked' : outcome.outcome === 'saved' && outcome.message ? 'unconfirmed-evidence'
            : history.changes.length ? 'unconfirmed-status-or-assignee-change' : outcome.outcome
          await log(reason, input.operation_id, outcome.message)
          stopped = true
          return false
        }

        const readReviewNote = () => event?.target === 'Ready for Review' && event.head &&
          (card.status === 'In Progress' || card.status === 'Ready for Review')
          ? jira.tswReviewNote(card.id, event.pull) : Promise.resolve(undefined)
        if (checkpoint.pending && !isEdit(checkpoint.pending.input) && checkpoint.pending.input.verb === 'Submit for Review' &&
            event?.target === 'Ready for Review' && event.head && card.status === 'In Progress' && !history.changes.length &&
            reviewEdit(event, card, await readReviewNote())) {
          const { pending: _pending, ...prior } = checkpoint
          checkpoint = prior
          if (apply) await save(key, checkpoint)
        }
        if (checkpoint.pending) {
          if (!apply) { await log('pending-write-needs-confirmation', attemptId(checkpoint.pending)); continue }
          if (!resumed) processed++
          resumed = true
          if (!await execute(checkpoint.pending)) continue
        }
        if (!event) continue
        if (checkpoint.handledEvents?.includes(eventId) ||
            checkpoint.appliedEvents?.includes(eventId) && !(event.target === 'Ready for Review' && event.head && card.status === event.target)) {
          await log('event-already-applied')
          continue
        }
        const proposed = plan(event, card, await readReviewNote())
        if (typeof proposed === 'string') { await log(proposed); continue }
        const steps = proposed.filter(step => checkpoint.eventId !== eventId ||
          !checkpoint.completed.includes(identify(step, event, card.status, checkpoint.statusVersion).operation_id))
        if (!steps.length) { await log('event-already-applied'); continue }
        if (event.target === 'Ready for Review') {
          const reviewerId = await jira.findAssignableAccount(card.id, reviewer)
          if (!reviewerId || (checkpoint.preserveAssignee || steps.some(step => isEdit(step) && step.reviewComment)) && card.assignee_id !== reviewerId) {
            await log('reviewer-blocked')
            continue
          }
        }
        plans.push({ event, from: card.status, steps: steps.map(step => identify(step, event, card.status, checkpoint.statusVersion)) })
        if (!apply) { await log('planned'); continue }
        if (!resumed) processed++
        for (const step of steps) {
          const input = identify(step, event, card.status, checkpoint.statusVersion)
          const rejectedAttempts = checkpoint.rejectedSteps?.[input.operation_id] ?? 0
          if (rejectedAttempts >= stepAttemptLimit) {
            await log('rejected-cap-reached', input.operation_id)
            stopped = true
            break
          }
          const pending = { eventId, target: event.target, input, actor: event.actor, before: cardState(card), rejectedAttempts }
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

import { requestAnchor, type FirstMateRequest } from '../../shared/deskSource'
import type { AttentionBacklogRow, AttentionCard, AttentionTask, AttentionWorker } from './attention'

type Task = AttentionTask & { backlog?: { state?: unknown }; current_state?: { state?: unknown; freshness?: unknown }; completed?: boolean }
type Hold = AttentionBacklogRow & { captain_actionable?: unknown }
export interface SourceRequest {
  request: FirstMateRequest
  card: AttentionCard
  ownerReady: boolean
  /** Only an exact hold id with an unambiguous task binding can corroborate a decision. */
  matchedHoldId: string | null
}
const str = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
const completed = (value: unknown) => ['done', 'merged', 'completed', 'resolved', 'answered'].includes(String(value))
const origin = (row: Hold) => (Array.isArray(row.body_lines) ? row.body_lines : []).flatMap(line =>
  typeof line === 'string' ? /^Origin:\s*(\S+)$/.exec(line.trim())?.slice(1) ?? [] : [])[0] ?? null

/** Desk requests are independent source records. No title, text or legacy-key fallback. */
export function sourceRequests(home: string, homeIndex: number, tasks: Task[], backlog: Hold[], workers: AttentionWorker[], current = true): SourceRequest[] {
  const holds = backlog.filter(row => str(row.id) && row.hold_kind === 'captain')
  const decisions = tasks.flatMap(task => (Array.isArray(task.hints?.open_decisions) ? task.hints.open_decisions : []).flatMap((decision, index) =>
    decision.verb === 'needs-decision' || decision.verb === 'blocked' ? [{ task, decision, index }] : []))
  const done = (task: Task) => task.completed || completed(task.backlog?.state) || (task.current_state?.freshness === 'fresh' && completed(task.current_state.state))
  const exactHold = (taskId: string, key: string | null) => {
    if (!key) return undefined
    const matches = holds.filter(hold => hold.id === key && (origin(hold) ? origin(hold) === taskId :
      new Set(decisions.filter(entry => entry.decision.key === key).map(entry => entry.task.id)).size === 1))
    return matches.length === 1 ? matches[0] : undefined
  }
  const card = (request: FirstMateRequest, headline: string, blocked = false): AttentionCard => {
    const worker = workers.find(worker => worker.id === request.taskId)
    return { key: requestAnchor(request), homeIndex, taskId: request.taskId, decisionKey: request.id,
      holdId: request.kind === 'hold' ? request.id : null,
      dismissal: blocked || !request.id ? null : request.kind === 'hold' ? 'captain-hold' : 'resolve-key',
      type: blocked ? 'blocked' : 'decision', headline, detail: '', workerId: worker?.id ?? null, workerKey: worker?.key ?? null,
      ageDays: null, prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown' }
  }
  const requests: SourceRequest[] = []
  const completedHolds = new Set<string>()
  for (const { task, decision, index } of decisions) {
    const taskId = str(task.id)
    if (!taskId) continue
    const id = str(decision.key)
    const blocked = decision.verb === 'blocked'
    const hold = blocked ? undefined : exactHold(taskId, id)
    if (current && !blocked && hold && done(task)) completedHolds.add(String(hold.id))
    if (current && (done(task) || (hold && (completed(hold.state) || hold.merged === true || completed(hold.completion?.verb))))) continue
    const request: FirstMateRequest = { home, taskId, id, kind: 'decision' }
    const result = card(request, str(decision.summary) ?? 'Read the source request', blocked)
    // Unkeyed status entries stay separate and can never acquire a response route.
    if (!id) result.key += `:${index}`
    requests.push({ request, card: result, ownerReady: !blocked && hold?.captain_actionable === true, matchedHoldId: !blocked && hold ? String(hold.id) : null })
  }
  for (const hold of holds) {
    const id = String(hold.id)
    if (current && (completedHolds.has(id) || completed(hold.state) || hold.merged === true || completed(hold.completion?.verb))) continue
    const request: FirstMateRequest = { home, taskId: origin(hold) ?? (workers.some(worker => worker.id === id) ? id : null), id, kind: 'hold' }
    requests.push({ request, card: card(request, str(hold.hold_reason) ?? str(hold.title) ?? 'Read the source request'), ownerReady: hold.captain_actionable === true, matchedHoldId: id })
  }
  return requests
}

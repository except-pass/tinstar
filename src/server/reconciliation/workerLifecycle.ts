import type { SourceSnapshot } from './index'
import type { Execution } from './scene'
import type { DispatchProvenance } from './dispatchProvenance'
import type { WorkCard } from './workReader'
import { tswKey } from './tswIdentity'

export const TERMINAL_BACKLOG_GRACE_MS = 15 * 60_000
export const lifecycleDetector = (detector: string) => detector === 'invalid-dispatch-card' || detector === 'terminal-in-flight'
type Backlog = NonNullable<SourceSnapshot['fleet'][number]['observation']['data']>['backlog']

/** Snapshot-only exceptions: never assign a guessed card or edit a home backlog. */
export function workerLifecycleFindings(execution: Execution, backlog: NonNullable<Backlog>[number] | undefined,
  dispatch: DispatchProvenance, intentions: SourceSnapshot['intentions'], jiraCard: WorkCard | undefined, now: number) {
  const task = execution.source
  if (execution.kind === 'secondmate' || !['fresh', 'partial'].includes(execution.observation.status)) return []
  const identity = `home=${execution.home} task_id=${execution.identity.task_id ?? 'unknown'} spawn_gen=${execution.identity.spawn_gen ?? 'unknown'}`
  const findings: Array<{ detector: 'invalid-dispatch-card' | 'terminal-in-flight'; cardIds: string[]; reason: string }> = []
  const state = backlog?.state ?? task.backlog.state
  // Closed historical rows no longer need spawn-time attention.
  if (!['done', 'failed', 'cancelled', 'canceled'].includes(String(state))) {
    let reason: string | undefined
    if (dispatch.status === 'absent') reason = 'missing coordinator-authored backlog card: line'
    if (dispatch.status === 'independent') reason = 'card: none does not identify a real card'
    if (dispatch.status === 'conflict') reason = 'malformed or conflicting coordinator-authored backlog card: line'
    if (dispatch.status === 'card') {
      const jiraKey = tswKey(dispatch.cardId)
      const card = jiraKey ? jiraCard : ['fresh', 'partial'].includes(intentions.status)
        ? intentions.data?.cards.find(card => card.id === dispatch.cardId) : undefined
      if (card?.archived || card?.in_trash || ['done', 'archived'].includes(String(card?.properties.Status?.value).toLowerCase())) {
        reason = `card ${dispatch.cardId} is archived/Done`
      } else if (!card && !jiraKey && intentions.status === 'fresh' && intentions.coverage === 'complete' && intentions.data && !intentions.data.hasMore) {
        reason = `unknown card ${dispatch.cardId} in the complete board source`
      }
    }
    if (reason) findings.push({ detector: 'invalid-dispatch-card', cardIds: dispatch.status === 'card' ? [jiraCard?.id ?? dispatch.cardId] : [],
      reason: `Invalid spawn card: ${identity}: ${reason}; add a valid coordinator-authored card: line in its home backlog; do not guess or auto-repair a card` })
  }
  // The latest status event wins over pane/liveness and earlier terminal events.
  // age_seconds is relative to the snapshot, not to the time this report is read.
  const raw = task.lastEventText ?? task.last_event.raw
  const verb = typeof raw === 'string' ? raw.trim().match(/^([a-z-]+)(?=\s|:|$)/i)?.[1]?.toLowerCase() : undefined
  const status = verb ?? task.last_event.state
  const at = typeof raw === 'string' ? raw.match(/\[at=(\d+)\]/)?.[1] : undefined
  const seconds = task.last_event.age_seconds
  const endedAt = at ? Number(at) * 1000 : typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? Date.parse(execution.observation.observedAt ?? '') - seconds * 1000 : NaN
  if (state === 'in_flight' && ['done', 'failed'].includes(String(status)) && now - endedAt > TERMINAL_BACKLOG_GRACE_MS) {
    findings.push({ detector: 'terminal-in-flight', cardIds: [],
      reason: `Finished worker still in_flight: ${identity}: latest status is ${status} for more than 15 minutes; close it in its home backlog` })
  }
  return findings
}

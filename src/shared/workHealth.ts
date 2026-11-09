import type { FloorScene } from './reconciliationPresentation'
import { currentActivity, readinessContext, workReadiness } from './workReadiness'
import type { Claim } from '../server/reconciliation/scene'

export const verifiedLink = (link: Claim) => link.basis === 'explicit' && link.verification === 'confirmed' && link.state === 'current'
export const freshObservation = (value: { status: string; coverage: string; expiresAt: string | null }, now: number) =>
  value.status === 'fresh' && value.coverage === 'complete' && (!value.expiresAt || Date.parse(value.expiresAt) > now)

export const patternNames = {
  stalled: 'Stalled', blocked: 'Blocked', unstaffed: 'Unstaffed', idle: 'Idle workers',
  decision: 'Needs my decision', mismatch: 'State mismatch', stale: 'Stale', active: 'Active',
} as const
export type Pattern = keyof typeof patternNames
export const patterns = Object.keys(patternNames) as Pattern[]
export const patternDefinitions: Record<Pattern, { rule: string; unavailable?: string }> = {
  stalled: { rule: 'In Progress, assigned verified workers, no running/runnable path and no active resolver; requires complete fresh evidence.', unavailable: 'Runnable paths or active resolver coverage are incomplete.' },
  blocked: { rule: 'Explicit Waiting For text with Work Status Waiting For, a verified waiting worker or a published blocker. A legitimate wait is not a deadlock.' },
  unstaffed: { rule: 'In Progress with no verified assigned worker under complete configured source and explicit accountability coverage.' },
  idle: { rule: 'Waiting/idle worker with no runnable assigned work, excluding intentional wait and terminal history.', unavailable: 'Runnable assignment availability is not published.' },
  decision: { rule: 'Explicit Notion Will action or a structured human approval/input request from a verified worker.' },
  mismatch: { rule: 'Work and worker lifecycle disagree after suppressing tracked continuations.', unavailable: 'Tracked continuation coverage is not published.' },
  stale: { rule: 'No meaningful progress beyond an inspected threshold, independently of heartbeat/check-in age.', unavailable: 'Meaningful progress time is not published; no threshold can be applied yet.' },
  active: { rule: 'In Progress with at least one fresh verified running/runnable path. Uses current crew-state and the published backlog census.' },
}
export interface PatternResult { outcome: 'match' | 'no-match' | 'unavailable'; evidence: string[]; reason: string }
export interface WorkHealth {
  cardId: string
  workerIds: string[]
  workerCount: number
  running: number
  waiting: number
  terminal: number
  unknown: number
  // null is unavailable evidence, never zero. Readiness is projected from the
  // existing backlog census and authoritative current crew-state.
  runnable: number | null
  activeResolverCount: number | null
  lastProgressAt: string | null
  observedAt: string | null
  coverage: 'complete' | 'unknown'
  blockers: string[]
  patterns: Record<Pattern, PatternResult>
}

/** Ephemeral joins over the canonical scene, shared within one health query. */
function healthContext(scene: FloorScene, now: number) {
  const links = new Map<string, Claim[]>()
  for (const link of scene.claims) {
    const entries = links.get(link.cardId) ?? []; entries.push(link); links.set(link.cardId, entries)
  }
  return { readiness: readinessContext(scene, now), cards: new Map(scene.cards.map(card => [card.id, card])), workers: new Map(scene.executions.map(worker => [worker.id, worker])), links,
    gaps: new Set(scene.findings.filter(finding => finding.kind === 'task-execution-gap').flatMap(finding => finding.cardIds)) }
}

export function sceneWorkHealth(scene: FloorScene, now: number, readFailed = scene.searchReadFailed ?? false): WorkHealth[] {
  const context = healthContext(scene, now)
  return scene.cards.map(card => workHealth(scene, card.id, now, readFailed, context))
}

/** Shared read-only execution-health contract. No scheduler or prose inference. */
export function workHealth(scene: FloorScene, cardId: string, now: number, readFailed = scene.searchReadFailed ?? false, context = healthContext(scene, now)): WorkHealth {
  const card = context.cards.get(cardId)!
  const links = context.links.get(cardId) ?? []
  const workerIds = new Set(links.filter(verifiedLink).map(link => link.executionId))
  const workers = [...workerIds].flatMap(id => context.workers.get(id) ?? [])
  const sourceFresh = !readFailed && freshObservation(scene.coverage.intentions, now)
  const complete = sourceFresh && scene.coverage.absenceConclusions === 'sufficient-configured-sources' &&
    scene.coverage.homes.every(home => freshObservation(home.observation, now)) &&
    workerIds.size === workers.length && links.every(verifiedLink) && workers.every(worker => freshObservation(worker.observation, now) && worker.liveness !== 'liveness-not-observed')
  const status = String(card.source.properties.Status?.value ?? '')
  const wait = String(card.source.properties['Waiting For']?.value ?? '').trim()
  const activity = (worker: typeof workers[number]) => !readFailed && scene.coverage.homes.some(home => home.source.home === worker.home && freshObservation(home.observation, now)) ? currentActivity(worker, now) : 'unknown'
  const running = workers.filter(worker => activity(worker) === 'working').length
  const linksKnown = !readFailed && workerIds.size === workers.length && links.every(verifiedLink)
  const readiness = workReadiness(scene, workers, linksKnown, now, context.readiness)
  const blockers = [...new Set([...readiness.blockers, ...workers.flatMap(worker => worker.source.backlog.blocked_by ? [String(worker.source.backlog.blocked_by)] : [])])]
  const runnable = readFailed ? null : readiness.runnable
  const activeResolverCount = readFailed ? null : readiness.activeResolverCount
  const runningKnown = linksKnown && workers.length > 0 && workers.every(worker => activity(worker) !== 'unknown')
  const readinessComplete = sourceFresh && scene.coverage.absenceConclusions === 'sufficient-configured-sources' && context.readiness.allHomesFresh && runningKnown
  const readinessReasons = [...readiness.reasons, ...workers.filter(worker => activity(worker) === 'unknown').map(worker => `Running state unknown for ${worker.home}: ${worker.identity.task_id} (${worker.source.current_state.source ?? 'none'})`)]
  const activePath = running > 0 || (!readFailed && readiness.hasRunnable)
  const waiting = workers.filter(worker => activity(worker) === 'waiting').length
  const terminal = workers.filter(worker => activity(worker) === 'terminal').length
  const unknown = workers.filter(worker => activity(worker) === 'unknown').length
  const inProgress = status.trim().toLowerCase() === 'in progress'
  const closed = card.source.archived || card.source.in_trash || ['done', 'archived'].includes(status.trim().toLowerCase())
  // The reconciler additionally requires explicit per-card home accountability;
  // globally complete configured homes alone are not a census of the farm.
  const absenceKnown = context.gaps.has(cardId)
  const evidence = [`Work status: ${status || 'unknown'}`, `${workers.length} verified workers: ${running} running, ${waiting} waiting, ${terminal} terminal, ${unknown} unknown`,
    `Notion observation: ${scene.coverage.intentions.observedAt ?? 'unknown'} (${scene.coverage.intentions.status}/${scene.coverage.intentions.coverage})`,
    ...readiness.evidence,
    ...workers.map(worker => `${worker.home}/${worker.identity.task_id}: current_state ${worker.source.current_state.state ?? 'unknown'} from ${worker.source.current_state.source ?? 'none'} (${worker.source.current_state.freshness ?? 'unknown'}); ${worker.liveness}; observed ${worker.observation.observedAt ?? 'unknown'} (${worker.observation.status}/${worker.observation.coverage})`),
    ...links.filter(verifiedLink).map(link => `Verified link: ${link.sources.join(', ') || 'explicit source'}; observed ${link.observedAt ?? 'unknown'}`),
    ...blockers.map(blocker => `Published blocker: ${blocker}`)]
  const result = (outcome: PatternResult['outcome'], reason: string): PatternResult => ({ outcome, evidence: [...evidence, reason], reason })
  const sourceReason = readFailed ? 'Source read failed; showing last known work' : !sourceFresh ? 'Notion source is unavailable, stale or incomplete' : !status.trim() ? 'Work status is not published' : null
  const workerReasons = workers.filter(worker => !freshObservation(worker.observation, now) || worker.liveness === 'liveness-not-observed').map(worker => {
    const age = worker.source.last_event.age_seconds
    const observed = Date.parse(worker.observation.observedAt ?? '')
    const elapsed = (Number.isFinite(observed) ? Math.max(0, now - observed) : NaN) + (typeof age === 'number' ? age * 1000 : 0)
    const duration = !Number.isFinite(elapsed) ? 'at an unknown time' : elapsed >= 86400_000 ? `${Math.floor(elapsed / 86400_000)}d ago` : elapsed >= 3600_000 ? `${Math.floor(elapsed / 3600_000)}h ago` : `${Math.max(0, Math.floor(elapsed / 60_000))}m ago`
    return `${worker.identity.task_id ?? 'Worker'} last reported ${duration}; observation ${worker.observation.status}/${worker.observation.coverage}${worker.liveness === 'liveness-not-observed' ? '; liveness not observed' : ''}`
  })
  const uncertain = (reason: string) => result('unavailable', [...new Set([sourceReason, ...workerReasons, reason].filter(Boolean))].join('; '))
  const boolean = (matches: boolean, reason: string) => result(matches ? 'match' : 'no-match', reason)
  // An explicit Will action is authoritative; a status explanation mentioning a
  // decision is not. Structured needs-decision entries retain their provenance.
  const will = card.source.properties['Will action']?.value
  const decision = (Array.isArray(will) ? will : [will]).some(value => typeof value === 'string' ? !!value.trim() && !/^(?:none|no|false|n\/a)$/i.test(value.trim()) : value === true)
  const request = workers.some(worker => freshObservation(worker.observation, now) && worker.source.queue?.decisions.some(item => item.verb === 'needs-decision'))
  return {
    cardId, workerIds: workers.map(worker => worker.id), workerCount: workers.length, running, waiting, terminal, unknown,
    runnable, activeResolverCount, lastProgressAt: null, observedAt: scene.coverage.intentions.observedAt,
    coverage: complete ? 'complete' : 'unknown', blockers,
    patterns: {
      active: closed ? boolean(false, 'Work is Done or Archived') : sourceReason ? uncertain(sourceReason) : !inProgress ? boolean(false, 'Work is outside In Progress')
        : activePath ? boolean(true, 'At least one verified running or runnable path')
          : runningKnown && runnable === 0 ? boolean(false, 'Verified zero running and runnable paths') : uncertain(readinessReasons.join('; ') || 'Running/runnable accountability is incomplete'),
      blocked: closed ? boolean(false, 'Work is Done or Archived') : sourceReason ? uncertain(sourceReason)
        : boolean(!!wait && (status.trim().toLowerCase() === 'waiting for' || waiting > 0 || blockers.length > 0), `Waiting For: ${wait || 'not set'}; ${status.trim().toLowerCase() === 'waiting for' ? 'worker freshness is not required' : 'verified waiting worker or published blocker'}`),
      unstaffed: sourceReason ? uncertain(sourceReason) : !inProgress || workers.length > 0 ? boolean(false, workers.length ? 'A verified assigned worker exists' : 'Work is outside In Progress')
        : complete && absenceKnown ? boolean(true, 'Complete configured source and explicit accountability coverage; no verified assigned worker') : uncertain('Incomplete source, link or accountability coverage; no absence conclusion'),
      decision: !sourceFresh ? uncertain(sourceReason!) : decision || request ? boolean(true, decision ? `Explicit Notion Will action: ${String(will)}` : 'Published needs-decision request on a verified worker')
        : complete ? boolean(false, 'No explicit human decision request') : uncertain('Worker decision requests or assignment coverage are incomplete'),
      stalled: closed ? boolean(false, 'Work is Done or Archived') : sourceReason ? uncertain(sourceReason) : wait ? boolean(false, `Explicit Waiting For: ${wait}`) : activePath || (!readFailed && readiness.hasResolver) ? boolean(false, 'A verified running, runnable or active resolver path exists')
        : result(stalledOutcome({ inProgress, complete: readinessComplete, workerCount: workers.length, running, runnable, activeResolverCount }),
          readinessComplete && runnable === 0 && activeResolverCount === 0 ? 'Fresh complete proof of zero running, runnable and active resolver paths' : readinessReasons.join('; ') || 'Source, link or running accountability is incomplete'),
      idle: uncertain('Runnable assignment availability is not published; waiting is not proof of idle'),
      mismatch: uncertain('Tracked continuation coverage is not published'),
      stale: uncertain('Meaningful progress time is not published; heartbeat/check-in age is not progress'),
    },
  }
}


export const dialPatterns = ['all', 'stalled', 'blocked', 'decision', 'unstaffed', 'mismatch', 'stale', 'active'] as const
export type DialPattern = typeof dialPatterns[number]
export const dialNames: Record<DialPattern, string> = { all: 'All', ...patternNames, decision: 'Needs me', mismatch: 'Mismatch' }
export const patternReminders: Record<DialPattern, string> = {
  all: 'No operational pattern applied. See the board under your other filters.',
  stalled: 'Work says In Progress, but no linked worker can advance it and no active resolver exists. Look for an unassigned blocker, missing wake-up, or stopped worker. Requires adequate fresh source/link coverage; one waiting + one running worker is NOT stalled.',
  blocked: 'Work is Waiting For with a named dependency in Waiting For text. Worker freshness does not change this. Look for a real blocker, owner and next wake-up; blocked can be healthy.',
  decision: 'Work explicitly requires your decision, merge or elevated action. Look at the required action and supporting evidence, never infer approval from a worker state.',
  unstaffed: 'In Progress work with confirmed absence of a linked worker under adequate source coverage. Unknown/unverified links and stale source are not confidently unstaffed.',
  mismatch: 'Notion work and worker execution disagree (e.g. Done work with running execution, In Progress with all terminal workers and no follow-on). Review before changing either state.',
  stale: 'No meaningful work progress by the configured freshness/check-in rule. An activity heartbeat/card edit alone does not count as progress; distinguish from stale source telemetry.',
  active: "In Progress work has a running/runnable path. One waiting worker doesn't make the whole task Stalled if another is advancing it.",
}


/** Unknown resolver/runnable coverage cannot prove a stall. */
export function stalledOutcome(input: { inProgress: boolean; complete: boolean; workerCount: number; running: number; runnable: number | null; activeResolverCount: number | null }): PatternResult['outcome'] {
  if (!input.inProgress || input.running > 0 || (input.runnable ?? 0) > 0 || (input.activeResolverCount ?? 0) > 0) return 'no-match'
  if (!input.complete || input.runnable === null || input.activeResolverCount === null) return 'unavailable'
  return input.workerCount > 0 ? 'match' : 'no-match'
}

/** Conjunction keeps unknown evidence visible unless another predicate rules it out. */
export function combinedPatternResult(health: WorkHealth, selected: readonly Pattern[]): PatternResult {
  const results = selected.map(pattern => health.patterns[pattern])
  const outcome = results.some(result => result.outcome === 'no-match') ? 'no-match' : results.some(result => result.outcome === 'unavailable') ? 'unavailable' : 'match'
  return { outcome, reason: results.filter(result => result.outcome === outcome).map(result => result.reason).join('; '), evidence: results.flatMap(result => result.evidence) }
}

export const patternEmptyText: Record<Pattern, string> = {
  stalled: 'No stalled work', blocked: 'No blocked work', decision: 'No work needs your decision',
  unstaffed: 'No unstaffed work', mismatch: 'No state mismatches', stale: 'No stale work', active: 'No active work', idle: 'No idle workers',
}

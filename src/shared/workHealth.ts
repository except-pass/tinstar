import type { FloorScene } from './reconciliationPresentation'
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
  stalled: { rule: 'In Progress, assigned verified workers, no running/runnable path and no active resolver; requires complete fresh evidence.', unavailable: 'Runnable paths and active resolver coverage are not published.' },
  blocked: { rule: 'Work Status is Waiting For with non-empty Waiting For text, independently of worker freshness. A legitimate wait is not a deadlock.' },
  unstaffed: { rule: 'In Progress with no verified assigned worker under complete configured source and explicit accountability coverage.' },
  idle: { rule: 'Waiting/idle worker with no runnable assigned work, excluding intentional wait and terminal history.', unavailable: 'Runnable assignment availability is not published.' },
  decision: { rule: 'Explicit Notion Will action or a structured human approval/input request from a verified worker.' },
  mismatch: { rule: 'Work and worker lifecycle disagree after suppressing tracked continuations.', unavailable: 'Tracked continuation coverage is not published.' },
  stale: { rule: 'No meaningful progress beyond an inspected threshold, independently of heartbeat/check-in age.', unavailable: 'Meaningful progress time is not published; no threshold can be applied yet.' },
  active: { rule: 'In Progress with at least one fresh verified running/runnable path. Only Running is currently published.' },
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
  // null is unavailable evidence, never zero. These signals are not published
  // by the current source contract; a future reconciler can supply them.
  runnable: number | null
  activeResolverCount: number | null
  lastProgressAt: string | null
  observedAt: string | null
  coverage: 'complete' | 'unknown'
  blockers: string[]
  patterns: Record<Pattern, PatternResult>
}

/** Ephemeral joins over the canonical scene, shared within one health query. */
function healthContext(scene: FloorScene) {
  const links = new Map<string, Claim[]>()
  for (const link of scene.claims) {
    const entries = links.get(link.cardId) ?? []; entries.push(link); links.set(link.cardId, entries)
  }
  return { cards: new Map(scene.cards.map(card => [card.id, card])), workers: new Map(scene.executions.map(worker => [worker.id, worker])), links,
    gaps: new Set(scene.findings.filter(finding => finding.kind === 'task-execution-gap').flatMap(finding => finding.cardIds)) }
}

export function sceneWorkHealth(scene: FloorScene, now: number, readFailed = scene.searchReadFailed ?? false): WorkHealth[] {
  const context = healthContext(scene)
  return scene.cards.map(card => workHealth(scene, card.id, now, readFailed, context))
}

/** Shared read-only execution-health contract. No scheduler or prose inference. */
export function workHealth(scene: FloorScene, cardId: string, now: number, readFailed = scene.searchReadFailed ?? false, context = healthContext(scene)): WorkHealth {
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
  const blockers = [...new Set(workers.flatMap(worker => worker.source.backlog.blocked_by ? [String(worker.source.backlog.blocked_by)] : []))]
  const running = workers.filter(worker => worker.liveness === 'running' && freshObservation(worker.observation, now) && !readFailed).length
  const waiting = workers.filter(worker => worker.liveness === 'waiting').length
  const terminal = workers.filter(worker => ['finished', 'absent'].includes(worker.liveness)).length
  const unknown = workers.filter(worker => worker.liveness === 'liveness-not-observed' || !freshObservation(worker.observation, now) || readFailed).length
  const inProgress = status.trim().toLowerCase() === 'in progress'
  const closed = card.source.archived || card.source.in_trash || ['done', 'archived'].includes(status.trim().toLowerCase())
  // The reconciler additionally requires explicit per-card home accountability;
  // globally complete configured homes alone are not a census of the farm.
  const absenceKnown = context.gaps.has(cardId)
  const evidence = [`Work status: ${status || 'unknown'}`, `${workers.length} verified workers: ${running} running, ${waiting} waiting, ${terminal} terminal, ${unknown} unknown`,
    `Notion observation: ${scene.coverage.intentions.observedAt ?? 'unknown'} (${scene.coverage.intentions.status}/${scene.coverage.intentions.coverage})`,
    ...workers.map(worker => `${worker.identity.task_id}: ${worker.liveness}; observed ${worker.observation.observedAt ?? 'unknown'} (${worker.observation.status}/${worker.observation.coverage})`),
    ...links.filter(verifiedLink).map(link => `Verified link: ${link.sources.join(', ') || 'explicit source'}; observed ${link.observedAt ?? 'unknown'}`),
    ...blockers.map(blocker => `Published blocker: ${blocker}`)]
  const result = (outcome: PatternResult['outcome'], reason: string): PatternResult => ({ outcome, evidence: [...evidence, reason], reason })
  const sourceReason = readFailed ? 'Source read failed; showing last known work' : !sourceFresh ? 'Notion source is unavailable, stale or incomplete' : !status.trim() ? 'Work status is not published' : null
  const workerReasons = workers.filter(worker => !freshObservation(worker.observation, now) || worker.liveness === 'liveness-not-observed').map(worker => {
    const age = worker.source.last_event.age_seconds
    const elapsed = typeof age === 'number' ? age * 1000 : now - Date.parse(worker.observation.observedAt ?? '')
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
    runnable: null, activeResolverCount: null, lastProgressAt: null, observedAt: scene.coverage.intentions.observedAt,
    coverage: complete ? 'complete' : 'unknown', blockers,
    patterns: {
      active: sourceReason ? uncertain(sourceReason) : inProgress && !running ? uncertain('Runnable availability is not published; no verified running path observed') : boolean(inProgress && running > 0, running ? 'At least one verified running path' : 'Work is outside In Progress'),
      blocked: closed ? boolean(false, 'Work is Done or Archived') : sourceReason ? uncertain(sourceReason)
        : boolean(status.trim().toLowerCase() === 'waiting for' && !!wait, `Waiting For: ${wait || 'not set'}; worker freshness is not required`),
      unstaffed: sourceReason ? uncertain(sourceReason) : !inProgress || workers.length > 0 ? boolean(false, workers.length ? 'A verified assigned worker exists' : 'Work is outside In Progress')
        : complete && absenceKnown ? boolean(true, 'Complete configured source and explicit accountability coverage; no verified assigned worker') : uncertain('Incomplete source, link or accountability coverage; no absence conclusion'),
      decision: !sourceFresh ? uncertain(sourceReason!) : decision || request ? boolean(true, decision ? `Explicit Notion Will action: ${String(will)}` : 'Published needs-decision request on a verified worker')
        : complete ? boolean(false, 'No explicit human decision request') : uncertain('Worker decision requests or assignment coverage are incomplete'),
      stalled: closed ? boolean(false, 'Work is Done or Archived') : sourceReason ? uncertain(sourceReason) : result(stalledOutcome({ inProgress, complete, workerCount: workers.length, running, runnable: null, activeResolverCount: null }), running > 0 ? 'A verified worker is progressing' : [...workerReasons, 'Runnable paths and active resolver coverage are not published'].join('; ')),
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


/** Unknown resolver/runnable coverage cannot prove a stall. The current source
 * adapter deliberately passes null until those signals are actually published. */
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

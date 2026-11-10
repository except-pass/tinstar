import { homeLabel } from '../../shared/reconciliationLabels'
import { isException as exception } from '../../shared/reconciliationFindings'
import { retainedExecutionLiveness } from '../../shared/executionLiveness'
import { countLiveness, type ExecutionLiveness, type LivenessCounts } from '../../domain/execution-liveness'
import type { SourceSnapshot } from './index'
import { ageObservation, type Observation } from './observation'
import type { CardReference } from './references'
import { record, text } from './values'
import { FIRST_MATE_TASKS, isBlankWorkerLinks, parseWorkerLinks } from './workerLinks'
import { checkInTime, type CheckInIndicator } from '../../shared/checkIn'

type SourceCard = NonNullable<SourceSnapshot['intentions']['data']>['cards'][number]
type SourceTask = NonNullable<SourceSnapshot['fleet'][number]['observation']['data']>['tasks'][number]
export type FindingKind = 'confirmed-link' | 'task-execution-gap' | 'untracked-worker' |
  'unverified-conflicting' | 'unknown-stale-source' | 'legitimate-wait-planned' | 'outside-coverage'
export type WorkerLinkDetector = 'duplicate-primary' | 'spawn-evidence' | 'declared-absent' | 'historical-link' | 'invalid-record' | 'duplicate-execution'
export interface Finding {
  id: string
  kind: FindingKind
  cardIds: string[]
  executionIds: string[]
  homeIds: string[]
  reason: string
  workerLinkDetectors?: WorkerLinkDetector[]
  /** Advisory relationship evidence, retained in diagnostics rather than exception totals. */
  sourceHealth?: true
}
export interface Claim {
  id: string
  cardId: string
  executionId: string
  identity: SourceTask['identity']
  basis: 'explicit' | 'inferred' | 'textual'
  sources: string[]
  observedAt: string | null
  firstObservedAt: string | null
  endedAt: string | null
  state: 'current' | 'last-known' | 'historical'
  verification: 'confirmed' | 'unverified' | 'conflicting'
  accountability: { home: string; parentHome: string | null; owner: string | null }
}
export interface Placement { machine: string | null; basis: 'observed' | 'configured' | 'unknown'; configuredMachine: string | null }

export interface Execution {
  id: string
  identity: SourceTask['identity']
  home: string
  parentHome: string | null
  kind: string | null
  placement: Placement
  liveness: ExecutionLiveness
  activity: 'executing' | 'waiting' | 'inactive' | 'unknown'
  source: SourceTask
  observation: Omit<Observation<unknown>, 'data'>
}
export interface SceneCard {
  checkInRequest?: CheckInIndicator
  id: string
  source: SourceCard
  parentIds: string[]
  ancestry: string[]
  hierarchyIssues: string[]
  expectation: 'expected-now' | 'wait-planned' | 'outside' | 'unknown'
  expectationReason: string
  nextAction: string | null
  checkpoint: { at: string | null; state: 'overdue' | 'upcoming' | 'missing' | 'unknown' }
  // S1 does not collect PM Bot assessments or card bodies. Never derive progress
  // or delivery from a checkpoint, a claim, a commit, or a pane state.
  progressAssessment: null
}
export interface SceneGroup {
  id: string
  label: string
  cardIds: string[]
  executionIds: string[]
  claimIds: string[]
  homeIds: string[]
  placements: Placement[]
  counts: LivenessCounts & { cards: number; workers: number; attempts: number; claims: number; exceptions: number }
}

const key = (...parts: unknown[]) => JSON.stringify(parts)
const property = (card: SourceCard, name: string) => card.properties[name]?.value
const word = (card: SourceCard, name: string) => text(property(card, name))
export const declaredLinks = (card: SourceCard) => {
  const p = card.properties[FIRST_MATE_TASKS]
  return p?.workerLinks ?? parseWorkerLinks(p?.type === 'rich_text' && !p.hasMore ? p.value : undefined)
}
const ids = (card: SourceCard, name: string) => {
  const value = property(card, name)
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
const metadata = <T>(observation: Observation<T>) => {
  const { data: _data, ...rest } = observation
  return rest
}
const fresh = (value: Observation<unknown>) => (value.status === 'fresh' || value.status === 'partial') && !!value.data
const sufficient = (value: Observation<unknown>) => value.status === 'fresh' && value.coverage === 'complete' && !!value.data

function expectation(card: SourceCard, now: number): Pick<SceneCard, 'expectation' | 'expectationReason' | 'nextAction' | 'checkpoint'> {
  const owner = word(card, 'Owner')
  const status = word(card, 'Status')?.toLowerCase()
  const wait = word(card, 'Waiting For')?.trim() || null
  const start = text(record(property(card, 'Start Date')).start)
  const checkpointAt = text(record(property(card, 'Next check-in')).start)
  const checkpointTime = checkInTime(checkpointAt, text(record(property(card, 'Next check-in')).time_zone))
  const checkpoint: SceneCard['checkpoint'] = { at: checkpointAt, state: !checkpointAt ? 'missing' :
    !Number.isFinite(checkpointTime) ? 'unknown' : checkpointTime < now ? 'overdue' : 'upcoming' }
  const common = { nextAction: wait ?? word(card, 'Delegated To'), checkpoint }
  // Owner is a select in the observed board, not an inferred name in a title.
  if (owner && owner.toLowerCase() !== 'firstmate') return { ...common, expectation: 'outside', expectationReason: `Owner ${owner} is outside the integrated First Mate execution scope` }
  if (!owner || !status) return { ...common, expectation: 'unknown', expectationReason: 'Owner or status is missing' }
  if (wait || ['backlog', 'todo', 'queued', 'planned', 'waiting for', 'ready for review', 'done', 'archived', 'spare tokens'].includes(status) ||
    (start && Number.isFinite(Date.parse(start)) && Date.parse(start) > now)) {
    return { ...common, expectation: 'wait-planned', expectationReason: wait ? `Waiting For: ${wait}` : `Status ${word(card, 'Status')}${start ? `; Start Date ${start}` : ''}; no worker required now` }
  }
  if (status === 'in progress') return { ...common, expectation: 'expected-now', expectationReason: 'Notion Owner Firstmate and Status In Progress, without a published wait or future start' }
  return { ...common, expectation: 'unknown', expectationReason: `Status ${word(card, 'Status')} has no execution expectation rule` }
}

function executionLiveness(task: SourceTask, observation: Observation<unknown>, now: number): ExecutionLiveness {
  return fresh(observation) ? retainedExecutionLiveness(task, now) : 'liveness-not-observed'
}

/** Pure projection of observations. No source edits, scheduler, or title-confirmed links. */
export function reconcileScene(input: SourceSnapshot, now = Date.now()) {
  const intentions = ageObservation(input.intentions, now)
  const fleet = input.fleet.map(home => ({ ...home, observation: ageObservation(home.observation, now) }))
  const findings: Finding[] = []
  const add = (kind: FindingKind, cardIds: string[], executionIds: string[], reason: string, homeIds: string[] = [], workerLinkDetectors: WorkerLinkDetector[] = [], sourceHealth = false) => {
    findings.push({ id: key(kind, cardIds, executionIds, homeIds, reason), kind, cardIds, executionIds, homeIds, reason,
      ...(workerLinkDetectors.length ? { workerLinkDetectors } : {}), ...(sourceHealth ? { sourceHealth: true as const } : {}) })
  }
  const sourceCards = new Map((intentions.data?.cards ?? []).map(card => [card.id, card]))
  const cards: SceneCard[] = [...sourceCards.values()].map(card => {
    const ancestry = new Set<string>()
    const issues = new Set<string>()
    // Iterative traversal is bounded by fetched cards; malformed/cyclic relations
    // stay visible instead of overflowing a recursive renderer.
    const pending = ids(card, 'Parent item').map(id => ({ id, path: new Set([card.id]) }))
    const visited = new Set<string>()
    while (pending.length) {
      const { id, path } = pending.pop()!
      if (path.has(id)) { issues.add('Cyclic Parent item relation'); continue }
      if (visited.has(id)) continue
      visited.add(id); ancestry.add(id)
      const parent = sourceCards.get(id)
      if (!parent) { issues.add(`Parent ${id} unavailable in configured source`); continue }
      if (parent.properties['Parent item']?.hasMore) issues.add(`Parent ${id} relation is truncated`)
      for (const next of ids(parent, 'Parent item')) pending.push({ id: next, path: new Set([...path, id]) })
    }
    if (card.properties['Parent item']?.hasMore) issues.add('Parent item relation is truncated')
    return { id: card.id, source: card, parentIds: ids(card, 'Parent item'), ancestry: [...ancestry], hierarchyIssues: [...issues],
      ...expectation(card, now), progressAssessment: null }
  })
  const byCard = new Map(cards.map(card => [card.id, card]))
  const linkRecords = new Map(cards.map(card => [card.id, declaredLinks(card.source)]))
  // Blank is unknown for coverage, like a missing property. It is the normal
  // unset state, so it does not emit the per-card diagnostic a real read failure does.
  const declarationsReadable = [...linkRecords.values()].every(parsed => parsed.status === 'valid')
  const declarations = cards.flatMap(card => {
    const parsed = linkRecords.get(card.id)!
    if (isBlankWorkerLinks(parsed)) return []
    if (parsed.status !== 'valid') {
      add(parsed.status === 'invalid' ? 'unverified-conflicting' : 'unknown-stale-source', [card.id], [], `${FIRST_MATE_TASKS}: ${parsed.reason}`, [], parsed.status === 'invalid' ? ['invalid-record'] : [])
      return []
    }
    return parsed.tasks.map(link => ({ card, link }))
  })
  const declarationsByWorker = new Map<string, typeof declarations>()
  for (const declaration of declarations) {
    const id = key(declaration.link.fm_home, declaration.link.task_id)
    const entries = declarationsByWorker.get(id) ?? []
    entries.push(declaration); declarationsByWorker.set(id, entries)
  }
  const declaredFor = (home: string, task: string | null) => declarationsByWorker.get(key(home, task)) ?? []
  const executions: Execution[] = []
  const claims: Claim[] = []
  const backlog = fleet.flatMap(home => (home.observation.data?.backlog ?? []).map(row => ({
    id: key(home.source.home, row.id), home: home.source.home, source: row, observation: metadata(home.observation),
  })))
  for (const home of fleet) {
    const observation = home.observation
    if (!sufficient(observation)) add('unknown-stale-source', [], [], `Home ${home.source.home}: ${observation.status}/${observation.coverage}; absence conclusions suppressed`, [home.source.home])
    for (const task of observation.data?.tasks ?? []) {
      const id = key(task.identity.fm_home, task.identity.task_id, task.identity.spawn_gen)
      // Duplicate rows are evidence conflicts, not additional workers.
      if (executions.some(execution => execution.id === id)) {
        add('unverified-conflicting', [], [id], 'Duplicate execution identity in source snapshot', [home.source.home], fresh(observation) ? ['duplicate-execution'] : []); continue
      }
      const observedMachine = text(task.remote?.host)
      const liveness = executionLiveness(task, observation, now)
      const execution: Execution = { id, identity: task.identity, home: home.source.home, parentHome: home.source.parentHome ?? null,
        kind: text(task.kind), placement: { machine: observedMachine ?? home.source.machine ?? null,
          basis: observedMachine ? 'observed' : home.source.machine ? 'configured' : 'unknown', configuredMachine: home.source.machine ?? null },
        liveness, activity: liveness === 'running' ? 'executing' : liveness === 'waiting' ? 'waiting' : liveness === 'finished' || liveness === 'absent' ? 'inactive' : 'unknown', source: task, observation: metadata(observation) }
      executions.push(execution)
      const taskBacklog = observation.data?.backlog?.find(row => row.id === (task.backlog.id ?? task.identity.task_id))
      const refs: Array<CardReference | { pageId: string; basis: 'inferred'; source: string }> = [
        ...task.cardReferences, ...(taskBacklog?.cardReferences ?? []),
      ]
      // An equal title is only a candidate. Never upgrade it to an explicit link.
      if (!refs.length && typeof task.backlog.title === 'string') {
        const title = task.backlog.title.trim().replace(/\s+/g, ' ').toLowerCase()
        if (title) for (const card of cards) {
          if (word(card.source, 'Name')?.trim().replace(/\s+/g, ' ').toLowerCase() === title) {
            refs.push({ pageId: card.id, basis: 'inferred', source: 'equal-title-candidate' })
          }
        }
      }
      const referenced = [...new Set(refs.map(ref => ref.pageId))]
      for (const cardId of referenced) {
        const card = byCard.get(cardId)
        const evidence = refs.filter(ref => ref.pageId === cardId)
        const basis = evidence.some(ref => ref.basis === 'explicit') ? 'explicit' : evidence.some(ref => ref.basis === 'textual') ? 'textual' : 'inferred'
        // Worker-side metadata is candidate/corroborating evidence only. A
        // declared Notion relationship below owns confirmation and identity.
        if (declaredFor(home.source.home, task.identity.task_id).some(d => d.card.id === cardId)) continue
        const conflict = referenced.length > 1 || !task.identity.task_id || !task.identity.spawn_gen
        const verification = conflict ? 'conflicting' : 'unverified'
        const claim: Claim = { id: key(cardId, id, basis), cardId, executionId: id, identity: task.identity, basis,
          sources: [...new Set(evidence.map(ref => ref.source))], observedAt: observation.observedAt, firstObservedAt: observation.observedAt, endedAt: null,
          state: fresh(observation) && fresh(intentions) ? 'current' : 'last-known', verification,
          accountability: { home: home.source.home, parentHome: home.source.parentHome ?? null, owner: card ? word(card.source, 'Owner') : null } }
        claims.push(claim)
        add('unverified-conflicting', [cardId], [id], `Legacy candidate (${basis}); Notion declaration required; no automatic repair`, [], [], !conflict)
      }
      if (execution.activity === 'unknown') add('unknown-stale-source', referenced, [id], 'Runtime state or execution identity is unknown; a fresh metadata snapshot alone is insufficient')
    }
  }
  const observedAttempts = new Map<string, Execution[]>()
  for (const execution of executions) {
    if (!execution.identity.task_id || !execution.identity.spawn_gen || !fresh({ ...execution.observation, data: execution.source })) continue
    const id = key(execution.home, execution.identity.task_id)
    const attempts = observedAttempts.get(id) ?? []
    attempts.push(execution)
    observedAttempts.set(id, attempts)
  }
  for (const attempts of observedAttempts.values()) {
    if (new Set(attempts.map(e => e.identity.spawn_gen)).size < 2) continue
    const executionIds = attempts.map(e => e.id).sort()
    const cardIds = [...new Set(claims.filter(c => executionIds.includes(c.executionId)).map(c => c.cardId))].sort()
    add('unverified-conflicting', cardIds, executionIds,
      'Multiple observed generations for one task; First Mate must investigate continuity or ID reuse; never auto-switch',
      [attempts[0]!.home], ['spawn-evidence'])
  }
  for (const { card, link } of declarations) {
    const home = fleet.find(home => home.source.home === link.fm_home)
    const matches = executions.filter(e => e.home === link.fm_home && e.identity.task_id === link.task_id)
    const competing = declaredFor(link.fm_home, link.task_id)
    // Unrelated truncated Notion relations do not invalidate a fully read
    // declaration. Incomplete card pagination cannot establish uniqueness.
    const notionAvailable = fresh(intentions) && !intentions.data?.hasMore
    const homeAvailable = !!home && sufficient(home.observation)
    const homeObserved = !!home && fresh(home.observation)
    const available = homeAvailable && notionAvailable
    const duplicatePrimary = fresh(intentions) && new Set(competing.map(d => d.card.id)).size > 1
    const spawnEvidence = fresh(intentions) && homeObserved &&
      (matches.length > 1 || matches.some(e => e.identity.spawn_gen && e.identity.spawn_gen !== link.first_observed_spawn_gen))
    const conflict = duplicatePrimary || spawnEvidence
    const historical = card.source.archived || card.source.in_trash || card.expectation === 'outside' ||
      ['done', 'archived'].includes(word(card.source, 'Status')?.toLowerCase() ?? '')
    const identity = { fm_home: link.fm_home, task_id: link.task_id, spawn_gen: link.first_observed_spawn_gen }
    // A declaration with no observed worker remains visible in diagnostics; it
    // does not manufacture a worker, liveness, or a filesystem lookup.
    const targets = matches.length ? matches : [null]
    for (const execution of targets) {
      const id = execution?.id ?? key(identity.fm_home, identity.task_id, identity.spawn_gen)
      const verification = conflict ? 'conflicting' : available && execution ? 'confirmed' : 'unverified'
      const state = historical ? 'historical' : available && execution ? 'current' : 'last-known'
      const corroboration = execution?.source.cardReferences.filter(ref => ref.pageId === card.id).map(ref => ref.source) ?? []
      claims.push({ id: key(card.id, id, 'explicit'), cardId: card.id, executionId: id,
        identity: execution?.identity ?? identity, basis: 'explicit', sources: [`notion.${FIRST_MATE_TASKS}`, ...corroboration],
        observedAt: intentions.observedAt, firstObservedAt: intentions.observedAt, endedAt: null, state, verification,
        accountability: { home: link.fm_home, parentHome: home?.source.parentHome ?? null, owner: word(card.source, 'Owner') } })
      add(conflict ? 'unverified-conflicting' : !available ? 'unknown-stale-source' : execution ? 'confirmed-link' : historical ? 'outside-coverage' : 'unverified-conflicting',
        [card.id], execution ? [id] : [], conflict
          ? `${[duplicatePrimary && 'Same home/task declared on multiple primary cards', spawnEvidence && 'Observed spawn evidence differs from the declaration or contains multiple attempts'].filter(Boolean).join('; ')}; First Mate must investigate continuity or ID reuse; never auto-switch`
          : !available ? 'Declared relationship is last-known; Notion or worker home unavailable, stale or partial'
            : execution ? 'Notion First Mate tasks matches exact home, task ID and spawn evidence; this does not establish progress or delivery'
              : historical ? 'Historical Notion relationship retained; worker is not currently observed'
                : 'Declared worker not observed in a complete fresh home; First Mate must investigate', [link.fm_home], [
          ...(duplicatePrimary ? ['duplicate-primary' as const] : []),
          ...(spawnEvidence ? ['spawn-evidence' as const] : []),
          ...(!conflict && available && !execution && !historical ? ['declared-absent' as const] : []),
          ...(historical ? ['historical-link' as const] : []),
        ])
    }
  }
  // Independent/ad hoc workers are legitimate. Only positive source evidence
  // of Notion origin can make a missing declaration a mismatch candidate.
  for (const execution of executions) {
    if (execution.kind === 'secondmate' || declaredFor(execution.home, execution.identity.task_id).length) continue
    const refs = execution.source.cardReferences
    if (execution.activity === 'executing' && refs.length && sufficient(intentions) && declarationsReadable && sufficient({ ...execution.observation, data: execution.source }) && fleet.every(home => sufficient(home.observation))) {
      add('untracked-worker', [...new Set(refs.map(ref => ref.pageId))], [execution.id],
        'Worker metadata indicates Notion-originated work without a matching Notion declaration; First Mate investigates')
    }
  }
  if (!sufficient(intentions)) add('unknown-stale-source', [], [], `Notion: ${intentions.status}/${intentions.coverage}; absence conclusions suppressed`)
  if (!fleet.length) add('unknown-stale-source', [], [], 'No configured homes; fleet coverage is unknown')
  // Unknown runtime state anywhere in the configured pool can hide an unlinked
  // execution. Do not turn metadata completeness into a false execution gap.
  const absenceCovered = sufficient(intentions) && declarationsReadable && fleet.length > 0 && fleet.every(home => sufficient(home.observation)) &&
    executions.every(execution => execution.activity !== 'unknown')
  for (const card of cards) {
    const related = claims.filter(claim => claim.cardId === card.id)
    const linked = executions.filter(execution => related.some(claim => claim.executionId === execution.id))
    const live = linked.filter(execution => execution.activity === 'executing' || execution.activity === 'waiting')
    const confirmedWaiting = linked.filter(execution => execution.activity === 'waiting' &&
      related.some(claim => claim.executionId === execution.id && claim.verification === 'confirmed' && claim.state === 'current'))
    // The configured set is not a census of the farm. A card with no known
    // accountable home might be executing on an unconfigured machine. Only
    // explicit attempt/backlog identifiers establish a relevant absence scope.
    const conflictingBacklog = backlog.filter(entry =>
      entry.source.cardReferences.some(ref => ref.pageId === card.id) &&
      new Set(entry.source.cardReferences.map(ref => ref.pageId)).size > 1)
    const accountableHomes = [...new Set([
      ...related.filter(claim => claim.verification === 'confirmed').map(claim => claim.identity.fm_home),
      ...backlog.filter(entry => !conflictingBacklog.includes(entry) && entry.source.state === 'in_flight' &&
        entry.source.cardReferences.some(ref => ref.pageId === card.id && ref.basis === 'explicit')).map(entry => entry.home),
    ])]
    const waits = backlog.filter(entry => !conflictingBacklog.includes(entry) && (entry.observation.status === 'fresh' || entry.observation.status === 'partial') &&
      entry.source.cardReferences.some(ref => ref.pageId === card.id) &&
      (entry.source.state === 'queued' || !!entry.source.hold_reason || !!entry.source.blocked_by || !!entry.source.hold_until))
    if (card.hierarchyIssues.length) add('unverified-conflicting', [card.id], [], card.hierarchyIssues.join('; '))
    if (card.expectation === 'outside') add('outside-coverage', [card.id], linked.map(e => e.id), card.expectationReason)
    else if (card.expectation === 'wait-planned') add('legitimate-wait-planned', [card.id], linked.map(e => e.id), card.expectationReason)
    else if (card.expectation === 'unknown') add('unverified-conflicting', [card.id], linked.map(e => e.id), card.expectationReason)
    else if (!live.length && conflictingBacklog.length) {
      add('unverified-conflicting', [card.id], linked.map(e => e.id), 'Contradictory backlog card references; accountability, wait and execution-gap conclusions suppressed')
    } else if (!live.length && waits.length) {
      const explicit = waits.some(entry => entry.source.cardReferences.some(ref => ref.pageId === card.id && ref.basis === 'explicit'))
      add(explicit ? 'legitimate-wait-planned' : 'unverified-conflicting', [card.id], linked.map(e => e.id),
        explicit ? 'First Mate backlog accounts for queued/held work; retain hold reason, blocker and checkpoint in source data'
          : 'Textual backlog card reference suggests queued/held work; execution-gap conclusion suppressed pending verification')
    } else if (!related.length || !live.length) {
      if (absenceCovered && accountableHomes.length && related.every(claim => claim.verification === 'confirmed') && !card.source.archived && !card.source.in_trash) {
        add('task-execution-gap', [card.id], linked.map(e => e.id), `${card.expectationReason}; explicit accountability in ${accountableHomes.join(', ')} and complete fresh configured coverage contain no execution or legitimate wait`, accountableHomes)
      } else add('unknown-stale-source', [card.id], linked.map(e => e.id), 'Expected execution cannot be accounted for; insufficient coverage, unverified claims or missing explicit home accountability suppress an execution-gap conclusion')
    } else if (confirmedWaiting.length) {
      add('legitimate-wait-planned', [card.id], confirmedWaiting.map(e => e.id), 'Observed worker wait; retain worker state/detail and card next action/checkpoint')
    }
  }
  const arrangements = groupScene(cards, executions, claims, findings, fleet.map(home => ({
    home: home.source.home, label: home.source.label, machine: home.source.machine ?? null,
  })))
  return {
    generatedAt: new Date(now).toISOString(), scope: input.scope, warnings: input.warnings,
    coverage: { absenceConclusions: absenceCovered ? 'sufficient-configured-sources' : 'suppressed',
      wholeFarm: 'not-certified', intentions: metadata(intentions),
      homes: fleet.map(home => ({ source: home.source, observation: metadata(home.observation) })) },
    statusOptions: intentions.data?.schema.Status?.options ?? [],
    cards, executions, backlog, claims, findings, arrangements,
    cardRollups: cards.map(card => {
      const cardIds = cards.filter(child => child.id === card.id || child.ancestry.includes(card.id)).map(child => child.id)
      const relationships = claims.filter(claim => cardIds.includes(claim.cardId))
      const attempts = executions.filter(execution => relationships.some(claim => claim.executionId === execution.id))
      return { cardId: card.id, cardIds, executionIds: attempts.map(e => e.id), counts: { ...countLiveness(attempts), cards: cardIds.length, attempts: attempts.length,
        workers: new Set(attempts.filter(e => e.kind !== 'secondmate').map(e => key(e.home, e.identity.task_id))).size, claims: relationships.length } }
    }),
    counts: { ...countLiveness(executions), cards: cards.length, workers: new Set(executions.filter(e => e.kind !== 'secondmate').map(e => key(e.home, e.identity.task_id))).size,
      attempts: executions.length, claims: claims.length, exceptions: findings.filter(exception).length },
    // There is intentionally no green/all-clear flag: scope is configured homes,
    // not independently discovered whole-farm coverage.
  }
}

function groupScene(cards: SceneCard[], executions: Execution[], claims: Claim[], findings: Finding[], homes: Array<{ home: string; label?: string; machine: string | null }>) {
  const arrangements = { initiative: new Map<string, SceneGroup>(), secondMate: new Map<string, SceneGroup>(), machine: new Map<string, SceneGroup>() }
  const group = (arrangement: keyof typeof arrangements, id: string, label: string) => {
    let entry = arrangements[arrangement].get(id)
    if (!entry) { entry = { id, label, cardIds: [], executionIds: [], claimIds: [], homeIds: [], placements: [], counts: { ...countLiveness([]), cards: 0, workers: 0, attempts: 0, claims: 0, exceptions: 0 } }; arrangements[arrangement].set(id, entry) }
    return entry
  }
  const unassigned = (arrangement: keyof typeof arrangements) => group(arrangement, key(arrangement, 'unassigned'), 'Unassigned / unknown')
  for (const arrangement of Object.keys(arrangements) as Array<keyof typeof arrangements>) unassigned(arrangement)
  const byCard = new Map(cards.map(card => [card.id, card]))
  const parents = new Set(cards.flatMap(card => card.parentIds))
  const initiativeGroups = (card: SceneCard) => {
    const roots = card.ancestry.filter(id => !byCard.get(id)?.parentIds.length)
    if (!roots.length && parents.has(card.id) && !card.parentIds.length) roots.push(card.id)
    return roots.length ? roots.map(id => group('initiative', key('initiative', id), byCard.has(id) ? word(byCard.get(id)!.source, 'Name') ?? id : `Unavailable parent ${id}`)) : [unassigned('initiative')]
  }
  for (const home of homes) {
    group('secondMate', key('home', home.home), homeLabel(home)).homeIds.push(home.home)
    const entry = home.machine ? group('machine', key('machine', home.machine), home.machine) : unassigned('machine')
    entry.homeIds.push(home.home)
    entry.placements.push({ machine: home.machine, basis: home.machine ? 'configured' : 'unknown', configuredMachine: home.machine })
  }
  for (const card of cards) for (const entry of initiativeGroups(card)) entry.cardIds.push(card.id)
  for (const execution of executions) {
    const related = claims.filter(claim => claim.executionId === execution.id)
    for (const claim of related) {
      const card = byCard.get(claim.cardId)
      for (const entry of card ? initiativeGroups(card) : [unassigned('initiative')]) {
        entry.executionIds.push(execution.id); entry.claimIds.push(claim.id)
      }
    }
    if (!related.length) unassigned('initiative').executionIds.push(execution.id)
    const machine = execution.placement.machine ? group('machine', key('machine', execution.placement.machine), execution.placement.machine) : unassigned('machine')
    machine.placements.push(execution.placement)
    for (const entry of [group('secondMate', key('home', execution.home), homeLabel(homes.find(home => home.home === execution.home) ?? { home: execution.home })), machine]) {
      entry.executionIds.push(execution.id); entry.claimIds.push(...related.map(claim => claim.id)); entry.cardIds.push(...related.map(claim => claim.cardId).filter(id => byCard.has(id)))
    }
  }
  for (const arrangement of ['secondMate', 'machine'] as const) for (const card of cards) {
    if (![...arrangements[arrangement].values()].some(group => group.cardIds.includes(card.id))) unassigned(arrangement).cardIds.push(card.id)
  }
  return Object.fromEntries(Object.entries(arrangements).map(([name, groups]) => [name, [...groups.values()].map(entry => {
    entry.cardIds = [...new Set(entry.cardIds)]; entry.executionIds = [...new Set(entry.executionIds)]
    entry.claimIds = [...new Set(entry.claimIds)]; entry.homeIds = [...new Set(entry.homeIds)]
    entry.placements = [...new Map(entry.placements.map(placement => [JSON.stringify(placement), placement])).values()]
    const members = executions.filter(execution => entry.executionIds.includes(execution.id))
    entry.counts = { ...countLiveness(members), cards: entry.cardIds.length, attempts: members.length, claims: entry.claimIds.length,
      workers: new Set(members.filter(e => e.kind !== 'secondmate').map(e => key(e.home, e.identity.task_id))).size,
      exceptions: findings.filter(f => exception(f) && (f.cardIds.some(id => entry.cardIds.includes(id)) || f.executionIds.some(id => entry.executionIds.includes(id)) || f.homeIds.some(id => entry.homeIds.includes(id)))).length }
    return entry
  })])) as Record<keyof typeof arrangements, SceneGroup[]>
}

/** Bounded in-memory relationship history, not an execution/event ledger. */
export class SceneReconciler {
  private known = new Map<string, Claim>()

  reconcile(input: SourceSnapshot, now = Date.now()) {
    const scene = reconcileScene(input, now)
    const current = new Set(scene.claims.map(claim => claim.id))
    for (const claim of scene.claims) {
      const previous = this.known.get(claim.id)
      claim.firstObservedAt = previous?.endedAt ? claim.observedAt : previous?.firstObservedAt ?? claim.observedAt
      this.known.set(claim.id, claim)
    }
    for (const [id, previous] of this.known) {
      if (current.has(id)) continue
      const home = scene.coverage.homes.find(home => home.source.home === previous.identity.fm_home)
      const replacement = scene.executions.find(execution => execution.id === previous.executionId)
      const card = scene.cards.find(card => card.id === previous.cardId)
      const notionKnown = ['fresh', 'partial'].includes(scene.coverage.intentions.status) &&
        !input.intentions.data?.hasMore && card && declaredLinks(card.source).status === 'valid'
      const retired = notionKnown && home?.observation.status === 'fresh' && home.observation.coverage === 'complete' &&
        (!replacement || scene.claims.some(claim => claim.executionId === replacement.id && claim.basis === 'explicit' && claim.verification === 'confirmed' && claim.state === 'current'))
      this.known.set(id, { ...previous, state: retired || previous.endedAt ? 'historical' : 'last-known',
        endedAt: previous.endedAt ?? (retired ? home.observation.observedAt : null) })
    }
    // Keep current claims; cap older relationships at 2,000 and 24 hours. Missing
    // history after restart/eviction is disclosed and never implies no prior work.
    const history = [...this.known.values()].filter(claim => !current.has(claim.id) &&
      now - Date.parse(claim.endedAt ?? claim.observedAt ?? '') < 86_400_000).slice(-2000)
    this.known = new Map([...history, ...scene.claims].map(claim => [claim.id, claim]))
    return { ...scene, claimHistory: history, historyScope: 'in-memory observed relationships only; 24h/2000 prior claims; resets on server restart' }
  }
}

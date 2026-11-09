import type { SourceSnapshot } from './index'
import { dispatchForTask } from './dispatchProvenance'
import { declaredLinks, reconcileScene, type Execution } from './scene'
import { BLANK_PROPERTY_REASON, FIRST_MATE_TASKS, workerLinkRecord, parseWorkerLinks, WORKER_LINK_SCHEMA, type WorkerLink } from './workerLinks'

// pr.url is the recorded pull request. current_state.detail is the forge disposition
// published by crew state (open, held for merge, or ready for review). Title text is not evidence.
// Only an inactive worker that passes this check is admitted to the write tier.
const reviewPrOpen = (execution: Execution) => {
  const url = execution.source.pr.url
  const detail = execution.source.current_state.detail
  return typeof url === 'string' && url.length > 0 && typeof detail === 'string' &&
    /^(?:run passed: PR open|checks green: PR (?:held for merge|ready for review))\b/.test(detail)
}
const operationalWorker = (execution: Execution) =>
  execution.kind !== 'secondmate' && (execution.activity !== 'inactive' || reviewPrOpen(execution))
const key = (...parts: unknown[]) => JSON.stringify(parts)
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const sorted = (values: string[]) => [...new Set(values)].sort(compare)
const ordered = <T>(values: T[]) => values.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
export const BACKFILL_TIERS = ['already confirmed', 'eligible auto-write', 'ambiguous', 'independent', 'conflicts', 'unavailable'] as const
type BackfillTier = typeof BACKFILL_TIERS[number]
export interface BackfillProposal {
  cardId: string
  fm_home: string
  task_id: string
  spawn_gen: string
  strength: 'legacy-metadata' | 'textual-reference' | 'dispatch-ledger'
  sources: string[]
}
interface BackfillRow {
  kind: 'worker' | 'declaration' | 'home'
  task_id: string | null
  spawn_gen: string | null
  cardIds: string[]
  sources: string[]
  proposals: BackfillProposal[]
  reason: string
}

function groupBackfill(scene: ReturnType<typeof reconcileScene>, proposals: BackfillProposal[], notionCurrent: boolean,
  records: Map<string, { mergeable: boolean; invalid: boolean }>, autoCoverage: boolean, repairCards: ReadonlySet<string>) {
  const operationalCard = (id: string) => {
    const card = scene.cards.find(card => card.id === id)?.source
    return !card || !card.archived && !card.in_trash && !['done', 'archived'].includes(String(card.properties.Status?.value).toLowerCase())
  }
  return scene.coverage.homes.map(({ source, observation }) => {
    const tiers: Record<BackfillTier, BackfillRow[]> = {
      'already confirmed': [], 'eligible auto-write': [], ambiguous: [], independent: [], conflicts: [], unavailable: [],
    }
    const homeAvailable = observation.status === 'fresh' && observation.coverage === 'complete'
    const active = scene.executions.filter(e => e.home === source.home && operationalWorker(e))
    for (const execution of active) {
      const claims = scene.claims.filter(c => c.executionId === execution.id && operationalCard(c.cardId))
      const declared = claims.filter(c => c.sources.includes(`notion.${FIRST_MATE_TASKS}`))
      const cardIds = sorted(claims.map(c => c.cardId))
      const backlog = scene.backlog.find(b => b.home === source.home && b.source.id === (execution.source.backlog.id ?? execution.identity.task_id))
      const provenance = dispatchForTask(execution.source, backlog?.source)
      const sources = sorted([...claims.flatMap(c => c.sources), ...provenance.sources])
      if (provenance.status === 'card' && !cardIds.includes(provenance.cardId)) cardIds.push(provenance.cardId)
      cardIds.sort(compare)
      const competing = scene.claims.some(c => c.identity.fm_home === source.home && c.identity.task_id === execution.identity.task_id &&
        (c.verification === 'conflicting' || provenance.status === 'card' && c.cardId !== provenance.cardId))
      const dispatchConflict = provenance.status === 'conflict' || provenance.status === 'independent' && claims.length > 0 ||
        provenance.status === 'card' && competing
      const contradiction = scene.findings.some(f => f.executionIds.includes(execution.id) &&
        f.workerLinkDetectors?.some(d => ['duplicate-primary', 'spawn-evidence', 'duplicate-execution'].includes(d)))
      const invalid = notionCurrent && cardIds.some(id => records.get(id)?.invalid)
      const confirmed = declared.some(c => c.verification === 'confirmed' && c.state === 'current')
      let tier: BackfillTier, reason: string
      if (contradiction || invalid || dispatchConflict) { tier = 'conflicts'; reason = 'Source classification requires First Mate investigation; no write' }
      else if (!homeAvailable || !notionCurrent || cardIds.some(id => !records.get(id)?.mergeable)) {
        tier = 'unavailable'; reason = 'Home, Notion coverage or referenced declaration is unknown, stale, partial or unreadable'
      } else if (confirmed && !(provenance.status === 'card' && repairCards.has(provenance.cardId))) {
        tier = 'already confirmed'; reason = 'Existing Notion declaration matches the fresh worker identity; no write'
      }
      else if (provenance.status === 'card') {
        const card = scene.cards.find(c => c.id === provenance.cardId)
        if (!autoCoverage || !card || !records.get(card.id)?.mergeable || !operationalCard(card.id) || typeof card.source.properties.Status?.value !== 'string') {
          tier = 'unavailable'; reason = 'Dispatch target or complete Notion declaration coverage is unavailable; no write'
        } else if (!['executing', 'waiting', 'inactive'].includes(execution.activity) || !execution.identity.task_id || !execution.identity.spawn_gen) {
          tier = 'unavailable'; reason = 'Operational worker identity is not established; no write'
        } else {
          const proposal: BackfillProposal = { cardId: card.id, fm_home: source.home, task_id: execution.identity.task_id,
            spawn_gen: execution.identity.spawn_gen, strength: 'dispatch-ledger', sources: provenance.sources }
          if (parseWorkerLinks(JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks: [{ fm_home: proposal.fm_home,
            task_id: proposal.task_id, first_observed_spawn_gen: proposal.spawn_gen }] })).status !== 'valid') {
            tier = 'conflicts'; reason = 'Dispatch worker identity is invalid; investigate'
          } else {
            proposals.push(proposal)
            tier = 'eligible auto-write'; reason = 'Coordinator dispatch line binds one operational worker to this board card'
          }
        }
      }
      else if (claims.length) { tier = 'ambiguous'; reason = 'Candidate evidence only; exact durable dispatch provenance is not collected' }
      else { tier = 'independent'; reason = 'No operational Notion provenance observed; no forced card association' }
      tiers[tier].push({ kind: 'worker', task_id: execution.identity.task_id, spawn_gen: execution.identity.spawn_gen,
        cardIds, sources, proposals: proposals.filter(p => p.fm_home === source.home && p.task_id === execution.identity.task_id &&
          (tier === 'eligible auto-write' ? p.strength === 'dispatch-ledger' : p.strength !== 'dispatch-ledger')), reason })
    }
    // Positive declarations can name a task absent from the snapshot. Keep that
    // investigation/unknown distinct from an invented zero-worker assertion.
    const missing = scene.claims.filter(c => c.identity.fm_home === source.home && c.state !== 'historical' && operationalCard(c.cardId) &&
      c.sources.includes(`notion.${FIRST_MATE_TASKS}`) && !scene.executions.some(e => e.id === c.executionId))
    for (const claim of missing) {
      const tier = claim.verification === 'conflicting' || homeAvailable && notionCurrent ? 'conflicts' : 'unavailable'
      tiers[tier].push({ kind: 'declaration', task_id: claim.identity.task_id, spawn_gen: claim.identity.spawn_gen,
        cardIds: [claim.cardId], sources: sorted(claim.sources), proposals: [],
        reason: tier === 'conflicts' ? 'Declared worker is absent or conflicting in current source classification; investigate' : 'Declared worker cannot be checked with available source coverage' })
    }
    if (!homeAvailable && !active.length && !missing.length) tiers.unavailable.push({ kind: 'home', task_id: null, spawn_gen: null,
      cardIds: [], sources: [], proposals: [], reason: 'Home coverage is unavailable; worker count is unknown' })
    for (const tier of BACKFILL_TIERS) ordered(tiers[tier])
    return { fm_home: source.home, counts: Object.fromEntries(BACKFILL_TIERS.map(tier => [tier, tiers[tier].length])), tiers }
  })
}

/** Report the Slice A classification at the snapshot's own evaluation time.
 * No process history or wall clock participates, so saved inputs are replayable.
 */
export function buildWorkerLinkReport(input: SourceSnapshot, repairCards: ReadonlySet<string> = new Set()) {
  const scene = reconcileScene(input, Date.parse(input.generatedAt))
  const intentions = scene.coverage.intentions
  const notionCurrent = ['fresh', 'partial'].includes(intentions.status) && !!input.intentions.data && !input.intentions.data.hasMore
  const complete = (o: { status: string; coverage: string }) => o.status === 'fresh' && o.coverage === 'complete'
  const cards = scene.cards.map(card => {
    const declaration = declaredLinks(card.source)
    const property = card.source.properties[FIRST_MATE_TASKS]
    // Mergeable blank is the wire reader's blank classification on a fully read
    // rich-text property. Missing, wrong-type, truncated, unreadable and invalid
    // records stay non-mergeable. Do not re-parse the display text: parseWorkerLinks
    // rejects blank text as malformed JSON, which is a different result.
    const blank = declaration.status === 'unknown' && declaration.reason === BLANK_PROPERTY_REASON &&
      property?.type === 'rich_text' && !property.hasMore
    return { card, declaration, mergeable: declaration.status === 'valid' || blank }
  })
  const declaredWorkers = new Set(cards.flatMap(({ declaration }) => declaration.status === 'valid'
    ? declaration.tasks.map(task => key(task.fm_home, task.task_id)) : []))
  const proposals: BackfillProposal[] = []
  for (const claim of scene.claims) {
    if (claim.sources.includes(`notion.${FIRST_MATE_TASKS}`) || claim.basis === 'inferred' || claim.verification === 'conflicting') continue
    const { fm_home, task_id, spawn_gen } = claim.identity
    const home = scene.coverage.homes.find(home => home.source.home === fm_home)
    const entry = cards.find(entry => entry.card.id === claim.cardId)
    const execution = scene.executions.find(execution => execution.id === claim.executionId)
    const backlog = scene.backlog.find(b => b.home === fm_home && b.source.id === (execution?.source.backlog.id ?? task_id))
    if (execution && dispatchForTask(execution.source, backlog?.source).status !== 'absent') continue
    if (!notionCurrent || !home || !complete(home.observation) || !entry?.mergeable || !task_id || !spawn_gen || !execution || !operationalWorker(execution)) continue
    const source = entry.card.source
    const status = source.properties.Status?.value
    if (source.archived || source.in_trash || typeof status !== 'string' || ['done', 'archived'].includes(status.toLowerCase())) continue
    if (declaredWorkers.has(key(fm_home, task_id))) continue
    if (scene.findings.some(f => f.executionIds.includes(claim.executionId) && f.workerLinkDetectors?.includes('duplicate-execution'))) continue
    // Multiple observed attempts or competing legacy card references need an
    // investigation; emitting a pasteable assignment would mask that conflict.
    if (scene.executions.filter(e => e.home === fm_home && e.identity.task_id === task_id).length !== 1) continue
    const link = { fm_home, task_id, first_observed_spawn_gen: spawn_gen }
    if (parseWorkerLinks(JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks: [link] })).status !== 'valid') continue
    proposals.push({ cardId: claim.cardId, fm_home, task_id, spawn_gen,
      strength: claim.basis === 'explicit' ? 'legacy-metadata' : 'textual-reference', sources: sorted(claim.sources) })
  }
  const autoCoverage = complete(scene.coverage.intentions) && notionCurrent &&
    cards.every(({ mergeable }) => mergeable)
  const homes = groupBackfill(scene, proposals, notionCurrent, new Map(cards.map(({ card, declaration, mergeable }) =>
    [card.id, { mergeable, invalid: declaration.status === 'invalid' }])), autoCoverage, repairCards)
  ordered(proposals)
  const merges = cards.filter(({ card }) => proposals.some(p => p.cardId === card.id)).map(({ card, declaration }) => {
    const tasks: WorkerLink[] = [...(declaration.status === 'valid' ? declaration.tasks : [])]
    for (const proposal of proposals.filter(p => p.cardId === card.id)) {
      if (!tasks.some(task => key(task.fm_home, task.task_id) === key(proposal.fm_home, proposal.task_id))) {
        tasks.push({ fm_home: proposal.fm_home, task_id: proposal.task_id, first_observed_spawn_gen: proposal.spawn_gen })
      }
    }
    // Preserve every existing entry. Canonical ordering also makes coordinator
    // readback/diff review independent of source collection order.
    tasks.sort((a, b) => compare(key(a.fm_home, a.task_id), key(b.fm_home, b.task_id)))
    try {
      return { cardId: card.id, status: 'ready-for-verification' as const, ...workerLinkRecord(tasks) }
    } catch {
      return { cardId: card.id, status: 'size-limit' as const, properties: undefined, reason: 'Merged record exceeds Notion limits; no pasteable replacement emitted' }
    }
  })
  const findings = scene.findings.flatMap(finding => {
    const detectors: string[] = [...(finding.workerLinkDetectors ?? []),
      ...(finding.kind === 'unknown-stale-source' ? ['unknown-coverage'] : !finding.workerLinkDetectors?.length ? [finding.kind] : [])]
    return detectors.map(detector => ({ detector, classification: finding.kind,
      cardIds: sorted(finding.cardIds), executionIds: sorted(finding.executionIds), homeIds: sorted(finding.homeIds),
      ...(finding.sourceHealth ? { sourceHealth: true as const } : {}),
      reason: finding.kind === 'legitimate-wait-planned' ? 'Source classification is waiting/planned; inspect the source for details' : finding.reason }))
  })
  // One duplicate-primary detector row can be supported by multiple declaration
  // findings; retain unique, sorted evidence rows rather than source ordering.
  const uniqueFindings = [...new Map(findings.map(f => [JSON.stringify(f), f])).values()]
  return {
    schema: 'tinstar.worker-link-report.v1', mode: 'report-only', evaluatedAt: input.generatedAt, scope: input.scope,
    dispatchProvenance: { status: scene.executions.some(e => e.source.dispatchProvenance?.status !== undefined && e.source.dispatchProvenance.status !== 'absent') ||
      scene.backlog.some(b => b.source.dispatchProvenance?.status !== undefined && b.source.dispatchProvenance.status !== 'absent') ? 'collected' : 'not-collected',
      reason: 'Only coordinator-authored backlog body_lines card: declarations supply dispatch authority. Legacy metadata and text remain candidates.' },
    warnings: sorted(input.warnings),
    coverage: {
      wholeFarm: scene.coverage.wholeFarm, absenceConclusions: scene.coverage.absenceConclusions,
      intentions: { ...intentions, cardPaginationComplete: !!input.intentions.data && !input.intentions.data.hasMore },
      homes: ordered(scene.coverage.homes.map(({ source, observation }) => ({ fm_home: source.home, ...observation }))),
      cards: ordered(cards.map(({ card, declaration, mergeable }) => ({ cardId: card.id, declaration: declaration.status,
        ...('reason' in declaration ? { reason: declaration.reason } : {}), mergeable: notionCurrent && mergeable }))),
    },
    homes: ordered(homes),
    merges: ordered(merges), findings: ordered(uniqueFindings),
  }
}

export type WorkerLinkReport = ReturnType<typeof buildWorkerLinkReport>

import type { SourceSnapshot } from '../reconciliation'
import { ageObservation } from '../reconciliation/observation'
import { reconcileScene } from '../reconciliation/scene'
import { buildQueue } from '../reconciliation/queue'
import { notionPageId } from '../reconciliation/notion'
import { operationalStatuses, matchesStatus, defaultStatusFilter, dateBucket } from '../../shared/floorOrganization'
import { auditCategories, type AuditCategory, type AuditContext, type AuditEvidence, type AuditProposal, type ProposalAction } from '../../shared/janitor'
import { clean, compare, features, fingerprint, ids, neighbors, pageUrl, prop, sorted, stable, title, word, type AuditCard, type FeatureCache } from './evidence'

export interface AuditInput { snapshot: SourceSnapshot; contexts?: Record<string, AuditContext> }
export interface AuditOptions { evaluatedAt?: string; cache?: FeatureCache }
const protectedFields = ['comments', 'history', 'approvals', 'decisions', 'PR references', 'sub-items', 'worker associations',
  'First Mate tasks', 'Initiative', 'Epic', 'Owner', 'Status', 'Next check-in', 'Will action']
const action: Record<AuditCategory, ProposalAction> = { duplicates: 'possible_duplicate', overlaps: 'overlapping_scope', superseded: 'possible_superseded',
  'stale-or-no-action': 'stale_needs_owner_update', 'check-in': 'source_conflict', 'ownership-or-links': 'source_conflict' }
const observationMetadata = <T,>({ data: _data, ...metadata }: T & { data: unknown }) => metadata
const nextAction = (card: AuditCard) => word(card, 'Next action') || word(card, 'Next Action')
const contextText = (context?: AuditContext) => context?.blocks.map(b => b.text).join('\n') ?? ''
const supportedContext = (context?: AuditContext) => context && ['available', 'partial'].includes(context.outcome) ? context : undefined

/** Pure, reproducible projection. All preview values are unchanged: investigation is the only operation. */
export function buildJanitorReport(input: AuditInput, options: AuditOptions = {}) {
  const evaluatedAt = options.evaluatedAt ?? input.snapshot.generatedAt
  const now = Date.parse(evaluatedAt)
  if (!Number.isFinite(now)) throw new Error('Audit evaluation time must be an ISO timestamp')
  const source = ageObservation(input.snapshot.intentions, now)
  const snapshot = { ...input.snapshot, intentions: source }
  const scene = reconcileScene(snapshot, now)
  const all = [...(source.data?.cards ?? [])].sort((a, b) => compare(a.id, b.id))
  const sceneById = new Map(scene.cards.map(card => [card.id, card]))
  const cards = all.filter(card => !card.archived && !card.in_trash && matchesStatus(sceneById.get(card.id)!, defaultStatusFilter()))
  const byId = new Map(all.map(card => [card.id, card]))
  const operational = new Set(cards.map(card => card.id))
  const contexts = input.contexts ?? {}
  const categories = Object.fromEntries(auditCategories.map(category => [category, {
    examinedCards: cards.length, examinedPairs: 0, candidates: 0,
    unknown: [] as Array<{ pageIds: string[]; pageUrls: string[]; reason: string }>,
  }])) as Record<AuditCategory, { examinedCards: number; examinedPairs: number; candidates: number; unknown: Array<{ pageIds: string[]; pageUrls: string[]; reason: string }> }>
  const unknown = (category: AuditCategory, pageIds: string[], reason: string) => categories[category].unknown.push({ pageIds: sorted(pageIds),
    pageUrls: sorted(pageIds).map(id => byId.has(id) ? pageUrl(byId.get(id)!) : `https://www.notion.so/${id}`), reason })
  const proposals: AuditProposal[] = []
  const limitations = [...input.snapshot.warnings]
  if (source.status !== 'fresh' || source.coverage !== 'complete') {
    limitations.push('Notion is partial, stale or unavailable. This report cannot establish absence, uniqueness or completion.')
    for (const category of auditCategories) unknown(category, [], `Notion ${source.status}/${source.coverage}; unobserved cards/properties remain unknown`)
  }
  limitations.push('Card edits and worker activity are not proof of progress. GitHub/Jira completion and PM Bot assessments are not collected.')
  const supportingIds = new Set<string>()
  const evidence = (card: AuditCard, field: string): AuditEvidence => {
    const block = field.startsWith('block:') ? supportedContext(contexts[card.id])?.blocks.find(b => `block:${b.id}` === field) : undefined
    const context = block ? contexts[card.id] : undefined
    const contextTime = Date.parse(context?.observedAt ?? '')
    const contextFreshness = !Number.isFinite(contextTime) || contextTime > now + 60_000 ? 'unknown' : now - contextTime >= 120_000 ? 'stale' : context?.outcome === 'partial' ? 'partial' : 'fresh'
    return { pageId: card.id, url: block ? `${pageUrl(card).split('#')[0]}#${block.id.replaceAll('-', '')}` : pageUrl(card), field,
      value: block ? clean(block.text) : field === 'last_edited_time' ? card.last_edited_time : prop(card, field),
      observedAt: context?.observedAt ?? source.observedAt, editedAt: card.last_edited_time,
      freshness: source.status === 'stale' || source.status === 'unknown' ? source.status : context ? contextFreshness : source.status,
      coverage: context ? context.outcome === 'available' ? 'complete' : 'partial' : source.coverage,
      ...(card.properties[field]?.type === 'relation' ? { relatedPages: ids(card, field).map(id => ({ id,
        url: byId.has(id) ? pageUrl(byId.get(id)!) : `https://www.notion.so/${id}`, availability: byId.has(id) ? 'observed' as const : 'unknown' as const })) } : {}) }
  }
  const add = (category: AuditCategory, rule: string, involved: AuditCard[], why: string, fields: string[], proposedAction: string,
    abstainReason: string | null = null, extra: AuditEvidence[] = [], confidence: AuditProposal['confidence'] = 'medium') => {
    const pages = [...new Map(involved.map(card => [card.id, card])).values()].sort((a, b) => compare(a.id, b.id))
    const citations = [...new Map([...pages.flatMap(card => fields.map(field => evidence(card, field))), ...extra].map(item => [stable(item), item])).values()]
      .sort((a, b) => compare(stable(a), stable(b)))
    // Every emitted item cites an actual observed property, source timestamp or block.
    if (!citations.some(e => e.value !== null && e.value !== undefined && e.value !== '')) return
    for (const card of pages) if (!operational.has(card.id)) supportingIds.add(card.id)
    // Refreshing an unchanged observation is not a new proposal revision.
    const evidenceRevision = fingerprint(citations.map(({ observedAt: _observed, freshness: _freshness, ...content }) => content))
    const preview = pages.map(card => {
      const before = Object.fromEntries(fields.map(field => [field, field === 'last_edited_time' ? card.last_edited_time : prop(card, field)]))
      return { pageId: card.id, before, after: { ...before } }
    })
    proposals.push({ proposal_id: `janitor:${fingerprint([category, rule, pages.map(c => c.id)]).slice(0, 24)}`, evidenceRevision,
      category, actionType: action[category], rule, severity: ['check-in', 'ownership-or-links'].includes(category) ? 'warning' : 'info',
      pages: pages.map(card => ({ id: card.id, url: pageUrl(card), title: title(card), role: operational.has(card.id) ? 'operational' : 'supporting' })),
      why, evidence: citations, origin: 'deterministic', confidence,
      abstainReason: source.status !== 'fresh' || source.coverage !== 'complete'
        ? [abstainReason, 'Source coverage/freshness is insufficient for a definitive conclusion'].filter(Boolean).join('; ')
        : citations.some(e => e.freshness !== 'fresh' || e.coverage !== 'complete')
          ? [abstainReason, 'Some cited evidence is partial/stale/unavailable; no definitive conclusion'].filter(Boolean).join('; ') : abstainReason,
      proposedAction, proposedSurvivor: null, preview, impact: 'investigation-only', protected: protectedFields,
      applyPreconditions: { authorization: 'not-authorized', evidenceRevision,
        pages: pages.map(card => ({ id: card.id, lastEditedAt: card.last_edited_time, sourceFingerprint: fingerprint(card) })),
        requires: ['Explicit separately authorized review/apply path', 'Reread every target and cited source; reject drift', 'Preserve protected history and relationships', 'Readback verification and audit'] } })
    categories[category].candidates++
  }
  const metrics = { modelCalls: 0, modelTokens: 0, externalInferenceCalls: 0, writeCalls: 0, cacheHits: 0, cacheMisses: 0,
    comparedPairs: 0, contextCards: Object.keys(contexts).length }
  const cache = options.cache ?? new Map()
  const derived = new Map(cards.map(card => [card.id, features(card, cache, metrics)]))
  const pairs = neighbors(cards, derived)
  const distinctions: Array<{ pageIds: string[]; reason: string }> = []
  const edges: Record<'duplicates' | 'overlaps', Array<[string, string]>> = { duplicates: [], overlaps: [] }
  for (const [left, right] of pairs) {
    metrics.comparedPairs++
    categories.duplicates.examinedPairs++; categories.overlaps.examinedPairs++
    const a = byId.get(left)!, b = byId.get(right)!, fa = derived.get(left)!, fb = derived.get(right)!
    const sharedTokens = fa.tokens.filter(t => fb.tokens.includes(t))
    const sharedKeys = fa.identifiers.filter(t => fb.identifiers.includes(t))
    const identical = !!fa.normalizedTitle && fa.normalizedTitle === fb.normalizedTitle
    const similarity = sharedTokens.length / Math.max(1, new Set([...fa.tokens, ...fb.tokens]).size)
    const separateRoles = /\b(?:recovery|backfill)\b/i.test(title(a)) !== /\b(?:recovery|backfill)\b/i.test(title(b)) &&
      /\b(?:writer|owned|reconciliation)\b/i.test(`${title(a)} ${title(b)}`)
    if (!identical && !sharedKeys.length && !(sharedTokens.length >= 3 && similarity >= 0.3) && !(separateRoles && sharedTokens.length >= 2)) continue
    const related = sceneById.get(left)!.ancestry.includes(right) || sceneById.get(right)!.ancestry.includes(left)
    const slice = (value: string) => value.match(/\b(?:u|slice|phase|part|milestone)\s*(\d+)\b/i)?.[1]
    const differentSlices = !!slice(title(a)) && !!slice(title(b)) && slice(title(a)) !== slice(title(b))
    const dateA = title(a).match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0], dateB = title(b).match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0]
    const differentRuns = !!dateA && !!dateB && dateA !== dateB
    if (related || differentSlices || differentRuns) {
      distinctions.push({ pageIds: [left, right], reason: related ? 'Explicit ancestor/child relationship; retain separate cards' : differentRuns ? 'Different explicitly dated runs; retain separate cards' : 'Named implementation slices differ; retain separate cards' })
      continue
    }
    if (fa.identifiers.length && fb.identifiers.length && !sharedKeys.length && !identical) {
      distinctions.push({ pageIds: [left, right], reason: 'Different canonical work identifiers; overlap alone does not establish duplication' })
      continue
    }
    if (separateRoles) distinctions.push({ pageIds: [left, right], reason: 'Writer/reconciliation and recovery/backfill roles differ; clarify boundaries, do not merge on similarity' })
    if (!separateRoles && (identical || sharedKeys.length && similarity >= 0.7)) edges.duplicates.push([left, right])
    else edges.overlaps.push([left, right])
  }
  // Connected components turn repeated pair evidence into one reviewable cluster.
  for (const category of ['duplicates', 'overlaps'] as const) {
    const groups: Set<string>[] = []
    for (const [a, b] of edges[category]) {
      const touching = groups.filter(group => group.has(a) || group.has(b))
      const merged = new Set([a, b, ...touching.flatMap(group => [...group])])
      for (const group of touching) groups.splice(groups.indexOf(group), 1)
      groups.push(merged)
    }
    for (const group of groups) {
      const involved = sorted([...group]).map(id => byId.get(id)!)
      const matching = edges[category].filter(([a, b]) => group.has(a) && group.has(b))
      const tokens = sorted(matching.flatMap(([a, b]) => derived.get(a)!.tokens.filter(t => derived.get(b)!.tokens.includes(t))))
      const keys = sorted(matching.flatMap(([a, b]) => derived.get(a)!.identifiers.filter(t => derived.get(b)!.identifiers.includes(t))))
      // Similarity is not transitive evidence against a known parent/slice distinction.
      const resultCategory = category === 'duplicates' && distinctions.some(d => d.pageIds.every(id => group.has(id))) ? 'overlaps' : category
      const roleDistinction = distinctions.some(d => d.pageIds.every(id => group.has(id)) && d.reason.includes('roles differ'))
      add(resultCategory, 'bounded-identifier-title-cluster', involved,
        (resultCategory === 'duplicates' ? 'Exact normalized titles or shared canonical work identifiers with strong title overlap; duplicate candidate only' : 'Shared meaningful title terms or canonical work references; scope overlap candidate only') +
        `; shared terms: ${tokens.join(', ') || '(none)'}; shared identifiers: ${keys.join(', ') || '(none)'}${roleDistinction ? '; writer/reconciliation and recovery/backfill roles differ' : ''}`,
        ['Name', 'Link', 'Evidence', 'Parent item', 'Sub-item'],
        resultCategory === 'duplicates' ? 'Compare acceptance criteria and history; confirm duplication before proposing a survivor or consolidation' : 'Compare the cited scopes and clarify boundaries; retain distinct writer, recovery, parent and implementation slices',
        'Similarity/shared references do not prove duplicate or completed work; no survivor selected',
        involved.flatMap(card => supportedContext(contexts[card.id])?.blocks.filter(b => /\b(?:writer|recovery|backfill|distinct scope|separate.*card)\b/i.test(b.text)).slice(0, 2).map(b => evidence(card, `block:${b.id}`)) ?? []), 'low')
    }
  }

  for (const card of cards) {
    const context = supportedContext(contexts[card.id])
    const body = contextText(context)
    if (!context || context.outcome !== 'available') {
      unknown('duplicates', [card.id], 'Complete acceptance prose not collected; title/reference similarity cannot prove equivalence')
      unknown('superseded', [card.id], context ? 'Card prose is partial; absence of an explicit supersession is unknown' : 'Card prose not collected or unavailable; semantic supersession is unknown')
      unknown('overlaps', [card.id], 'Complete scope/acceptance prose not collected; title/identifier rules cannot certify independence')
    }
    const missingAction = !nextAction(card)
    const wait = word(card, 'Waiting For') || word(card, 'Delegated To')
    const bodyAction = /\b(?:next\s+(?:action|step)|waiting\s+(?:for|on)|blocked\s+by)\s*[:—-]\s*\S/i.test(body)
    if (missingAction && !wait && !bodyAction) {
      const edited = Date.parse(card.last_edited_time)
      const days = Number.isFinite(edited) ? Math.max(0, Math.floor((now - edited) / 86400_000)) : null
      add('stale-or-no-action', 'no-published-next-action', [card],
        `No published Next action / Next Action, Waiting For or Delegated To property${days === null ? '' : `; last edited ${days} calendar days ago (not a progress signal)`}`,
        ['Name', 'Next action', 'Next Action', 'Waiting For', 'Delegated To', 'last_edited_time'],
        'Ask the card owner to verify current state, dependencies and the next concrete action; retain active long-running work',
        !context || context.outcome !== 'available' ? 'Prose is uncollected/partial; this is missing property metadata, not proof that the task has no next action' : 'No explicit next-action marker found; free-form prose may still contain a plan',
        context?.blocks.filter(b => /\bnext|wait|block/i.test(b.text)).slice(0, 2).map(b => evidence(card, `block:${b.id}`)) ?? [])
    }
    if (!context && missingAction) unknown('stale-or-no-action', [card.id], 'Next action may be stated in uncollected prose')
    const checkpoint = prop(card, 'Next check-in')
    const start = checkpoint && typeof checkpoint === 'object' ? (checkpoint as { start?: unknown }).start : null
    const parsedDate = typeof start === 'string' ? Date.parse(start) : NaN
    const invalidDate = !Number.isFinite(parsedDate) || typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start) && new Date(parsedDate).toISOString().slice(0, 10) !== start
    const checkpointState = typeof start === 'string' ? invalidDate ? 'Unknown' : dateBucket(start, now, true) : null
    if (!start || typeof start !== 'string' || checkpointState === 'Unknown' || checkpointState === 'Overdue') {
      add('check-in', 'published-check-in-metadata', [card],
        !start ? 'No published Next check-in date' : typeof start !== 'string' || checkpointState === 'Unknown' ? 'Published Next check-in is not a valid date' : `Published Next check-in ${String(start)} is in the past under the board calendar semantics`,
        ['Name', 'Status', 'Next check-in'], 'Ask the responsible owner / PM Bot workflow to verify the published check-in metadata; do not reset the commitment',
        'No working-hour SLA, progress, or missed-commitment verdict is inferred from this metadata observation')
    }
    if (!word(card, 'Owner') || !word(card, 'Name')) add('ownership-or-links', 'missing-owner-or-title', [card],
      'Operational card has no supported nonempty Owner or Name property', ['Name', 'Owner', 'Status'],
      'Verify the source schema and ask the responsible owner to clarify the missing field; do not assign from worker activity')
    const projected = sceneById.get(card.id)!
    for (const issue of projected.hierarchyIssues) add('ownership-or-links', `hierarchy:${issue}`, [card], issue,
      ['Name', 'Parent item', 'Sub-item'], 'Verify the cited source relationship and its coverage; preserve history and existing associations', 'Missing/truncated targets are unknown, not proof of a broken relationship')
    for (const [name, property] of Object.entries(card.properties)) if (property.hasMore) {
      unknown('ownership-or-links', [card.id], `Property ${name} is truncated`)
      add('ownership-or-links', `truncated:${name}`, [card], `Property ${name} is truncated`, ['Name', name],
        'Refresh the existing source reader before judging this relationship', 'Incomplete source coverage')
    }
    for (const field of ['Link', 'Evidence']) {
      const value = word(card, field)
      if (value && card.properties[field]?.type === 'url') {
        try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported link') }
        catch { add('ownership-or-links', `invalid-url:${field}`, [card], `${field} has a malformed or unsupported URL`, ['Name', field], 'Ask the owner to verify the intended source URL; do not replace it with a title guess') }
      }
    }
    // A replacement assertion must bind to a real source ID in the same clause.
    // Prose is data, never executable instructions; unrelated references are not replacements.
    const assertions = [...['Next action', 'Next Action', 'Evidence'].map(field => ({ field, value: word(card, field) })),
      ...(context?.blocks.map(b => ({ field: `block:${b.id}`, value: b.text })) ?? [])]
    for (const assertion of assertions) for (const clause of assertion.value.split(/[\n.!?](?:\s|$)/)) {
      const match = /\b(?:superseded\s+by|replaced\s+by|consolidated\s+into)\s*[:—-]?\s*(https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>"()]+)/i.exec(clause)
      if (!match || /\b(?:not|never|no|if|possibly|maybe|whether|might|could)\b/i.test(clause.slice(0, match.index))) continue
      const targetId = notionPageId(new URL(match[1]!).pathname.match(/([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\/?$/i)?.[1])
      if (!targetId || targetId === card.id) continue
      const target = byId.get(targetId)
      if (!target) { unknown('superseded', [card.id, targetId], 'Explicit replacement target is outside the observed source coverage'); continue }
      add('superseded', `explicit-replacement:${targetId}`, [card, target], 'Source text explicitly names a replacement card; coverage of the original scope is unverified',
        ['Name', 'Status', 'Link'], 'Ask the owner to compare both cards and confirm replacement coverage; preserve the source and all history',
        'An explicit source assertion does not authorize completion, supersession or archival', [evidence(card, assertion.field)])
    }
  }
  // Reuse the authoritative worker-link detector, never derive assignment from titles.
  for (const finding of scene.findings.filter(f => f.workerLinkDetectors?.length)) {
    const involved = finding.cardIds.map(id => byId.get(id)).filter((c): c is AuditCard => !!c)
    if (!involved.some(c => operational.has(c.id))) continue
    add('ownership-or-links', `worker-link:${sorted(finding.workerLinkDetectors ?? []).join(',')}`, involved,
      `Existing reconciliation diagnostic: ${finding.reason}`, ['Name', 'First Mate tasks'],
      'Route this diagnostic to the existing worker-link reconciliation owner; Janitor must not infer, repair or write an assignment',
      'Reconciliation owns link authority; unknown worker is not proof of missing assignment')
  }
  for (const home of scene.coverage.homes) if (home.observation.status !== 'fresh' || home.observation.coverage !== 'complete') {
    unknown('ownership-or-links', [], `Existing fleet source ${home.source.label ?? home.source.home}: ${home.observation.status}/${home.observation.coverage}; worker-link coverage remains unknown`)
  }
  const countStatuses = (items: AuditCard[]) => Object.fromEntries(sorted(items.map(card => word(card, 'Status') || '(missing)'))
    .map(status => [status, items.filter(card => (word(card, 'Status') || '(missing)') === status).length]))
  const queue = buildQueue(snapshot, new Map(), now)
  const unique = [...new Map(proposals.map(p => [p.proposal_id, p])).values()].sort((a, b) => compare(a.proposal_id, b.proposal_id))
  for (const category of auditCategories) categories[category].candidates = unique.filter(p => p.category === category).length
  return {
    schema: 'tinstar.janitor-audit.v1' as const, mode: 'read-only' as const, evaluatedAt, snapshotAt: snapshot.generatedAt,
    scope: { definition: 'Overview operational preset, excluding archived/in_trash; supporting historical cards only when cited',
      operationalStatuses: [...operationalStatuses], sourceCards: all.length, operationalCards: cards.length, operationalIds: cards.map(c => c.id),
      includedStatuses: countStatuses(cards), excludedStatuses: countStatuses(all.filter(c => !operational.has(c.id))),
      archivedOrTrash: all.filter(c => c.archived || c.in_trash).length, missingStatus: all.filter(c => !word(c, 'Status')).length,
      supportingIds: sorted([...supportingIds]) },
    coverage: { notion: observationMetadata(source), paginationComplete: !!source.data && !source.data.hasMore,
      truncatedRelations: source.data?.truncatedRelations ?? [], missingSchemaProperties: source.data?.missingSchemaProperties ?? [],
      homes: scene.coverage.homes.map(h => ({ home: h.source.home, ...h.observation })), absenceConclusions: scene.coverage.absenceConclusions },
    limitations: sorted(limitations), categories, proposals: unique,
    distinctions: distinctions.map(distinction => ({ ...distinction, origin: 'deterministic' as const,
      pages: distinction.pageIds.map(id => ({ id, url: pageUrl(byId.get(id)!), title: title(byId.get(id)!) })),
      evidence: distinction.pageIds.flatMap(id => {
        const card = byId.get(id)!
        return [...['Name', 'Parent item', 'Sub-item', 'Link'].map(field => evidence(card, field)),
          ...(supportedContext(contexts[id])?.blocks.filter(b => /\b(?:writer|recovery|backfill|distinct scope|separate.*card)\b/i.test(b.text)).slice(0, 2).map(b => evidence(card, `block:${b.id}`)) ?? [])]
      }), proposedAction: 'Retain these related cards separately; verify their cited scope boundaries before any future cleanup' })),
    baseline: { openDecisionCandidates: queue.items.length, decisionReadiness: Object.fromEntries(['ready-now', 'needs-readiness-verification', 'future-or-conditional']
      .map(readiness => [readiness, queue.items.filter(item => item.readiness === readiness).length])),
      note: 'Existing Desk queue projection only; no GitHub readiness refresh, new Desk items, reminders or authoritative PM verdicts' },
    counts: { total: unique.length, bySeverity: { info: unique.filter(p => p.severity === 'info').length, warning: unique.filter(p => p.severity === 'warning').length } }, metrics,
  }
}
export type JanitorReport = ReturnType<typeof buildJanitorReport>

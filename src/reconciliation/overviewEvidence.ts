import { freshObservation, verifiedLink, type PatternResult } from '../shared/workHealth'
import type { FloorScene } from './presentation'
import { activeWorker, workerFact } from '../shared/workerEvidence'

/** Unique visible cards, with positive conflicts separate from missing evidence. */
export function workerLinkSourceHealth(scene: FloorScene, cardIds: Iterable<string>, now: number, readFailed = false) {
  let unknown = 0, unverified = 0, conflicting = 0
  for (const cardId of new Set(cardIds)) {
    const links = scene.claims.filter(link => link.cardId === cardId && link.state !== 'historical')
    if (links.some(link => link.verification === 'conflicting') ||
      scene.findings.some(finding => !finding.sourceHealth &&
        (finding.cardIds.includes(cardId) || links.some(link => finding.executionIds.includes(link.executionId))) &&
        finding.workerLinkDetectors?.some(detector => ['invalid-record', 'declared-absent', 'duplicate-primary', 'spawn-evidence', 'duplicate-execution'].includes(detector)))) { conflicting++; continue }
    const current = links.some(link => verifiedLink(link) && !readFailed && freshObservation(scene.coverage.intentions, now) &&
      scene.executions.some(worker => worker.id === link.executionId && freshObservation(worker.observation, now) &&
        scene.coverage.homes.some(home => home.source.home === worker.home && freshObservation(home.observation, now))))
    if (current) continue
    if (links.length) unverified++
    else unknown++
  }
  return { unknown, unverified, conflicting }
}

/** Facts about verified assignments, independent of the selected pattern. */
export function cardWorkerFact(scene: FloorScene, cardId: string, now: number, readFailed = false): string | null {
  const links = scene.claims.filter(link => link.cardId === cardId && link.state !== 'historical')
  const ids = new Set(links.filter(verifiedLink).map(link => link.executionId))
  const workers = scene.executions.filter(worker => ids.has(worker.id) && activeWorker(worker, now))
  if (!workers.length) {
    return !links.length && scene.findings.some(finding => finding.kind === 'task-execution-gap' && finding.cardIds.includes(cardId)) &&
      !readFailed && scene.coverage.absenceConclusions === 'sufficient-configured-sources' &&
      freshObservation(scene.coverage.intentions, now) && scene.coverage.homes.length > 0 &&
      scene.coverage.homes.every(home => freshObservation(home.observation, now)) ? 'No worker' : null
  }
  const facts = new Map<string, number>()
  for (const worker of workers) {
    const home = scene.coverage.homes.find(home => home.source.home === worker.home)
    const fact = workerFact(worker, now, home?.observation, readFailed)
    facts.set(fact, (facts.get(fact) ?? 0) + 1)
  }
  return [...facts].map(([fact, count]) => `${count} ${count === 1 ? 'worker' : 'workers'}${/^(?:running|waiting)(?:$| ·)/.test(fact) ? ' ' : ', '}${fact}`).join(' · ')
}

export interface PatternCoverage {
  unavailableCardIds: string[]
  total: number
  evaluated: number
  confirmed: number
  label: string
  reasons: string[]
}

/** Coverage of the selected pattern, never a worker-link finding count. */
export function patternCheckSummary(cardIds: Iterable<string>, results: ReadonlyMap<string, PatternResult>): PatternCoverage | null {
  const visible = [...new Set(cardIds)].filter(id => results.has(id))
  const unavailableCardIds = visible.filter(id => results.get(id)!.outcome === 'unavailable')
  const unknown = unavailableCardIds.map(id => results.get(id)!)
  if (!unknown.length) return null
  // Keep machine provenance in each card's inspector; the dial needs one useful reason.
  const reasons = [...new Set(unknown.map(result => {
    if (/source read failed|Notion source/i.test(result.reason)) return 'Card updates are missing or out of date'
    if (/Work status is not published/i.test(result.reason)) return 'Work status is missing'
    if (/Meaningful progress|heartbeat\/check-in age|no threshold can/i.test(result.reason)) return 'Progress timing is missing'
    if (/Tracked continuation/i.test(result.reason)) return 'Follow-on work has not been checked'
    return 'Worker or assignment evidence is missing'
  }))]

  return { unavailableCardIds, total: visible.length, evaluated: visible.length - unknown.length, confirmed: visible.filter(id => results.get(id)!.outcome === 'match').length,
    label: `${unknown.length} not evaluated`, reasons }
}

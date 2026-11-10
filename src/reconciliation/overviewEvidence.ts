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

/** One explanation for the unique visible cards a pattern could not check. */
export function patternCheckSummary(results: Iterable<PatternResult | undefined>): string | null {
  const unknown = [...results].filter((result): result is PatternResult => result?.outcome === 'unavailable')
  if (!unknown.length) return null
  const reasons = new Set(unknown.flatMap(result => result.reason.split('; ').map(reason => {
    if (/source read failed/i.test(reason)) return 'source read failed'
    if (/Notion source/i.test(reason)) return 'Notion source unavailable or stale'
    if (/Work status is not published/i.test(reason)) return 'work status unknown'
    if (/last reported|observation |liveness not observed/i.test(reason)) return 'worker observations incomplete or stale'
    if (/Home snapshot/i.test(reason)) return 'worker snapshots unavailable or stale'
    if (/(?:Running|Runnable) state unknown/i.test(reason)) return 'workers have no current update'
    if (/Worker decision requests/i.test(reason)) return 'worker decisions or links unknown'
    if (/accountability|source, link|assignment coverage/i.test(reason)) return 'worker links incomplete'
    if (/Runnable.*(?:coverage|unknown|availability)/i.test(reason)) return 'runnable work unknown'
    if (/resolver.*(?:coverage|unknown)/i.test(reason)) return 'resolver coverage incomplete'
    if (/Tracked continuation/i.test(reason)) return 'continuations not checked'
    if (/Meaningful progress|heartbeat\/check-in age|no threshold can/i.test(reason)) return 'progress time unknown'
    return reason
  }).filter(Boolean)))
  return `${unknown.length} ${unknown.length === 1 ? 'card' : 'cards'} not checked: ${[...reasons].join('; ')}`
}

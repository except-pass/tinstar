import type { FloorScene } from '../../shared/reconciliationPresentation'
import { currentActivity } from '../../shared/workReadiness'
import { externalWorkers } from '../../shared/workflow'
import { freshObservation } from '../../shared/workHealth'
import { declaredLinks } from './scene'

export interface ExecutionWarning {
  cardId: string; title: string; state: 'no-running-worker' | 'unknown'; reasons: string[]
  sources: Array<{ home: string; observedAt: string | null; expiresAt: string | null; status: string }>
}
/** Warnings only. Inspect the declared sources separately: a slow/unrelated
 * home cannot prove absence, or hide a known running worker elsewhere. */
export function executionWarnings(scene: FloorScene, now = Date.now()): ExecutionWarning[] {
  return scene.cards.flatMap(card => {
    if (card.source.archived || card.source.in_trash || card.source.properties.Status?.value !== 'In Progress') return []
    const reasons: string[] = [], sources: ExecutionWarning['sources'] = []
    const conflicting = scene.findings.some(finding => finding.cardIds.includes(card.id) && finding.workerLinkDetectors?.some(detector => ['duplicate-primary', 'spawn-evidence', 'invalid-record'].includes(detector)))
    let unknown = conflicting || !freshObservation(scene.coverage.intentions, now), running = false
    if (!freshObservation(scene.coverage.intentions, now)) reasons.push('Notion properties are stale or incomplete')
    if (conflicting) reasons.push('Worker relationship conflicts; verify its exact card and execution identity')
    const links = declaredLinks(card.source)
    const reports = externalWorkers(card.source.properties['Delegated To']?.value, now).filter(report => report.card_id === card.id)
    if (reports.some(report => report.freshness === 'current-report')) running = true
    if (reports.some(report => report.freshness === 'unknown')) { unknown = true; reasons.push('External worker report is stale; execution is unknown') }
    if (links.status !== 'valid') {
      unknown = true; reasons.push(links.reason)
    } else for (const link of links.tasks) {
      const home = scene.coverage.homes.find(home => home.source.home === link.fm_home)
      if (home) sources.push({ home: link.fm_home, status: home.observation.status, observedAt: home.observation.observedAt, expiresAt: home.observation.expiresAt })
      if (!home || !freshObservation(home.observation, now)) {
        unknown = true; reasons.push(`Worker source unavailable, stale or incomplete: ${link.fm_home}`); continue
      }
      const matches = scene.executions.filter(worker => worker.home === link.fm_home && worker.identity.task_id === link.task_id)
      if (matches.length > 1 || matches.some(worker => worker.identity.spawn_gen !== link.first_observed_spawn_gen)) {
        unknown = true; reasons.push(`Worker identity conflicts: ${link.fm_home}/${link.task_id}`); continue
      }
      const worker = matches[0]
      if (!worker) { reasons.push(`Declared worker absent from its complete fresh source: ${link.fm_home}/${link.task_id}`); continue }
      const activity = currentActivity(worker, now)
      if (activity === 'working') running = true
      else if (activity === 'unknown') { unknown = true; reasons.push(`Execution evidence unknown: ${link.fm_home}/${link.task_id}`) }
      else reasons.push(`Linked worker is ${activity}: ${link.fm_home}/${link.task_id}`)
    }
    // A positive current report suffices; stale siblings do not negate it.
    if (running && !conflicting && freshObservation(scene.coverage.intentions, now)) return []
    if (!reasons.length) reasons.push('Explicit worker declaration contains no running workers')
    return [{ cardId: card.id, title: String(card.source.properties.Name?.value ?? card.id), state: unknown ? 'unknown' as const : 'no-running-worker' as const, reasons, sources }]
  })
}

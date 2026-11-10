import type { FloorScene } from '../../shared/reconciliationPresentation'
import { activeReleaseLinks, type ReleasePull, type ReleasesRead } from '../../shared/releases'
import type { CardReleaseEligibility, DeploymentReceipt, ReleaseDryRun, TargetReconciliation } from '../../shared/releaseReconciliation'
import type { EvidenceRead } from './evidence'
import { checkReleaseAncestry, type AncestryCheck } from './ancestry'
import { receiptHash } from './cmsandbox'

function latestReceipt(rows: DeploymentReceipt[]) {
  const sorted = [...rows].sort((a, b) => Date.parse(b.deployedAt) - Date.parse(a.deployedAt) || a.id.localeCompare(b.id))
  const latest = sorted[0]
  const conflicting = latest && sorted.filter(row => Date.parse(row.deployedAt) === Date.parse(latest.deployedAt)).some(row =>
    row.deployedSha !== latest.deployedSha || row.artifactDigest !== latest.artifactDigest || row.outcome !== latest.outcome || JSON.stringify(row.exceptions) !== JSON.stringify(latest.exceptions))
  return { receipt: latest ?? null, conflicting: !!conflicting }
}
/** Deterministic dry run only: immutable observations in, eligibility out. No domain writes. */
export async function reconcileReleases(data: ReleasesRead, scene: FloorScene, evidence: EvidenceRead, ancestry: AncestryCheck = checkReleaseAncestry): Promise<ReleasesRead> {
  const pulls: ReleasePull[] = []
  const ancestryCache = new Map<string, Awaited<ReturnType<AncestryCheck>>>()
  for (const original of data.pulls) {
    const pull: ReleasePull = { ...original, exceptions: [...original.exceptions] }, targets: TargetReconciliation[] = []
    const required = evidence.requirements.get(pull.id)
    if (!required) pull.exceptions.push('Required production component/target mapping is missing')
    else {
      pull.exceptions.push(...required.exceptions)
      for (const target of required.targets) {
        const selected = latestReceipt(evidence.receipts.filter(receipt => receipt.repository === pull.repository && receipt.environment === 'production' && receipt.target === target.target && receipt.component === target.component))
        const result: TargetReconciliation = { ...target, state: 'unknown', reason: 'Production evidence missing', ancestry: 'unknown', receipt: selected.receipt }
        const receipt = selected.receipt, checkout = evidence.repositories.get(pull.repository)
        if (!['fresh', 'snapshot'].includes(evidence.status)) result.reason = `Production evidence source ${evidence.status}`
        else if (selected.conflicting) result.reason = 'Conflicting deployment receipts at the same time'
        else if (!receipt) result.reason = 'No production receipt for the exact repository, component and target'
        else if (evidence.collectedAt && Date.parse(receipt.deployedAt) > Date.parse(evidence.collectedAt) + 60_000) result.reason = 'Deployment receipt is newer than the current-state snapshot'
        else if (receipt.outcome !== 'succeeded' || receipt.exceptions.length) result.reason = `${receipt.outcome}: ${receipt.exceptions.join('; ') || 'deployment is not safely complete'}`
        else if (required.exceptions.length) result.reason = required.exceptions.join('; ')
        else if (pull.state !== 'merged' || pull.freshness !== 'fresh' || !pull.mergeSha) result.reason = 'Fresh GitHub effective merge identity is required'
        else if (!receipt.deployedSha) result.reason = 'Immutable artifact digest has no verified repository/source provenance'
        else if (!checkout) result.reason = 'Read-only repository checkout is not mapped'
        else {
          const key = `${pull.repository}:${checkout}:${pull.mergeSha}:${receipt.deployedSha}`
          let read = ancestryCache.get(key)
          if (!read) {
            try { read = await ancestry(pull.repository, checkout, pull.mergeSha, receipt.deployedSha) }
            catch { read = { state: 'unknown', reason: 'Git ancestry read failed' } }
            ancestryCache.set(key, read)
          }
          result.ancestry = read.state
          result.state = read.state === 'ancestor' ? 'live' : read.state === 'not-ancestor' ? 'absent' : 'unknown'
          result.reason = read.reason ?? (result.state === 'live' ? 'Effective merge is an ancestor of the deployed component source' : 'Effective merge is absent from the deployed component source')
        }
        if (result.state === 'unknown') pull.exceptions.push(`${target.component} / ${target.target}: ${result.reason}`)
        targets.push(result)
      }
    }
    pull.exceptions = [...new Set(pull.exceptions)]
    pull.deployment = { state: !pull.exceptions.length && targets.length && targets.every(target => target.state === 'live') ? 'shipped'
      : !pull.exceptions.length && targets.some(target => target.state === 'absent') ? 'in-queue' : 'unknown', targets }
    pulls.push(pull)
  }
  const cards: CardReleaseEligibility[] = scene.cards.filter(card => !card.source.in_trash && !card.source.archived &&
    (card.source.properties.Status?.value === 'Waiting for Prod Release' || pulls.some(pull => activeReleaseLinks(pull).some(link => link.cardId === card.id))))
    .map(card => {
      const linked = pulls.filter(pull => activeReleaseLinks(pull).some(link => link.cardId === card.id))
      const status = String(card.source.properties.Status?.value ?? ''), owner = String(card.source.properties.Owner?.value ?? 'Unassigned')
      const requiresProductionVerification = card.source.properties['Requires production verification']?.value === true
      const reasons: string[] = []
      if (!data.associationsComplete) reasons.push('Card/PR association sources are incomplete')
      if (!linked.length) reasons.push('Card has no explicit required PR association')
      for (const pull of linked) if (pull.deployment?.state !== 'shipped') reasons.push(`${pull.url}: ${pull.deployment?.state === 'in-queue' ? 'required change is not in deployed source' : pull.exceptions.join('; ') || 'deployment unknown'}`)
      const allLive = data.associationsComplete && linked.length > 0 && linked.every(pull => pull.deployment?.state === 'shipped')
      const decision: CardReleaseEligibility['decision'] = status !== 'Waiting for Prod Release' ? 'unrelated' : allLive ? requiresProductionVerification ? 'would-verify' : 'would-complete'
        : !linked.length || !data.associationsComplete || linked.some(pull => pull.deployment?.state === 'unknown') ? 'exception' : 'waiting'
      return { cardId: card.id, status, owner, requiresProductionVerification, requiredPulls: linked.map(pull => pull.url).sort(),
        eligible: decision === 'would-complete', decision, reasons,
        receiptIds: [...new Set(linked.flatMap(pull => pull.deployment?.targets.flatMap(target => target.receipt ? [target.receipt.id] : []) ?? []))].sort() }
    }).sort((a, b) => a.cardId.localeCompare(b.cardId))
  for (const pull of pulls) if (pull.deployment) pull.deployment.verificationRequired = activeReleaseLinks(pull).some(link => cards.some(card => card.cardId === link.cardId && card.requiresProductionVerification && (card.decision === 'would-verify' || card.status === 'In Progress')))
  const report: ReleaseDryRun = {
    mode: 'dry-run', id: receiptHash({ pulls: pulls.map(pull => ({ id: pull.id, mergeSha: pull.mergeSha, exceptions: pull.exceptions, deployment: pull.deployment })), cards, sourceStatus: evidence.status }),
    sourceStatus: evidence.status, collectedAt: evidence.collectedAt,
    lastSuccessfulAt: evidence.status === 'fresh' && pulls.length > 0 && pulls.every(pull => pull.deployment?.state !== 'unknown') ? evidence.collectedAt : null,
    warnings: [...evidence.warnings], cards,
    targets: [...new Map(evidence.receipts.filter(receipt => receipt.environment === 'production').sort((a, b) => Date.parse(a.deployedAt) - Date.parse(b.deployedAt)).map(receipt => ({ repository: receipt.repository, target: receipt.target, component: receipt.component, version: receipt.version,
      deployedSha: receipt.deployedSha, artifactDigest: receipt.artifactDigest, receiptUrl: receipt.receiptUrl, observedAt: receipt.deployedAt })).map(target => [`${target.repository}:${target.target}:${target.component}`, target])).values()],
  }
  return { ...data, pulls, reconciliation: report }
}

/** A large or unavailable mirror must not hold the HTTP read indefinitely.
 * Cache immutable commit-pair answers; failed reads retry, remaining pairs stay explicitly pending. */
export class ReleaseReconciler {
  private cache = new Map<string, { until: number; value: Awaited<ReturnType<AncestryCheck>> }>()
  constructor(private check: AncestryCheck = checkReleaseAncestry, private now = Date.now) {}
  async get(data: ReleasesRead, scene: FloorScene, evidence: EvidenceRead) {
    let budget = 8
    const deadline = this.now() + 10_000
    return reconcileReleases(data, scene, evidence, async (repository, checkout, mergeSha, deployedSha) => {
      const key = JSON.stringify([repository, checkout, mergeSha, deployedSha]), previous = this.cache.get(key)
      if (previous && previous.until > this.now()) return previous.value
      if (budget <= 0 || this.now() > deadline) return { state: 'unknown', reason: 'Ancestry read pending; remaining checks continue on refresh' }
      budget--
      let value: Awaited<ReturnType<AncestryCheck>>
      try { value = await this.check(repository, checkout, mergeSha, deployedSha) }
      catch { value = { state: 'unknown', reason: 'Git ancestry read failed' } }
      if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { until: this.now() + (value.state === 'unknown' ? 60_000 : 600_000), value })
      return value
    })
  }
}

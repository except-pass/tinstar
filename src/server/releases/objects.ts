import type { ReleaseObject, ReleaseTarget } from '../../shared/releaseObjects'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import { activeReleaseLinks, type ReleasesRead } from '../../shared/releases'
import type { EvidenceRead } from './evidence'
import { cmsandboxReceipts, receiptHash } from './cmsandbox'
import { ReleaseMembershipReader } from './membership'
import { releaseChanges } from '../../shared/releaseChanges'
import { ReleaseReconciler } from './reconcile'

/** Frozen coordinator objects and committed observations only. No tag creates a release. */
export function coordinatorReleaseObjects(evidence: EvidenceRead): ReleaseObject[] {
  const releases = new Map<string, ReleaseObject>()
  const coordinatorReceiptIds = new Set<string>()
  for (const source of evidence.coordinatorSources ?? []) {
    const bundle = source.bundle
    for (const receipt of cmsandboxReceipts(bundle)) coordinatorReceiptIds.add(receipt.id)
    const chain: Array<{ digest: string; event: any }> = []
    let next = bundle.control.head
    while (next) { const event = bundle.journal[next]; chain.push({ digest: next, event }); next = event.previous }
    const bindings = new Map<string, { digest: string; event: any; observed: boolean }>()
    for (const { digest, event } of chain.reverse()) {
      const binding = event.binding, key = receiptHash(binding), previous = bindings.get(key)
      const record = event.state?.releases?.[binding.release_id]
      // A mere claim/open/tag is never an observed production release. Retain
      // attempts that actually reached target readback, including later supersedes.
      const observed = previous?.observed || Object.entries(record?.steps ?? {}).some(([id, step]: [string, any]) =>
        ['service', 'static'].includes(bundle.objects[binding.plan]?.execution?.steps?.[id]?.kind) && !!step.verified)
      bindings.set(key, { digest, event, observed: !!observed })
    }
    const entries = [...bindings.values()].reverse()
    const boundPlans = new Set(entries.map(({ event }) => event.binding.plan))
    for (const [planId, plan] of Object.entries(bundle.objects) as Array<[string, any]>) {
      const candidate = bundle.objects[plan?.candidate]
      if (boundPlans.has(planId) || receiptHash(plan) !== planId || !candidate || receiptHash(candidate) !== plan.candidate) continue
      entries.push({ digest: '', observed: false, event: { binding: { plan: planId, manifest: plan.candidate, release_id: candidate.tag?.name ?? planId } } })
    }
    for (const { digest, event, observed } of entries) {
      const binding = event.binding, plan = bundle.objects[binding.plan], candidate = bundle.objects[binding.manifest]
      if (!plan || !candidate || plan.candidate !== binding.manifest) continue
      const targetMap = new Map<string, ReleaseTarget>()
      for (const step of Object.values(plan.execution?.steps ?? {}) as any[]) {
        if (!['service', 'static'].includes(step.kind)) continue
        const members = step.kind === 'service' ? step.members : [{ component: step.component, target: step.target }]
        for (const member of members ?? []) {
          const target = member.target ?? {}, component = member.component
          const id = target.adapter === 'ecs' ? `${target.account}/${target.region}/${target.cluster}/${target.service}/${target.container}`
            : `${target.account}/${target.region}/${target.bucket ?? ''}/${target.key ?? target.prefix ?? ''}`
          const componentPlan = plan.components?.[component] ?? {}
          targetMap.set(`${id}:${component}`, { component, target: id, readiness: String(componentPlan.readiness ?? plan.readiness ?? 'unknown'),
            readinessEvidence: (candidate.desired?.[component]?.checks ?? []).map((check: any) => ({ name: String(check.name ?? check.kind), status: String(check.status ?? 'unknown'), url: typeof check.url === 'string' && check.url.startsWith('https://') ? check.url : null })), receipt: null })
        }
      }
      const common = { repository: bundle.repository, version: String(candidate.tag?.name ?? binding.release_id), sourceSha: candidate.tag?.sha ?? null,
        candidateId: binding.manifest, planId: binding.plan, scope: Object.keys(candidate.desired ?? {}),
        observedAt: bundle.journalMetadata[digest]?.lastModified ?? null,
        provenance: { source: digest ? 'Coordinator frozen manifest, plan and committed PROD journal' : 'Coordinator frozen manifest and plan', asOf: source.asOf, historical: source.historical || evidence.status !== 'fresh' },
        membership: { status: 'pending' as const, baseline: null, baselineSha: null, observedAt: null, reason: 'Reading Git release membership' }, pulls: [],
        gaps: [...evidence.warnings, ...(plan.coverage_gaps ?? []), ...(plan.compatibility_gaps ?? [])].map(String) }
      const candidateId = `${bundle.repository}:candidate:${binding.manifest}:${binding.plan}`
      releases.set(candidateId, { ...common, id: candidateId, kind: 'candidate', executionId: null, targets: [...targetMap.values()],
        state: plan.readiness === 'ready' ? 'Ready' : plan.readiness === 'blocked' ? 'Blocked' : 'Needs review',
        evidenceUrl: `https://github.com/${bundle.repository}/tree/${common.sourceSha}` })
      if (!observed) continue
      const receipts = cmsandboxReceipts({ ...bundle, control: { head: digest } }, false).filter(receipt => receipt.id.startsWith(`${digest}:`))
      const targets = [...targetMap.values()].map(target => ({ ...target, receipt: receipts.find(receipt => receipt.component === target.component && receipt.target === target.target) ?? null }))
      const productionId = `${bundle.repository}:production:${binding.release_id}:${digest}`
      const state = event.result?.status === 'superseded' ? 'Superseded' : event.command?.type === 'close' && event.state?.releases?.[binding.release_id]?.status === 'completed' && targets.length && targets.every(target => target.receipt?.outcome === 'succeeded') ? 'Needs review' : 'Partial rollout'
      releases.set(productionId, { ...common, id: productionId, kind: 'production', executionId: digest, targets, state,
        evidenceUrl: receipts[0]?.receiptUrl ?? null,
        gaps: [...common.gaps, ...(state === 'Superseded' ? ['This historical attempt was superseded; it does not certify current production'] : [])] })
    }
  }
  // Legacy component collectors remain truthful without fabricating a shared
  // coordinator binding from equal version labels. Each receipt keeps its own
  // identity until an authoritative release/attempt association is supplied.
  const covered = new Set([...releases.values()].flatMap(release => release.targets.flatMap(target => target.receipt ? [target.receipt.id] : [])))
  for (const receipt of evidence.receipts) {
    if (receipt.environment !== 'production' || coordinatorReceiptIds.has(receipt.id) || covered.has(receipt.id)) continue
    const identityKnown = !!(receipt.deployedSha || receipt.artifactDigest)
    const id = `${receipt.repository}:component-receipt:${receipt.id}:${receipt.target}:${receipt.component}`
    releases.set(id, { id, repository: receipt.repository, kind: 'production', version: receipt.version ?? receipt.id,
      sourceSha: receipt.deployedSha, candidateId: null, planId: null, executionId: receipt.id, scope: [receipt.component],
      state: !identityKnown ? 'Production evidence unavailable' : receipt.outcome === 'succeeded' && !receipt.exceptions.length ? 'Needs review' : 'Partial rollout',
      observedAt: receipt.deployedAt, provenance: { source: 'Component deployment receipt; coordinator release binding unavailable', asOf: evidence.collectedAt ?? 'Unknown collection time', historical: evidence.status !== 'fresh' },
      targets: [{ component: receipt.component, target: receipt.target, readiness: 'Unknown', readinessEvidence: [], receipt }], evidenceUrl: receipt.receiptUrl,
      membership: { status: 'pending', baseline: null, baselineSha: null, observedAt: null, reason: 'Reading Git release membership' }, pulls: [],
      gaps: ['Coordinator candidate/plan association is unavailable; this record covers only the named component and target', ...receipt.exceptions, ...evidence.warnings] })
  }
  return [...releases.values()]
}

export class ReleaseObjectReader {
  constructor(private memberships = new ReleaseMembershipReader(), private reconciler = new ReleaseReconciler()) {}
  async get(evidence: EvidenceRead, data: ReleasesRead, scene: FloorScene) {
    const releases = coordinatorReleaseObjects(evidence)
    // A source range is read once per response even when several attempts share it.
    const ranges = new Map<string, Awaited<ReturnType<ReleaseMembershipReader['get']>>>()
    for (const release of releases) {
      const key = `${release.repository}:${release.sourceSha}:${release.version}`
      let range = ranges.get(key)
      if (!range) { range = await this.memberships.get(release.repository, release.sourceSha, release.version); ranges.set(key, range) }
      release.membership = { ...range.membership }
      const pulls = [...range.pulls.values()].map(pull => ({ ...pull, links: data.pulls.find(existing => existing.id === pull.id)?.links ?? [], exceptions: [] }))
      const memberIds = new Set(pulls.map(pull => pull.id))
      const cardIds = new Set(pulls.flatMap(pull => activeReleaseLinks(pull).map(link => link.cardId)))
      const supporting = data.pulls.filter(pull => !memberIds.has(pull.id) && activeReleaseLinks(pull).some(link => cardIds.has(link.cardId)))
      const scoped = await this.reconciler.get({ ...data, pulls: [...pulls, ...supporting] }, scene, { ...evidence,
        collectedAt: release.candidateId ? release.provenance.asOf : evidence.collectedAt,
        receipts: release.kind === 'production' ? release.targets.flatMap(target => target.receipt ? [target.receipt] : []) : [] })
      release.pulls = scoped.pulls.filter(pull => memberIds.has(pull.id))
      release.supportingPulls = scoped.pulls.filter(pull => !memberIds.has(pull.id))
      const changes = releaseChanges(release, data, scene)
      if (release.kind === 'production' && release.state === 'Needs review' && changes.length && changes.every(change => change.delivery === 'Deployed' && change.acceptance === 'Passed')) release.state = 'Accepted'
      if (range.membership.reason) release.gaps.unshift(range.membership.reason)
      if (!data.associationsComplete) release.gaps.push('Notion PR/card association sources are incomplete; known explicit links are retained')
    }
    return releases
  }
}

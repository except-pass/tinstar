import { createHash } from 'node:crypto'
import type { DeploymentReceipt } from '../../shared/releaseReconciliation'

const object = (input: unknown): Record<string, any> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, any> : {}
const canonical = (input: any): string => Array.isArray(input) ? `[${input.map(canonical).join(',')}]` : input && typeof input === 'object'
  ? `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}` : JSON.stringify(input)
/** Upstream keys are content-addressed. Verify them to avoid joining a receipt to the wrong frozen artifact. */
export const receiptHash = (input: unknown) => `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`
const sha = (input: unknown): input is string => typeof input === 'string' && /^[a-f0-9]{40,64}$/.test(input)
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
const bucket = 'fortresspower-cmsandbox-release-prod-298117917676'
// read_method and other descriptions are not deployed identity. Keep exact runtime
// fields, including the static key so runtime JSON and the portal cannot collide.
const targetIdentity = (input: unknown) => {
  const target = object(input)
  return Object.fromEntries(['adapter', 'account', 'region', 'cluster', 'service', 'container', 'bucket', 'prefix', 'key'].map(key => [key, target[key] ?? null]))
}
const verifiedIdentity = (input: unknown) => {
  const value = object(input)
  return { kind: value.kind, target: targetIdentity(value.target), digest: value.digest, revision: value.revision ?? null, config_digest: value.config_digest ?? null }
}

/** Consume the coordinator's current committed journal chain and frozen objects.
 * An orphan event, rehearsal, stage-only step or partial release never certifies PROD. */
export function cmsandboxReceipts(input: unknown): DeploymentReceipt[] {
  const bundle = object(input)
  requireThat(bundle.schema === 'tinstar.cmsandbox-production-export.v1' && bundle.repository === 'fortresspower/cmsandbox' && bundle.bucket === bucket, 'Unsupported cmsandbox production export')
  const journal = object(bundle.journal), objects = object(bundle.objects), metadata = object(bundle.journalMetadata)
  const checked = new Map<string, Record<string, any>>()
  const get = (digest: unknown) => {
    if (typeof digest === 'string' && checked.has(digest)) return checked.get(digest)!
    requireThat(typeof digest === 'string' && objects[digest] && receiptHash(objects[digest]) === digest, 'Frozen coordinator object missing or corrupted')
    const value = object(objects[digest]); checked.set(digest, value); return value
  }
  const chain: Array<{ digest: string; event: Record<string, any> }> = [], visited = new Set<string>()
  let next = object(bundle.control).head
  requireThat(typeof next === 'string', 'Current coordinator control pointer missing')
  while (next) {
    requireThat(typeof next === 'string' && !visited.has(next) && visited.size < 1000, 'Invalid coordinator journal chain')
    visited.add(next)
    const event = object(journal[next])
    requireThat(receiptHash(event) === next && event.schema === 'cmsandbox.release.production-event' && event.schema_version === 1 && event.mode === 'live', 'Invalid production journal event')
    chain.push({ digest: next, event }); next = event.previous
  }
  const current = new Map<string, DeploymentReceipt>()
  const priorReleases = new Map<string, Record<string, any>>()
  for (const { digest, event } of chain.reverse()) {
    const binding = object(event.binding)
    let release = object(object(event.state).releases?.[binding.release_id])
    // A coordinator supersede removes the old binding from state. It certifies
    // nothing; the replacement release's committed events supply its own proof.
    if (!release.binding && event.result?.status === 'superseded') {
      const prior = priorReleases.get(receiptHash(binding))
      if (!prior) continue
      // Superseding a previously observed binding invalidates its old success;
      // an absent replacement cannot accidentally revive historical receipts.
      release = { ...prior, status: 'superseded', steps: {} }
    }
    requireThat(release.binding && receiptHash(release.binding) === receiptHash(binding), 'Coordinator release binding conflicts')
    priorReleases.set(receiptHash(binding), release)
    const plan = get(binding.plan), candidate = get(binding.manifest)
    requireThat(plan.mode === 'live' && candidate.mode === 'live' && plan.candidate === binding.manifest && plan.execution?.mode === 'live' && plan.execution?.production_enabled === true && plan.execution_authorized === true && plan.readiness !== 'blocked', 'Frozen plan is not production execution evidence')
    const inputs = get(plan.inputs)
    requireThat(inputs.mode === 'live', 'Frozen inputs are not production evidence')
    const at = object(metadata[digest]).lastModified
    requireThat(typeof at === 'string' && Number.isFinite(Date.parse(at)), 'Production journal LastModified metadata missing')
    const workflow = String(release.worker_run ?? '')
    requireThat(/^\d+$/.test(workflow), 'Production worker run provenance missing')
    const succeeded = event.command?.type === 'close' && release.status === 'completed' && event.result?.execution_authorized === true
    const rollback = !!inputs.execution?.rollback
    for (const step of Object.values(object(plan.execution.steps)).map(object)) {
      if (!['service', 'static'].includes(step.kind)) continue
      const members = step.kind === 'service' ? step.members : [{ component: step.component, target: step.target, desired: step.desired }]
      requireThat(Array.isArray(members) && members.length > 0, 'Deployed component members missing')
      const completion = object(release.steps?.[step.id])
      const expected = { kind: step.kind, target: step.target ?? step.destination, digest: step.desired, revision: step.kind === 'service' ? step.config?.revision : step.revision ?? null, config_digest: step.kind === 'service' ? step.config?.digest : null }
      const verified = succeeded && step.action !== 'skip' && completion.status === 'succeeded' && receiptHash(verifiedIdentity(completion.verified)) === receiptHash(verifiedIdentity(expected))
      for (const member of members.map(object)) {
        const selected = object(candidate.desired?.[member.component]), target = object(member.target)
        requireThat(target.adapter !== 'ecs' || [target.cluster, target.service, target.container].every(value => typeof value === 'string' && value.length > 0), 'Exact deployed ECS target missing')
        const targetId = target.adapter === 'ecs' ? `${target.account}/${target.region}/${target.cluster}/${target.service}/${target.container}`
          : `${target.account}/${target.region}/${target.bucket ?? ''}/${target.key ?? target.prefix ?? ''}`
        requireThat(typeof member.component === 'string' && target.account === '298117917676' && target.region === 'us-west-2', 'Production target identity missing or wrong environment')
        let source = selected.source_sha
        const identityMatches = selected.artifact?.digest === member.desired
        if (selected.build_record) {
          const stored = objects[selected.build_record]
          const build = object(stored && receiptHash(stored) === selected.build_record ? stored : (Array.isArray(inputs.builds) ? inputs.builds.find((build: unknown) => receiptHash(build) === selected.build_record) : null))
          if (build.source?.repository !== bundle.repository || build.source?.sha !== source || build.artifact?.digest !== member.desired || build.trust?.level !== 'trusted-main') source = null
        } else if (step.kind !== 'static' || source !== candidate.tag?.sha || receiptHash(step.objects) !== member.desired) source = null
        const invalid = !verified || !identityMatches || !sha(source)
        const outcome = rollback ? 'rollback' : invalid ? 'partial' : 'succeeded'
        current.set(`${targetId}:${member.component}`, {
          id: `${digest}:${member.component}`, repository: bundle.repository, target: targetId, component: member.component, environment: 'production',
          deployedSha: sha(source) ? source : null, artifactDigest: typeof member.desired === 'string' ? member.desired : null,
          version: typeof candidate.tag?.name === 'string' ? candidate.tag.name : null, deployedAt: at,
          workflowUrl: `https://github.com/fortresspower/cmsandbox/actions/runs/${workflow}`,
          receiptUrl: `https://s3.console.aws.amazon.com/s3/object/${bucket}?region=us-west-2&prefix=${encodeURIComponent(`coordinator/production/v1/journal/${digest.slice(7)}.json`)}`,
          outcome, exceptions: rollback ? ['Coordinator rollback requires reconciliation'] : invalid ? ['Coordinator release is partial, unverified, or source provenance is missing'] : [],
        })
      }
    }
  }
  return [...current.values()]
}

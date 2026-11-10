import { receiptHash } from '../../src/server/releases/cmsandbox'

/** Native coordinator field contracts from production-actions/coordination/execution-plan.
 * Data is synthetic: never represents a real production deployment. */
export function coordinatorExport(options: { partial?: boolean; rollback?: boolean; stageOnly?: boolean; sourceMismatch?: boolean; pendingTarget?: boolean } = {}) {
  const target = { adapter: 'ecs', account: '298117917676', region: 'us-west-2', cluster: 'manager-analysis', service: 'manager-analysis-service', container: 'manager-analysis-prod-container' }
  const artifact = `sha256:${'d'.repeat(64)}`, source = 'b'.repeat(40)
  const build = { schema: 'cmsandbox.release.build-record', schema_version: 1, source: { repository: 'fortresspower/cmsandbox', sha: options.sourceMismatch ? 'c'.repeat(40) : source }, artifact: { digest: artifact }, trust: { level: 'trusted-main' } }
  const buildRef = receiptHash(build)
  const candidate = { mode: 'live', tag: { name: 'v1.24.0', sha: 'f'.repeat(40) }, desired: { 'manager-analysis': { artifact: { digest: artifact }, source_sha: source, build_record: buildRef } } }
  const manifest = receiptHash(candidate)
  const inputs = { mode: 'live', execution: options.rollback ? { rollback: { source_plan: 'prior-plan' } } : {} }
  const inputRef = receiptHash(inputs)
  const step = { id: 'manager-analysis', kind: options.stageOnly ? 'stage-oci' : 'service', component: 'manager-analysis', target, desired: artifact, action: 'update', config: { revision: 'arn:aws:ecs:us-west-2:298117917676:task-definition/manager:12', digest: `sha256:${'e'.repeat(64)}` }, members: [{ component: 'manager-analysis', target, desired: artifact }] }
  const plan = { mode: 'live', candidate: manifest, inputs: inputRef, execution_authorized: true, readiness: 'ready', execution: { mode: 'live', production_enabled: true, steps: { 'manager-analysis': step, ...(options.pendingTarget ? { 'pending-worker': { ...step, id: 'pending-worker', component: 'pending-worker', target: { ...target, service: 'pending-worker-service' }, members: [{ component: 'pending-worker', target: { ...target, service: 'pending-worker-service' }, desired: artifact }] } } : {}) } } }
  const planRef = receiptHash(plan), binding = { release_id: 'v1.24.0', manifest, plan: planRef, baseline: `sha256:${'a'.repeat(64)}` }
  const verified = { kind: step.kind, target: step.target, digest: step.desired, revision: step.config.revision, config_digest: step.config.digest }
  const release = { binding, worker_run: '12345', status: options.partial ? 'stopped' : 'completed', steps: { 'manager-analysis': { status: options.partial ? 'failed' : 'succeeded', verified } } }
  const event = { schema: 'cmsandbox.release.production-event', schema_version: 1, mode: 'live', previous: null as string | null, binding, command: { type: options.partial ? 'finish' : 'close' }, result: { execution_authorized: true }, state: { active: options.partial ? 'v1.24.0' : null, releases: { 'v1.24.0': release } } }
  const head = receiptHash(event)
  const bundle: any = { schema: 'tinstar.cmsandbox-production-export.v1', repository: 'fortresspower/cmsandbox', bucket: 'fortresspower-cmsandbox-release-prod-298117917676', collectedAt: '2026-11-06T18:15:00Z', control: { head }, journal: { [head]: event }, journalMetadata: { [head]: { lastModified: '2026-11-06T18:10:00Z' } }, objects: { [manifest]: candidate, [planRef]: plan, [inputRef]: inputs, [buildRef]: build } }
  return { bundle, event, release, candidate, plan, step, source, head }
}

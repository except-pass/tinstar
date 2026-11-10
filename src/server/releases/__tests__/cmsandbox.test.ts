import { describe, expect, it } from 'vitest'
import { cmsandboxReceipts, receiptHash } from '../cmsandbox'

/** Native coordinator field contracts from production-actions/coordination/execution-plan.
 * Data is synthetic: never represents a real production deployment. */
export function coordinatorExport(options: { partial?: boolean; rollback?: boolean; stageOnly?: boolean; sourceMismatch?: boolean } = {}) {
  const target = { adapter: 'ecs', account: '298117917676', region: 'us-west-2', cluster: 'manager-analysis', service: 'manager-analysis-service', container: 'manager-analysis-prod-container' }
  const artifact = `sha256:${'d'.repeat(64)}`, source = 'b'.repeat(40)
  const build = { schema: 'cmsandbox.release.build-record', schema_version: 1, source: { repository: 'fortresspower/cmsandbox', sha: options.sourceMismatch ? 'c'.repeat(40) : source }, artifact: { digest: artifact }, trust: { level: 'trusted-main' } }
  const buildRef = receiptHash(build)
  const candidate = { mode: 'live', tag: { name: 'v1.24.0', sha: 'f'.repeat(40) }, desired: { 'manager-analysis': { artifact: { digest: artifact }, source_sha: source, build_record: buildRef } } }
  const manifest = receiptHash(candidate)
  const inputs = { mode: 'live', execution: options.rollback ? { rollback: { source_plan: 'prior-plan' } } : {} }
  const inputRef = receiptHash(inputs)
  const step = { id: 'manager-analysis', kind: options.stageOnly ? 'stage-oci' : 'service', component: 'manager-analysis', target, desired: artifact, action: 'update', config: { revision: 'arn:aws:ecs:us-west-2:298117917676:task-definition/manager:12', digest: `sha256:${'e'.repeat(64)}` }, members: [{ component: 'manager-analysis', target, desired: artifact }] }
  const plan = { mode: 'live', candidate: manifest, inputs: inputRef, execution_authorized: true, readiness: 'ready', execution: { mode: 'live', production_enabled: true, steps: { 'manager-analysis': step } } }
  const planRef = receiptHash(plan), binding = { release_id: 'v1.24.0', manifest, plan: planRef, baseline: `sha256:${'a'.repeat(64)}` }
  const verified = { kind: step.kind, target: step.target, digest: step.desired, revision: step.config.revision, config_digest: step.config.digest }
  const release = { binding, worker_run: '12345', status: options.partial ? 'stopped' : 'completed', steps: { 'manager-analysis': { status: options.partial ? 'failed' : 'succeeded', verified } } }
  const event = { schema: 'cmsandbox.release.production-event', schema_version: 1, mode: 'live', previous: null as string | null, binding, command: { type: options.partial ? 'finish' : 'close' }, result: { execution_authorized: true }, state: { active: options.partial ? 'v1.24.0' : null, releases: { 'v1.24.0': release } } }
  const head = receiptHash(event)
  const bundle: any = { schema: 'tinstar.cmsandbox-production-export.v1', repository: 'fortresspower/cmsandbox', bucket: 'fortresspower-cmsandbox-release-prod-298117917676', collectedAt: '2026-11-06T18:15:00Z', control: { head }, journal: { [head]: event }, journalMetadata: { [head]: { lastModified: '2026-11-06T18:10:00Z' } }, objects: { [manifest]: candidate, [planRef]: plan, [inputRef]: inputs, [buildRef]: build } }
  return { bundle, event, release, candidate, plan, step, source, head }
}

describe('native cmsandbox production evidence', () => {
  it('consumes verified component identity and source provenance from committed immutable records, not the monorepo tag', () => {
    const { bundle, source, head } = coordinatorExport()
    expect(cmsandboxReceipts(bundle)).toEqual([expect.objectContaining({ id: `${head}:manager-analysis`, repository: 'fortresspower/cmsandbox', deployedSha: source, outcome: 'succeeded', target: '298117917676/us-west-2/manager-analysis/manager-analysis-service/manager-analysis-prod-container', workflowUrl: 'https://github.com/fortresspower/cmsandbox/actions/runs/12345' })])
  })
  it('resolves the selected build from frozen inputs when no separate build object is published', () => {
    const { bundle, plan, candidate } = coordinatorExport()
    const oldPlan = receiptHash(plan), oldInputs = plan.inputs, buildRef = candidate.desired['manager-analysis'].build_record
    const inputs = { ...bundle.objects[oldInputs], builds: [bundle.objects[buildRef]] }
    const inputRef = receiptHash(inputs)
    plan.inputs = inputRef
    const planRef = receiptHash(plan)
    const event = bundle.journal[bundle.control.head]!
    event.binding.plan = planRef
    const head = receiptHash(event)
    const metadata = bundle.journalMetadata[bundle.control.head]!
    delete bundle.objects[oldPlan]; delete bundle.objects[oldInputs]; delete bundle.objects[buildRef]
    Object.assign(bundle.objects, { [inputRef]: inputs, [planRef]: plan })
    bundle.control.head = head; bundle.journal = { [head]: event }; bundle.journalMetadata = { [head]: metadata }
    expect(cmsandboxReceipts(bundle)[0]!.outcome).toBe('succeeded')
  })
  it('keeps partial, rollback, missing provenance, stage-only and orphan events from claiming shipment', () => {
    expect(cmsandboxReceipts(coordinatorExport({ partial: true }).bundle)[0]!.outcome).toBe('partial')
    expect(cmsandboxReceipts(coordinatorExport({ rollback: true }).bundle)[0]!.outcome).toBe('rollback')
    expect(cmsandboxReceipts(coordinatorExport({ sourceMismatch: true }).bundle)[0]!.outcome).toBe('partial')
    expect(cmsandboxReceipts(coordinatorExport({ stageOnly: true }).bundle)).toEqual([])
    const { bundle } = coordinatorExport({ partial: true }), orphan = coordinatorExport()
    Object.assign(bundle.journal, orphan.bundle.journal)
    expect(cmsandboxReceipts(bundle)[0]!.outcome).toBe('partial')
  })
  it('rejects wrong environment, damaged objects, missing committed pointer or receipt timestamps', () => {
    const { bundle, plan, head } = coordinatorExport()
    plan.mode = 'fixture'
    expect(() => cmsandboxReceipts(bundle)).toThrow('corrupted')
    const other = coordinatorExport(); other.bundle.bucket = 'dev-bucket'
    expect(() => cmsandboxReceipts(other.bundle)).toThrow('Unsupported')
    const missing = coordinatorExport(); missing.bundle.control.head = 'sha256:' + '0'.repeat(64)
    expect(() => cmsandboxReceipts(missing.bundle)).toThrow('journal event')
    const metadata = coordinatorExport(); delete metadata.bundle.journalMetadata[head]
    expect(() => cmsandboxReceipts(metadata.bundle)).toThrow('LastModified')
  })
})

it('reads an exported committed store with a superseded binding and preserved journal timestamps', async () => {
  const { mkdtemp, mkdir, writeFile, utimes, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { readCoordinatorStore } = await import('../coordinatorStore')
  const { bundle, event, release } = coordinatorExport()
  const superseded = { ...event, binding: { ...event.binding, plan: `sha256:${'0'.repeat(64)}` }, state: { releases: {} }, command: { type: 'close' }, result: { status: 'superseded' }, previous: null }
  const previous = receiptHash(superseded)
  // Descriptive metadata does not change a deployment identity.
  release.steps['manager-analysis'].verified.target = { ...release.steps['manager-analysis'].verified.target, read_method: 'Changed display description' } as typeof release.steps['manager-analysis']['verified']['target']
  event.previous = previous
  const head = receiptHash(event), at = '2026-11-06T18:10:00Z'
  const root = await mkdtemp(join(tmpdir(), 'native-store-'))
  try {
    await mkdir(join(root, 'journal')); await mkdir(join(root, 'objects'))
    await writeFile(join(root, 'control.json'), JSON.stringify({ head }))
    for (const [id, value] of Object.entries({ [previous]: superseded, [head]: event })) {
      const path = join(root, 'journal', `${id.slice(7)}.json`)
      await writeFile(path, JSON.stringify(value)); await utimes(path, new Date(at), new Date(at))
    }
    for (const [id, value] of Object.entries(bundle.objects)) await writeFile(join(root, 'objects', `${id.slice(7)}.json`), JSON.stringify(value))
    const receipt = await readCoordinatorStore(root)
    expect(receipt[0]).toMatchObject({ outcome: 'succeeded', deployedAt: '2026-11-06T18:10:00.000Z' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('invalidates an old completed binding when the committed head supersedes it without a replacement', () => {
  const { bundle, event, head } = coordinatorExport()
  const superseded = { ...event, previous: head, state: { releases: {} }, result: { status: 'superseded' } }
  const digest = receiptHash(superseded)
  bundle.journal[digest] = superseded; bundle.journalMetadata[digest] = { lastModified: '2026-11-06T18:12:00Z' }; bundle.control.head = digest
  expect(cmsandboxReceipts(bundle)[0]).toMatchObject({ outcome: 'partial' })
})

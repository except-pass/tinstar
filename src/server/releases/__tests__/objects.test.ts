import { describe, expect, it, vi } from 'vitest'
import { coordinatorExport } from '../../../../test-fixtures/releases/coordinator'
import { coordinatorReleaseObjects, ReleaseObjectReader } from '../objects'
import { receiptHash } from '../cmsandbox'
import { cmsandboxReceipts } from '../cmsandbox'
import type { EvidenceRead } from '../evidence'
import { ReleaseMembershipReader } from '../membership'
import { ReleaseReconciler } from '../reconcile'
import { releaseAssociations } from '../../../shared/releases'
import { releaseFixture } from '../../../releases/__tests__/fixtures'

function source(options: Parameters<typeof coordinatorExport>[0] = {}) {
  const fixture = coordinatorExport(options)
  const evidence: EvidenceRead = { status: 'snapshot', collectedAt: fixture.bundle.collectedAt, warnings: [], receipts: [], repositories: new Map(), requirements: new Map(),
    coordinatorSources: [{ bundle: fixture.bundle, asOf: fixture.bundle.collectedAt, historical: true }] }
  return { ...fixture, evidence }
}
describe('authoritative coordinator release objects', () => {
  it('keeps frozen candidate identity, exact targets and snapshot provenance without inventing work or acceptance', () => {
    const { evidence, head } = source()
    const records = coordinatorReleaseObjects(evidence)
    expect(records.map(row => row.kind)).toEqual(['candidate', 'production'])
    expect(records[0]).toMatchObject({ version: 'v1.24.0', state: 'Ready', candidateId: expect.stringMatching(/^sha256:/), planId: expect.stringMatching(/^sha256:/), executionId: null, pulls: [], provenance: { historical: true, asOf: '2026-11-06T18:15:00Z' } })
    expect(records[1]).toMatchObject({ executionId: head, state: 'Needs review', targets: [{ component: 'manager-analysis', receipt: { outcome: 'succeeded' } }] })
    expect(coordinatorReleaseObjects({ ...evidence, coordinatorSources: [] })).toEqual([])
  })
  it.each([{ partial: true }, { rollback: true }, { sourceMismatch: true }])('does not certify incomplete/reverted component delivery %j', options => {
    const objects = coordinatorReleaseObjects(source(options).evidence)
    expect(objects.find(row => row.kind === 'production')?.state).toBe('Partial rollout')
  })
  it('discovers frozen plans before a production binding exists', () => {
    const { evidence, bundle } = source()
    bundle.control.head = null; bundle.journal = {}; bundle.journalMetadata = {}
    expect(coordinatorReleaseObjects(evidence)).toEqual([expect.objectContaining({ kind: 'candidate', version: 'v1.24.0', executionId: null, observedAt: null })])
    const planId = Object.keys(bundle.objects).find(id => bundle.objects[id].candidate)!
    bundle.objects[planId].readiness = 'blocked'
    expect(coordinatorReleaseObjects(evidence)).toEqual([])
  })
  it('retains verified target delivery on a stopped execution without certifying writer receipts', () => {
    const { evidence, bundle, event, release } = source()
    release.status = 'stopped'; event.command.type = 'finish'
    const digest = receiptHash(event)
    bundle.control.head = digest; bundle.journal = { [digest]: event }
    bundle.journalMetadata[digest] = { lastModified: '2026-11-06T18:10:00Z' }
    expect(coordinatorReleaseObjects(evidence).find(row => row.kind === 'production')).toMatchObject({ state: 'Partial rollout', targets: [{ receipt: { outcome: 'succeeded', exceptions: [] } }] })
    expect(cmsandboxReceipts(bundle)[0]!.outcome).toBe('partial')
  })
  it('retains separate same-tag attempts and marks superseded evidence explicitly', () => {
    const { bundle, event, head, evidence } = source()
    const terminal = { ...event, previous: head, state: { releases: {} }, result: { status: 'superseded' } }
    const digest = receiptHash(terminal)
    bundle.journal[digest] = terminal; bundle.journalMetadata[digest] = { lastModified: '2026-11-06T18:12:00Z' }; bundle.control.head = digest
    const production = coordinatorReleaseObjects(evidence).find(row => row.kind === 'production')!
    expect(production).toMatchObject({ executionId: digest, state: 'Superseded', targets: [{ receipt: { outcome: 'partial' } }] })
    expect(production.id).not.toContain(`production:v1.24.0:${head}`)
  })
  it('does not turn an open attempted release without target readback into production', () => {
    const { bundle, event, release, evidence } = source()
    Object.assign(release, { status: 'claimed', steps: {} }); event.command.type = 'open'
    const digest = receiptHash(event); bundle.journal[digest] = event; bundle.control.head = digest
    expect(coordinatorReleaseObjects(evidence).map(row => row.kind)).toEqual(['candidate'])
  })
  it('preserves legacy component receipts without fusing matching version labels into one monorepo release', () => {
    const { bundle, evidence } = source()
    const receipt = cmsandboxReceipts(bundle)[0]!
    evidence.coordinatorSources = []
    evidence.receipts = [receipt, { ...receipt, id: 'other-attempt', component: 'worker', target: 'worker-prod', deployedSha: null, artifactDigest: null }]
    const objects = coordinatorReleaseObjects(evidence)
    expect(objects).toHaveLength(2)
    expect(objects[0]).toMatchObject({ kind: 'production', candidateId: null, scope: ['manager-analysis'] })
    expect(objects[1]).toMatchObject({ state: 'Production evidence unavailable', scope: ['worker'] })
    expect(objects[0]!.id).not.toBe(objects[1]!.id)
  })
  it('uses one Git range per refresh for candidate/production and leaves writer projection unchanged', async () => {
    const { evidence } = source(), scene = releaseFixture(), data = releaseAssociations(scene)
    const memberships = new ReleaseMembershipReader(vi.fn().mockRejectedValue(new Error('History missing')))
    const spy = vi.spyOn(memberships, 'get')
    const reader = new ReleaseObjectReader(memberships, new ReleaseReconciler(vi.fn()))
    const before = structuredClone(data)
    const objects = await reader.get(evidence, data, scene)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(objects.every(row => row.membership.status === 'unknown')).toBe(true)
    expect(data).toEqual(before)
  })
  it('uses source collection time for members and supporting PRs without changing aggregate evidence', async () => {
    const { evidence, bundle, head } = source(), scene = releaseFixture(), data = releaseAssociations(scene)
    const member = data.pulls[0]!, supporting = data.pulls[1]!
    supporting.links = structuredClone(member.links)
    bundle.journalMetadata[head] = { lastModified: '2026-11-10T18:10:00Z' }
    evidence.coordinatorSources![0]!.asOf = '2026-11-10T18:15:00Z'
    const receipt = cmsandboxReceipts(bundle)[0]!
    for (const pull of [member, supporting]) {
      Object.assign(pull, { repository: receipt.repository, state: 'merged', freshness: 'fresh', mergeSha: 'a'.repeat(40), exceptions: [] })
      evidence.requirements.set(pull.id, { targets: [{ component: receipt.component, target: receipt.target }], exceptions: [] })
    }
    evidence.repositories.set(receipt.repository, 'github')
    const memberships = new ReleaseMembershipReader()
    vi.spyOn(memberships, 'get').mockResolvedValue({ membership: { status: 'complete', baseline: 'v1.23.0', baselineSha: 'b'.repeat(40), observedAt: null, reason: null }, pulls: new Map([[member.id, member]]), commits: [], cursor: 0, page: 1, total: 1, retryAt: 0 })
    const reader = new ReleaseObjectReader(memberships, new ReleaseReconciler(vi.fn().mockResolvedValue({ state: 'ancestor' })))
    const records = await reader.get(evidence, data, scene)
    const production = records.find(record => record.kind === 'production')!
    expect(production.pulls).toHaveLength(1)
    expect(production.pulls[0]!.deployment!.state).toBe('shipped')
    expect(production.supportingPulls![0]!.deployment!.state).toBe('shipped')
    expect(records.find(record => record.kind === 'candidate')!.pulls[0]!.deployment!.state).toBe('unknown')
    expect(evidence.collectedAt).toBe('2026-11-06T18:15:00Z')
  })
  it('retains readable release identities with visible partial-source warnings and historical freshness', () => {
    const { evidence } = source()
    evidence.status = 'error'; evidence.warnings = ['Another configured receipt source could not be read']
    evidence.coordinatorSources![0]!.historical = false
    const objects = coordinatorReleaseObjects(evidence)
    expect(objects).toHaveLength(2)
    expect(objects.every(row => row.provenance.historical && row.gaps.includes(evidence.warnings[0]!))).toBe(true)
  })
})

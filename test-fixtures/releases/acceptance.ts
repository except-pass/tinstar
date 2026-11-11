import { coordinatorExport } from './coordinator'
import { coordinatorReleaseObjects } from '../../src/server/releases/objects'
import { releaseFixture } from '../../src/releases/__tests__/fixtures'
import { releaseAssociations } from '../../src/shared/releases'
import type { EvidenceRead } from '../../src/server/releases/evidence'
import type { AcceptanceContract } from '../../src/shared/releaseAcceptance'

/** Synthetic coordinator receipts + explicit card contracts. No live source. */
export function acceptanceFixture(method: 'workflow' | 'human' | 'observation' = 'workflow', pendingTarget = false) {
  const fixture = coordinatorExport({ pendingTarget }), scene = releaseFixture()
  const evidence: EvidenceRead = { status: 'fresh', collectedAt: fixture.bundle.collectedAt, warnings: [], receipts: [], repositories: new Map(), requirements: new Map(),
    coordinatorSources: [{ bundle: fixture.bundle, asOf: fixture.bundle.collectedAt, historical: false }] }
  for (const card of scene.cards) card.source.properties.Link!.value = String(card.source.properties.Link!.value).replace('Owner/Repo', 'fortresspower/cmsandbox')
  const data = releaseAssociations(scene)
  data.associationsComplete = true
  const releases = coordinatorReleaseObjects(evidence)
  const release = releases.find(row => row.kind === 'production')!
  release.membership = { status: 'complete', baseline: 'v1.23.9', baselineSha: 'a'.repeat(40), reason: null, observedAt: fixture.bundle.collectedAt }
  release.gaps = []; release.provenance.source = 'SYNTHETIC coordinator export; preview only'
  data.releases = releases
  data.reconciliation = { mode: 'dry-run', id: 'synthetic', sourceStatus: 'fresh', collectedAt: fixture.bundle.collectedAt, lastSuccessfulAt: null, warnings: [], cards: [], targets: [] }
  data.reconciliation.targets = release.targets.flatMap(target => target.receipt ? [{ repository: target.receipt.repository,
    component: target.component, target: target.target, deployedSha: target.receipt.deployedSha, artifactDigest: target.receipt.artifactDigest,
    version: target.receipt.version, receiptUrl: target.receipt.receiptUrl, observedAt: target.receipt.deployedAt }] : [])
  const receipt = release.targets[0]!.receipt!
  const pull = data.pulls[0]!
  Object.assign(pull, { repository: release.repository, state: 'merged', mergeSha: fixture.source, freshness: 'fresh', title: 'Correct Avalon Modbus enum mappings', exceptions: [] })
  pull.deployment = { state: 'shipped', targets: [{ component: receipt.component, target: receipt.target, receipt, state: 'live', ancestry: 'ancestor', reason: 'Synthetic verified component readback' }] }
  release.pulls = [pull]
  const contract: AcceptanceContract = { checks: [{ id: 'enum-mapping', successCondition: 'Read-only fixtures match the six approved Avalon enum values; no customer device write.', method, ref: 'siteconfig.avalon-enum.prod', ...(method !== 'workflow' ? { owner: 'Site Configuration owner' } : {}), fixture: 'approved-read-only-fixture' }] }
  for (const card of scene.cards) card.source.properties.Evidence = { id: 'acceptance', type: 'rich_text', value: '```production-acceptance\n' + JSON.stringify(contract) + '\n```', hasMore: false }
  return { ...fixture, scene, data, release, pull, contract }
}

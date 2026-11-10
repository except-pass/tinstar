import type { ReleaseObject, ReleaseChange } from '../../src/shared/releaseObjects'
import type { ReleasePull } from '../../src/shared/releases'

/** Synthetic UI fixtures only; never imported by the normal release read path. */
export function objectFixture(kind: ReleaseObject['kind'] = 'candidate', id: string = kind): ReleaseObject {
  return { id, kind, repository: 'owner/repo', version: kind === 'production' ? 'v1.24.0' : 'v1.24.1', sourceSha: 'a'.repeat(40),
    candidateId: 'sha256:' + 'c'.repeat(64), planId: 'sha256:' + 'd'.repeat(64), executionId: kind === 'production' ? 'sha256:' + 'e'.repeat(64) : null,
    scope: ['api'], targets: [], state: 'Needs review', observedAt: '2026-11-10T12:00:00Z',
    provenance: { source: 'SYNTHETIC TEST FIXTURE', asOf: '2026-11-10T12:00:00Z', historical: true }, evidenceUrl: null,
    membership: { status: 'complete', baseline: 'v1.23.0', baselineSha: 'b'.repeat(40), observedAt: '2026-11-10T12:00:00Z', reason: null }, pulls: [], gaps: [] }
}
export function changeFixture(index = 0, acceptance: ReleaseChange['acceptance'] = 'Unknown'): ReleaseChange {
  const pull: ReleasePull = { id: `owner/repo#${index + 1}`, repository: 'owner/repo', number: index + 1, url: `https://github.com/owner/repo/pull/${index + 1}`,
    title: `Fixture outcome ${index + 1}`, state: 'merged', mergedAt: '2026-11-10T11:00:00Z', mergeSha: 'a'.repeat(40), observedAt: '2026-11-10T12:00:00Z', freshness: 'fresh', links: [], exceptions: [] }
  return { id: `fixture:${index}`, title: pull.title!, cardId: `fixture-card-${index}`, product: index % 2 ? 'Fleet Management Portal' : 'Cloud Platform',
    pulls: [pull], requiredPulls: [pull.url], targets: [], delivery: 'Deployed', acceptance,
    successCondition: 'The approved read-only fixture produces the expected feature-specific result.', method: acceptance === 'Human review' ? 'Named reviewer' : 'Automated',
    checkRef: `fixture.feature-${index}.prod`, acceptanceEvidence: acceptance === 'Passed' ? 'Fixture receipt only · passed' : null,
    note: `Fixture improvement ${index + 1}.`, audience: index % 2 ? 'customer' : 'internal' }
}

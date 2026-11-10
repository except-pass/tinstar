import { describe, expect, it } from 'vitest'
import { releaseAssociations } from '../../shared/releases'
import { eligibleReleaseNote } from '../../shared/releaseObjects'
import { objectFixture } from '../../../test-fixtures/releases/objects'
import { releaseChanges } from '../releaseChanges'
import { releaseFixture } from './fixtures'

describe('release-scoped work outcomes', () => {
  it('deduplicates many PRs per card while evaluating one PR/multiple cards independently', () => {
    const scene = releaseFixture(), data = releaseAssociations(scene), release = objectFixture('production')
    release.pulls = data.pulls
    const cardId = data.pulls[0]!.links[0]!.cardId
    data.pulls[1]!.links.push({ cardId, active: true, sources: ['Notion Link/GitHub property'], events: [] })
    const changes = releaseChanges(release, data, scene)
    expect(changes).toHaveLength(3)
    expect(changes.find(change => change.cardId === cardId)?.pulls).toHaveLength(2)
    expect(changes.every(change => change.acceptance === 'Unknown' && !eligibleReleaseNote(release, change))).toBe(true)
  })
  it('holds delivery when a second required PR is outside the observed release; unlinked PRs stay real PR changes', () => {
    const scene = releaseFixture(), data = releaseAssociations(scene), release = objectFixture('production')
    data.pulls[1]!.links = structuredClone(data.pulls[0]!.links)
    release.pulls = [data.pulls[0]!]
    const changes = releaseChanges(release, data, scene)
    expect(changes[0]?.requiredPulls).toHaveLength(2)
    expect(changes[0]?.delivery).toBe('Unknown')
    release.pulls = [{ ...data.pulls[0]!, links: [] }]
    const unlinked = releaseChanges(release, data, scene)
    expect(unlinked).toHaveLength(1); expect(unlinked[0]?.cardId).toBeNull()
  })
  it.each(['partial', 'skipped', 'rollback', 'failed'] as const)('never makes %s delivery eligible, even if UI acceptance was passed', outcome => {
    const scene = releaseFixture(), data = releaseAssociations(scene), release = objectFixture('production')
    const pull = data.pulls[0]!
    const receipt = { id: 'receipt', repository: pull.repository, component: 'api', target: 'prod', environment: 'production', deployedSha: 'a'.repeat(40), artifactDigest: null, version: release.version, deployedAt: release.provenance.asOf, receiptUrl: 'https://example.com/receipt', workflowUrl: 'https://example.com/workflow', outcome, exceptions: [] }
    pull.deployment = { state: 'unknown', targets: [{ component: 'api', target: 'prod', state: 'live', ancestry: 'ancestor', reason: 'test', receipt }] }
    release.pulls = [pull]; release.targets = [{ component: 'api', target: 'prod', readiness: 'ready', readinessEvidence: [], receipt }]
    const change = releaseChanges(release, data, scene)[0]!
    expect(change.delivery).toBe('Unknown')
    Object.assign(change, { acceptance: 'Passed', note: 'Would be unsafe', successCondition: 'Condition', checkRef: 'check', acceptanceEvidence: 'result' })
    expect(eligibleReleaseNote(release, change)).toBe(false)
  })
  it('keeps Plan acceptance and delivery distinct from build/DEV readiness', () => {
    const scene = releaseFixture(), data = releaseAssociations(scene), release = objectFixture()
    release.pulls = data.pulls
    expect(releaseChanges(release, data, scene).every(change => change.delivery === 'Awaiting delivery' && change.acceptance === 'Unknown' && !change.checkRef)).toBe(true)
  })
})

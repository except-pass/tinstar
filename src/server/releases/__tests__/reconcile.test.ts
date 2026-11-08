import { describe, expect, it, vi } from 'vitest'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { releaseAssociations, type ReleasesRead } from '../../../shared/releases'
import type { FloorScene } from '../../../shared/reconciliationPresentation'
import type { DeploymentReceipt } from '../../../shared/releaseReconciliation'
import { reconcileReleases, ReleaseReconciler } from '../reconcile'
import type { EvidenceRead } from '../evidence'
import { filterReleases, releaseQueueCount } from '../../../releases/model'

const merge = 'a'.repeat(40), deployed = 'b'.repeat(40)
const url = (number: number) => `https://github.com/owner/repo/pull/${number}`
function setup() {
  const scene: FloorScene = fixtureScene(); scene.cards = scene.cards.slice(0, 2)
  for (const card of scene.cards) {
    card.source.properties.Link = { id: 'link', type: 'rich_text', value: url(1), hasMore: false }
    card.source.properties.Status!.value = 'Waiting for Prod Release'
  }
  const data = releaseAssociations(scene)
  for (const pull of data.pulls) Object.assign(pull, { freshness: 'fresh', state: 'merged', mergeSha: merge, mergedAt: '2026-11-06T18:00:00Z' })
  const receipt: DeploymentReceipt = { id: 'prod-1', repository: 'owner/repo', component: 'api', target: 'api-prod', environment: 'production', deployedSha: deployed, artifactDigest: `sha256:${'c'.repeat(64)}`, version: 'v1', deployedAt: '2026-11-06T18:10:00Z', workflowUrl: 'https://github.com/owner/repo/actions/runs/1', receiptUrl: 'https://example.com/receipts/prod-1', outcome: 'succeeded', exceptions: [] }
  const evidence: EvidenceRead = { status: 'fresh', collectedAt: '2026-11-06T18:15:00Z', warnings: [], receipts: [receipt], repositories: new Map([['owner/repo', '/existing/repo']]), requirements: new Map([['owner/repo#1', { targets: [{ target: 'api-prod', component: 'api' }], exceptions: [] }]]) }
  const ancestry = vi.fn().mockResolvedValue({ state: 'ancestor' })
  return { scene, data, evidence, receipt, ancestry }
}
const cardReports = (data: ReleasesRead) => data.reconciliation!.cards

describe('deterministic release dry run', () => {
  it('proves exact targets and independently evaluates one PR/two cards with opt-in verification', async () => {
    const { scene, data, evidence, ancestry } = setup()
    scene.cards[0]!.source.properties['Requires production verification'] = { id: 'verify', type: 'checkbox', value: true, hasMore: false }
    const before = JSON.stringify({ scene, data })
    const result = await reconcileReleases(data, scene, evidence, ancestry)
    expect(result.pulls[0]!.deployment).toMatchObject({ state: 'shipped', verificationRequired: true })
    expect(cardReports(result).find(card => card.cardId === scene.cards[0]!.id)?.decision).toBe('would-verify')
    expect(cardReports(result).find(card => card.cardId === scene.cards[1]!.id)?.decision).toBe('would-complete')
    expect(cardReports(result).filter(card => card.eligible)).toHaveLength(1)
    expect(filterReleases(result.pulls, 'Verify in Prod')).toHaveLength(1)
    expect(filterReleases(result.pulls, 'Shipped')).toHaveLength(1)
    expect(filterReleases(result.pulls, 'In Queue')).toHaveLength(0)
    expect(releaseQueueCount(result)).toBe(0)
    expect(ancestry).toHaveBeenCalledWith('owner/repo', '/existing/repo', merge, deployed)
    expect(JSON.stringify({ scene, data })).toBe(before)
    expect(await reconcileReleases(data, scene, evidence, ancestry)).toEqual(result)
  })
  it.each(['2026-11-06T18:10:00+00:00', '2026-11-06T19:10:00+01:00', '2026-11-06T18:10:00.000Z'])('rejects conflicting receipts for the same instant serialized as %s', async deployedAt => {
    const { scene, data, evidence, receipt, ancestry } = setup()
    evidence.receipts.push({ ...receipt, id: 'rollback', deployedAt, outcome: 'rollback' })
    const result = await reconcileReleases(data, scene, evidence, ancestry)
    expect(result.pulls[0]!.deployment!.state).toBe('unknown')
    expect(cardReports(result).every(card => card.decision === 'exception' && !card.eligible)).toBe(true)
    expect(ancestry).not.toHaveBeenCalled()
  })
  it('requires both PRs and every target before a waiting card could complete', async () => {
    const { scene, data, evidence, ancestry, receipt } = setup()
    const second = { ...data.pulls[0]!, id: 'owner/repo#2', number: 2, url: url(2), mergeSha: 'd'.repeat(40) }
    data.pulls.push(second)
    evidence.requirements.set(second.id, { targets: [{ target: 'worker-prod', component: 'worker' }], exceptions: [] })
    evidence.receipts.push({ ...receipt, id: 'prod-worker', component: 'worker', target: 'worker-prod' })
    ancestry.mockImplementation(async (_repo: string, _path: string, sha: string) => ({ state: sha === second.mergeSha ? 'not-ancestor' : 'ancestor' }))
    const partial = await reconcileReleases(data, scene, evidence, ancestry)
    expect(partial.pulls.map(pull => pull.deployment!.state)).toEqual(['shipped', 'in-queue'])
    expect(cardReports(partial).every(card => card.decision === 'waiting' && !card.eligible)).toBe(true)
    ancestry.mockResolvedValue({ state: 'ancestor' })
    expect(cardReports(await reconcileReleases(data, scene, evidence, ancestry)).every(card => card.eligible)).toBe(true)
    evidence.requirements.get(second.id)!.targets.push({ component: 'web', target: 'web-prod' })
    expect(cardReports(await reconcileReleases(data, scene, evidence, ancestry)).every(card => !card.eligible)).toBe(true)
  })
  it.each(['partial', 'skipped', 'rollback', 'failed'] as const)('does not fulfill from a newer %s receipt even after an older success', async outcome => {
    const { scene, data, evidence, receipt, ancestry } = setup()
    evidence.receipts.push({ ...receipt, id: `later-${outcome}`, deployedAt: '2026-11-06T18:14:00Z', outcome })
    const result = await reconcileReleases(data, scene, evidence, ancestry)
    expect(result.pulls[0]!.deployment!.state).toBe('unknown')
    expect(cardReports(result).every(card => !card.eligible)).toBe(true)
    expect(ancestry).not.toHaveBeenCalled()
  })
  it.each(['feature flag disabled', 'cherry-pick without provenance', 'reverted change'])('keeps a known %s exception visible and searchable', async exception => {
    const { scene, data, evidence, ancestry } = setup()
    evidence.requirements.get(data.pulls[0]!.id)!.exceptions.push(exception)
    const result = await reconcileReleases(data, scene, evidence, ancestry)
    expect(result.pulls[0]!.exceptions.join()).toContain(exception)
    expect(filterReleases(result.pulls, 'Exceptions')).toHaveLength(1)
    expect(cardReports(result).every(card => !card.eligible)).toBe(true)
    expect(ancestry).not.toHaveBeenCalled()
  })
  it.each(['repository', 'component', 'target', 'environment'])('wrong %s cannot satisfy a card', async field => {
    const { scene, data, evidence, receipt, ancestry } = setup()
    Object.assign(receipt, { [field]: 'wrong' })
    const result = await reconcileReleases(data, scene, evidence, ancestry)
    expect(result.pulls[0]!.deployment!.state).toBe('unknown')
    expect(ancestry).not.toHaveBeenCalled()
  })
  it('rejects ambiguous identities, digest without provenance, stale evidence, and an unmapped PR', async () => {
    for (const variant of ['conflict', 'digest-only', 'stale', 'mapping', 'checkout', 'github', 'incomplete-links']) {
      const { scene, data, evidence, receipt, ancestry } = setup()
      if (variant === 'conflict') evidence.receipts.push({ ...receipt, id: 'conflict', deployedSha: 'e'.repeat(40) })
      if (variant === 'digest-only') receipt.deployedSha = null
      if (variant === 'stale') evidence.status = 'stale'
      if (variant === 'mapping') evidence.requirements.clear()
      if (variant === 'checkout') evidence.repositories.clear()
      if (variant === 'github') data.pulls[0]!.freshness = 'stale'
      if (variant === 'incomplete-links') data.associationsComplete = false
      expect(cardReports(await reconcileReleases(data, scene, evidence, ancestry)).every(card => !card.eligible), variant).toBe(true)
    }
  })
  it('a tag-only event changes nothing; unrelated Notion statuses are never eligible', async () => {
    const { scene, data, evidence, ancestry } = setup()
    evidence.receipts = []
    const noDeploy = await reconcileReleases(data, scene, evidence, ancestry)
    expect(cardReports(noDeploy).every(card => !card.eligible)).toBe(true)
    const { receipt } = setup(); evidence.receipts.push(receipt)
    scene.cards[0]!.source.properties.Status!.value = 'In Progress'
    const deployed = await reconcileReleases(data, scene, evidence, ancestry)
    expect(cardReports(deployed).find(card => card.cardId === scene.cards[0]!.id)).toMatchObject({ decision: 'unrelated', eligible: false })
    expect(cardReports(deployed).find(card => card.cardId === scene.cards[1]!.id)).toMatchObject({ decision: 'would-complete', eligible: true })
  })
  it('bounds production Git reads and continues remaining targets from cached commit-pair answers', async () => {
    const { scene, data, evidence } = setup()
    data.pulls = Array.from({ length: 9 }, (_, index) => ({ ...data.pulls[0]!, id: `owner/repo#${index + 1}`, number: index + 1, url: url(index + 1), mergeSha: (index + 1).toString().repeat(40) }))
    for (const pull of data.pulls) evidence.requirements.set(pull.id, { targets: [{ target: 'api-prod', component: 'api' }], exceptions: [] })
    const check = vi.fn().mockResolvedValue({ state: 'ancestor' }), reader = new ReleaseReconciler(check)
    const first = await reader.get(data, scene, evidence)
    expect(check).toHaveBeenCalledTimes(8)
    expect(first.pulls.filter(pull => pull.deployment!.state === 'shipped')).toHaveLength(8)
    expect(first.pulls[8]!.exceptions.join()).toContain('pending')
    const second = await reader.get(data, scene, evidence)
    expect(check).toHaveBeenCalledTimes(9)
    expect(second.pulls.every(pull => pull.deployment!.state === 'shipped')).toBe(true)
  })

})

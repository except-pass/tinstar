import { expect, it } from 'vitest'
import { artifactContext } from '../artifacts'
import { changeFixture, objectFixture } from '../../../../test-fixtures/releases/objects'
import type { ReleasesRead } from '../../../shared/releases'
import type { DeploymentReceipt } from '../../../shared/releaseReconciliation'

it('resolves historical member and supporting artifacts exclusively within the selected release', async () => {
  const receipt: DeploymentReceipt = { id: 'historical', repository: 'owner/repo', environment: 'production', component: 'api', target: 'production', deployedSha: 'a'.repeat(40), artifactDigest: null, version: 'v1', deployedAt: '2026-11-10T12:00:00Z', workflowUrl: 'https://github.com/owner/repo/actions/runs/1', receiptUrl: 'https://github.com/owner/repo/actions/runs/1', outcome: 'succeeded', exceptions: [] }
  const member = changeFixture(0).pulls[0]!
  const supporting = changeFixture(1).pulls[0]!
  for (const pull of [member, supporting]) pull.deployment = { state: 'shipped', targets: [{ component: 'api', target: 'production', state: 'live', reason: 'Verified', ancestry: 'ancestor', receipt }] }
  const selected = { ...objectFixture('production'), pulls: [member], supportingPulls: [supporting] }
  const data = { pulls: [{ ...member, deployment: { state: 'shipped', targets: [{ ...member.deployment!.targets[0]!, receipt: { ...receipt, id: 'newer' } }] } }], releases: [selected] } as ReleasesRead
  const sources = { releases: async () => data, pulls: async () => { throw new Error('Unexpected aggregate PR fallback') } }
  for (const pull of [member, supporting]) {
    const target = { kind: 'receipt' as const, id: pull.id, component: 'api', target: 'production', receipt_id: receipt.id }
    const context = await artifactContext(target, { scene: 'releases', release_id: selected.id }, {}, sources)
    expect(context.source).toMatchObject({ receipt_id: 'historical' })
    expect(context.return_to?.view?.release_id).toBe(selected.id)
    expect((await artifactContext({ kind: 'pull', id: pull.id }, { scene: 'releases', release_id: selected.id }, {}, sources)).anchor.page_id).toBe(pull.id)
    await expect(artifactContext({ ...target, receipt_id: 'newer' }, { scene: 'releases', release_id: selected.id }, {}, sources)).rejects.toThrow('Receipt unavailable')
    await expect(artifactContext(target, { scene: 'releases', release_id: 'missing' }, {}, sources)).rejects.toThrow('selected authorized release')
  }
  expect(selected.pulls).toEqual([member])
})

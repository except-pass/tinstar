import { expect, it, vi } from 'vitest'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { releaseAssociations } from '../../../shared/releases'
import type { ReleaseObject } from '../../../shared/releaseObjects'
import { productionWaits, ProductionWaitWriter } from '../productionWaits'
import type { ReleaseTransport } from '../writer'

function fixture() {
  const scene = fixtureScene(); scene.cards = scene.cards.slice(0, 1)
  const card = scene.cards[0]!.source, url = 'https://github.com/owner/repo/pull/1'
  card.properties.Status!.value = 'Waiting for Prod Release'
  card.properties['GitHub PRs'] = { type: 'rich_text', value: url, hasMore: false, id: 'prs' }
  const data = releaseAssociations(scene)
  data.releaseSource = { status: 'fresh', observedAt: new Date().toISOString(), warnings: [] }
  const release: ReleaseObject = { id: 'owner/repo:tag:v1.0.0', repository: 'owner/repo', version: 'v1.0.0', sourceSha: 'a'.repeat(40), kind: 'production', candidateId: null, planId: null, executionId: null,
    scope: [], targets: [], state: 'Awaiting PROD verification', observedAt: new Date().toISOString(), provenance: { historical: false, source: 'GitHub', asOf: new Date().toISOString() }, evidenceUrl: 'https://github.com/owner/repo/releases/tag/v1.0.0',
    membership: { status: 'complete', baseline: 'v0.9.0', baselineSha: 'b'.repeat(40), observedAt: new Date().toISOString(), reason: null }, pulls: structuredClone(data.pulls), gaps: [],
    github: { record: 'available', url: 'https://github.com/owner/repo/releases/tag/v1.0.0', publishedAt: new Date().toISOString(), body: '', snapshotAt: null, componentResults: [], runsStatus: 'fresh', runs: [] } }
  data.releases = [release]
  const notes = new Set<string>()
  const transport: ReleaseTransport = { card: vi.fn(async () => card), hasNote: async (_id, marker) => notes.has(marker), note: vi.fn(async (_id, _text, marker) => { notes.add(marker) }), transition: vi.fn(async (_card, proposal) => { card.properties.Status!.value = proposal.to }) }
  return { scene, card, data, release, notes, transport, read: async () => ({ data, scene }) }
}
it('advances a release wait with an audited native production membership and never replays it', async () => {
  const f = fixture(), writer = new ProductionWaitWriter(f.transport, f.read)
  expect(await writer.run()).toEqual({ completed: [f.card.id] })
  expect(f.card.properties.Status!.value).toBe('Done')
  expect(f.transport.note).toHaveBeenCalledWith(f.card.id, expect.stringContaining(f.release.evidenceUrl!), expect.stringContaining('Tin Star production wait: membership:'))
  await writer.run(); expect(f.transport.transition).toHaveBeenCalledTimes(1)
})
it('routes explicit production verification through In Progress', async () => {
  const f = fixture()
  f.card.properties['Requires production verification'] = { id: 'verify', type: 'checkbox', hasMore: false, value: true }
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.card.properties.Status!.value).toBe('In Progress')
})
it.each(['draft', 'partial', 'stale', 'unpublished', 'unknown-source', 'incomplete-associations', 'another-pr'] as const)('holds %s evidence', async condition => {
  const f = fixture()
  if (condition === 'draft') f.release.kind = 'draft'
  if (condition === 'partial') f.release.membership.status = 'partial'
  if (condition === 'stale') f.release.provenance.historical = true
  if (condition === 'unpublished') f.release.github!.publishedAt = null
  if (condition === 'unknown-source') f.data.releaseSource!.status = 'unknown'
  if (condition === 'incomplete-associations') f.data.associationsComplete = false
  if (condition === 'another-pr') f.data.pulls.push({ ...f.data.pulls[0]!, url: 'https://github.com/owner/repo/pull/2', id: 'owner/repo#2' })
  expect(productionWaits(f.data, f.scene)).toEqual([])
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.transport.note).not.toHaveBeenCalled(); expect(f.transport.transition).not.toHaveBeenCalled()
})
it('revalidates newly added required PRs after recording its audit', async () => {
  const f = fixture()
  f.transport.note = async () => { f.data.pulls.push({ ...f.data.pulls[0]!, url: 'https://github.com/owner/repo/pull/2', id: 'owner/repo#2' }) }
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.transport.transition).not.toHaveBeenCalled()
})
it('recovers a failed transition using the same card audit marker', async () => {
  const f = fixture(), transition = f.transport.transition
  f.transport.transition = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(transition)
  await new ProductionWaitWriter(f.transport, f.read).run()
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.transport.note).toHaveBeenCalledTimes(1)
  expect(f.card.properties.Status!.value).toBe('Done')
})

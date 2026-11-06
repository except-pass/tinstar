import { describe, expect, it } from 'vitest'
import { fixtureId } from '../../../test-fixtures/reconciliation/scenes'
import { activeReleaseLinks, releaseAssociations, releasePull, type AssociationEvent } from '../../shared/releases'
import { filterReleases, queuedPulls, releaseQueueCount, releaseDocuments, releaseGroups } from '../model'
import { SmartSearchIndex } from '../../shared/smartSearch'
import { releaseFixture } from './fixtures'


const event = (overrides: Partial<AssociationEvent> = {}): AssociationEvent => ({ id: 'event', pull: 'https://github.com/owner/repo/pull/1', cardId: fixtureId(1), action: 'unlink', actor: 'owner@example.com', at: new Date().toISOString(), reason: 'Incorrect original declaration', ...overrides })

describe('release associations and queue projection', () => {
  it('withholds counts for empty failed, partial and stale association sources', () => {
    const scene = releaseFixture()
    scene.cards = []
    expect(releaseQueueCount(releaseAssociations(scene))).toBe(0)
    for (const status of ['unknown', 'partial', 'stale'] as const) {
      scene.coverage.intentions.status = status
      const data = releaseAssociations(scene)
      expect(data.associationsComplete).toBe(false)
      expect(data.warnings.length).toBeGreaterThan(0)
      expect(releaseQueueCount(data)).toBeNull()
    }
    scene.coverage.intentions.status = 'fresh'
    scene.coverage.intentions.coverage = 'partial'
    expect(releaseQueueCount(releaseAssociations(scene))).toBeNull()
  })
  it('counts only with complete associations, fresh GitHub and a successful request', () => {
    const data = releaseAssociations(releaseFixture())
    expect(releaseQueueCount(data)).toBeNull()
    data.pulls.forEach(pull => Object.assign(pull, { state: 'merged', freshness: 'fresh' }))
    expect(releaseQueueCount(data)).toBe(2)
    expect(releaseQueueCount(data, 'Read failed')).toBeNull()
    data.associationsComplete = false
    expect(releaseQueueCount(data)).toBeNull()
  })
  it('normalizes explicit repository/PR identities and rejects non-PR or hostile URLs', () => {
    expect(releasePull('https://github.com/Owner/Repo/pull/12/?tab=files#diff')).toMatchObject({ id: 'owner/repo#12', url: 'https://github.com/owner/repo/pull/12' })
    for (const url of ['http://github.com/a/b/pull/1', 'https://github.com.evil/a/b/pull/1', 'https://x@github.com/a/b/pull/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/issues/1']) expect(releasePull(url)).toBeNull()
  })
  it('preserves many-to-many identity across groups, deduplicates counts, and never associates through titles or workers', () => {
    const scene = releaseFixture(), extra = event({ id: 'extra', cardId: scene.cards[0]!.id, action: 'link', pull: 'https://github.com/owner/repo/pull/2' })
    const data = releaseAssociations(scene, [extra])
    expect(data.pulls).toHaveLength(2)
    expect(activeReleaseLinks(data.pulls[0]!)).toHaveLength(2)
    expect(data.pulls.filter(pull => activeReleaseLinks(pull).some(link => link.cardId === scene.cards[0]!.id))).toHaveLength(2)
    const groups = releaseGroups(scene, data.pulls, 'initiative')
    expect(groups.map(group => group.label)).toEqual(['Alpha → Frontend', 'Beta → Backend'])
    expect(new Set(groups.flatMap(group => group.pulls.map(pull => pull.id))).size).toBe(2)
    expect(releaseGroups(scene, data.pulls, 'repository')).toHaveLength(1)
    scene.cards[0]!.source.properties.Link!.value = ''
    scene.cards[0]!.source.properties.Name!.value = 'https://github.com/owner/repo/pull/99'
    expect(releaseAssociations(scene).pulls.map(pull => pull.number)).not.toContain(99)
  })
  it('retains unlink provenance, exposes missing cards/links, and replays idempotently', () => {
    const scene = releaseFixture(), audit = [event({ cardId: scene.cards[0]!.id })]
    const result = releaseAssociations(scene, audit)
    expect(result.pulls[0]!.links[0]).toMatchObject({ active: false, sources: ['Notion Link/GitHub property', 'Manual association'], events: audit })
    expect(result.unassociatedCards.map(card => card.id)).toContain(scene.cards[0]!.id)
    expect(releaseAssociations(scene, audit)).toEqual(result)
    expect(releaseAssociations(scene, [event({ action: 'link', cardId: 'f'.repeat(32) })]).pulls[0]!.exceptions.join()).toContain('unavailable')
    scene.coverage.intentions.status = 'stale'
    expect(releaseAssociations(scene).pulls[0]!.exceptions.join()).toContain('stale')
  })
  it('does not claim shipment from card status, tags, or partial observations and searches PR/card metadata with existing fuzzy ranking', () => {
    const scene = releaseFixture(), data = releaseAssociations(scene)
    const pull = data.pulls[0]!
    Object.assign(pull, { state: 'merged', freshness: 'fresh', title: 'Release coordinator receipt', mergedAt: new Date().toISOString() })
    expect(queuedPulls(data.pulls)).toHaveLength(1)
    expect(filterReleases(data.pulls, 'In Queue')).toHaveLength(2)
    expect(filterReleases(data.pulls, 'Shipped')).toEqual([])
    expect(filterReleases(data.pulls, 'Verify in Prod')).toEqual([])
    const index = new SmartSearchIndex(); index.update(releaseDocuments(scene, data.pulls))
    expect(index.search('releese coordnator')[0]!.document.target).toEqual({ kind: 'pull', id: pull.id })
    expect(index.search('PR #1')[0]!.document.key).toBe(`pull:${pull.id}`)
    expect(index.search('Beta')[0]!.document.key).toBe(`pull:${pull.id}`)
  })
})

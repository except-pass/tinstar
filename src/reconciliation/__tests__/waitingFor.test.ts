import { describe, expect, it } from 'vitest'
import { fixtureScene, fixtureId } from '../../../test-fixtures/reconciliation/scenes'
import { waitingForGroups, waitingForActive } from '../waitingFor'
import { notionCard } from '../../server/reconciliation/notion'
import { sceneSearchDocuments } from '../../shared/searchDocuments'
import type { SceneCard } from '../../server/reconciliation/scene'
import { initialPresentation } from '../presentation'

function card(n: number, type = 'Actor', id = 'Will', values: Record<string, unknown> = {}): SceneCard {
  const base = structuredClone(fixtureScene().cards[0]!)
  base.id = base.source.id = fixtureId(n)
  for (const [name, value] of Object.entries({ Name: `Card ${n}`, Status: 'Waiting For', 'Waiting For Type': type, 'Waiting For ID': id, ...values })) base.source.properties[name] = { id: name, type: 'rich_text', value, hasMore: false }
  return base
}
const flat = (result: ReturnType<typeof waitingForGroups>) => result.categories.flatMap(category => category.groups)
describe('Waiting For projection', () => {
  it('passes structured properties through the shared reader and searchable scene DTO', () => {
    const raw = { object: 'page', id: fixtureId(1), last_edited_time: '2026-11-10T12:00:00Z', properties: {
      'Waiting For Type': { type: 'select', select: { name: 'Event' } }, 'Waiting For ID': { type: 'rich_text', rich_text: [{ plain_text: 'PR #3362' }] },
    } }
    const source = notionCard(raw)
    expect(source.properties['Waiting For Type']?.value).toBe('Event')
    expect(source.properties['Waiting For ID']?.value).toBe('PR #3362')
    const scene = fixtureScene(); scene.cards[0]!.source = source
    expect(sceneSearchDocuments(scene)[0]!.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Waiting For Type', text: 'Event' }), expect.objectContaining({ name: 'Waiting For ID', text: 'PR #3362' }),
    ]))
  })
  it('deduplicates primary groups, excludes other statuses and computes every count', () => {
    const cards = [card(1), card(2, 'Actor', ' will '), ...Array.from({ length: 8 }, (_, n) => card(n + 3, 'Event', 'cmsandbox PR #3362 merged')), card(11, 'Actor', 'Duke Energy'), card(12, 'Actor', 'Will', { Status: 'Waiting for Prod Release' })]
    const result = waitingForGroups([...cards, cards[0]!])
    expect(result.count).toBe(11)
    expect(result.categories.map(category => category.type)).toEqual(['Actor', 'Event', 'Work'])
    expect(result.categories[0]!.groups.map(group => [group.label, group.cards.length])).toEqual([['Will', 2], ['Duke Energy', 1]])
    expect(result.categories[1]!.groups).toHaveLength(1)
    expect(result.categories[1]!.groups[0]!.cards).toHaveLength(8)
    expect(result.initial).toContain(result.categories[0]!.groups[0]!.key)
  })
  it('orders Will first, other groups by count/name and children by priority/check-in/name', () => {
    const cards = [card(9, 'Actor', 'Other'), card(8, 'Actor', 'Other'), card(7), card(6, 'Actor', 'Other', { Priority: '🔴 High', 'Next check-in': { start: '2026-11-11T00:00Z' } }), card(5, 'Actor', 'Other', { Priority: '🔴 High', 'Next check-in': { start: '2026-11-10T00:00Z' } })]
    expect(flat(waitingForGroups(cards)).map(group => group.label)).toEqual(['Will', 'Other'])
    expect(flat(waitingForGroups(cards))[1]!.cards.map(card => card.id)).toEqual([5, 6, 8, 9].map(fixtureId))
    expect(flat(waitingForGroups([...cards].reverse()))).toEqual(flat(waitingForGroups(cards)))
  })
  it('preserves exact IDs, resolves real Work and links only exact trusted Event destinations', () => {
    const work = card(3, 'Actor', 'Will', { Name: 'Collector' })
    const cards = [card(1, 'Work', fixtureId(3).toUpperCase()), card(2, 'Event', 'https://github.com/acme/repo/pull/123'), card(4, 'Event', 'repo PR #124 merged', { 'Waiting For': 'After https://github.com/acme/repo/pull/124 is accepted' }), card(5, 'Event', 'https://evil.example/repo/pull/123')]
    const result = flat(waitingForGroups(cards, [...cards, work]))
    expect(result.find(group => group.type === 'Work')).toMatchObject({ id: fixtureId(3).toUpperCase(), label: 'Collector', target: { kind: 'card', id: fixtureId(3) } })
    expect(result.find(group => group.id.includes('/123') && group.id.includes('github'))?.target).toEqual({ kind: 'url', url: 'https://github.com/acme/repo/pull/123' })
    expect(result.find(group => group.id === 'repo PR #124 merged')?.target).toEqual({ kind: 'url', url: 'https://github.com/acme/repo/pull/124' })
    expect(result.find(group => group.id.includes('evil'))?.target).toBeUndefined()
  })
  it('separates invalid classification from an unknown exact Work reference', () => {
    const cards = [card(1, '', ''), card(2, 'Work', ''), card(3, 'Work', 'mcp'), card(4, 'Work', fixtureId(4)),
      card(5, 'Work', fixtureId(99)), card(6, 'Person', 'Someone'), card(7, 'Card', fixtureId(99))]
    const result = waitingForGroups(cards)
    expect(result.count).toBe(7)
    expect(result.unclassified).toHaveLength(6)
    expect(flat(result)).toMatchObject([{ type: 'Work', id: fixtureId(99) }])
    expect(cards.map(card => result.issues.get(card.id)?.[0]?.code)).toEqual([
      'missing-type', 'missing-id', 'invalid-work-id', 'work-self', 'work-unverified', 'legacy-type', 'legacy-type',
    ])
    expect(result.issues.get(fixtureId(6))?.[0]?.reason).toMatch(/Person with Actor/)
    expect(result.issues.get(fixtureId(7))?.[0]?.reason).toMatch(/Card with Work/)
  })
  it('moves a card after refresh without duplicating or treating a status change as deletion', () => {
    const one = card(1), changed = structuredClone(one)
    changed.source.last_edited_time = '2099-01-01T00:00Z'; changed.source.properties['Waiting For ID']!.value = 'Duke Energy'
    const result = waitingForGroups([one, changed])
    expect(result.count).toBe(1); expect(flat(result)[0]!.label).toBe('Duke Energy')
    changed.source.properties.Status!.value = 'Queued'
    expect(waitingForGroups([one, changed]).count).toBe(0)
  })
  it('activates only the scoped Waiting For selection without mutating the organizer', () => {
    const state = initialPresentation()
    expect(waitingForActive(state)).toBe(false)
    expect(waitingForActive({ ...state, donutFilter: { cards: ['Waiting For'], workers: [] } })).toBe(true)
    expect(waitingForActive({ ...state, statusFilter: { preset: 'custom', statuses: ['Waiting For'] } })).toBe(true)
    expect(waitingForActive({ ...state, donutFilter: { cards: ['Waiting for Prod Release'], workers: [] } })).toBe(false)
  })
})

const mergeId = '41b50ce6d422814c8edbd29f321f94e8'
const normalized = [
  ['KD nightly', '41b50ce6d42281acb62af11f5d4bf9b4', 'Event', 'KD nightly CI run 2026-11-18 03:25Z'],
  ['Gateway bug', '41b50ce6d4228133a8c5c9fe8a16a04d', 'Work', mergeId],
  ['Clawson PROD role', '41b50ce6d422817a8437c263c316ed9c', 'Actor', 'Firstmate'],
  ['Remote CAN real writes', '41b50ce6d42281a2abb7ebf340c1da35', 'Actor', 'hilda'],
  ['Move Mac', '3ff50ce6d4228143973bd04fc4aa3088', 'Actor', 'mcp'],
  ['Dirt Farm shared admission', '40150ce6d42281a9860ece280540cf2a', 'Actor', 'hulk'],
  ['Jev classifier', '41b50ce6d42281378c2ff70c270c0394', 'Actor', 'hulk'],
  ['Farm upload limit', '41b50ce6d4228116affce015c0d3023c', 'Actor', 'fleet'],
  ['Clawson Influx rehearsal', '41a50ce6d422818b8a9cf70188f67332', 'Actor', 'Clawson'],
] as const

it.each(normalized)('groups %s by its normalized Notion wait fields', (name, cardId, type, id) => {
  const multiline = name === 'Dirt Farm shared admission'
  const waiting = card(1, type, id, { Name: name, 'Next check-in': { start: '2026-11-18T15:00Z' },
    'Waiting For': multiline ? 'Dependency: Hulk mate must post the real next step.\nUnblocks when: Hulk posts an executable step or names the remaining gate.\nFollow-up by: Hulk mate' : 'Original blocker description' })
  waiting.id = waiting.source.id = cardId
  const merge = { id: mergeId, title: 'Gateway merge', status: 'Waiting For' }
  const result = waitingForGroups([waiting], [waiting], [merge], 'partial')
  expect(result.unclassified).toEqual([])
  expect(flat(result)).toMatchObject([{ type, id, cards: [{ id: cardId }] }])
  if (type === 'Work') expect(flat(result)[0]?.target).toEqual({ kind: 'url', url: 'https://www.notion.so/' + mergeId })
  expect((result.issues.get(cardId) ?? []).map(issue => issue.field)).toEqual(multiline ? [] : ['Unblocks when', 'Follow-up by'])
  if (name === 'Farm upload limit') {
    waiting.source.properties.Status!.value = 'Done'
    expect(waitingForGroups([waiting]).count).toBe(0)
  }
})

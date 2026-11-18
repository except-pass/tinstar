import { expect, it } from 'vitest'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { actionableWillCard, responsibleMate } from '../claimPolicy'
import { FIRST_MATE_TASKS } from '../workerLinks'

it.each(['Will', 'Owner', 'owner-chatgpt', 'Tin Star MCP', 'Tin Star UI'])('skips owner identity %s in both mate-touch representations', actor => {
  const card = structuredClone(fixtureSources().intentions.data!.cards[0]!)
  delete card.properties[FIRST_MATE_TASKS]
  card.properties['Last touched by'] = { id: 'touch', type: 'rich_text', value: actor, hasMore: false }
  const notes = [
    { text: 'Operation: edit\nTin Star operation: ["Clawson","mate-ask"]' },
    { text: `Operation: edit\nTin Star operation: ${JSON.stringify([actor, 'owner-edit'])}` },
  ]
  expect(responsibleMate(card, notes)).toEqual({ owner: 'Clawson', id: 'Clawson', tasks: [] })
  expect(responsibleMate(card, notes.slice(1))).toBeNull()
})

it.each([
  { Owner: 'Will' },
  { 'Will action': ['Merge'] },
  { Status: 'Waiting For', 'Waiting For ID': 'Will' },
  { Status: 'Waiting For', 'Waiting For': 'Will: pick a color' },
])('uses one card property signal %j and excludes inactive work', properties => {
  const card = structuredClone(fixtureSources().intentions.data!.cards[0]!)
  card.properties = Object.fromEntries(Object.entries({ Status: 'In Progress', ...properties }).map(([name, value]) =>
    [name, { id: name, type: null, value, hasMore: false }]))
  expect(actionableWillCard(card)).toBe(true)
  for (const status of ['Todo', 'Backlog', 'Archived', 'Done']) {
    card.properties.Status!.value = status
    expect(actionableWillCard(card)).toBe(false)
  }
})

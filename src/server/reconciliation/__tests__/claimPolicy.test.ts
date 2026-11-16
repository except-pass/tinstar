import { expect, it } from 'vitest'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { malformedWillAsk, responsibleMate } from '../claimPolicy'
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
  card.properties.Owner = { ...card.properties.Owner!, value: 'Will' }
  card.properties.Status = { ...card.properties.Status!, value: 'Waiting For' }
  card.properties['Waiting For ID'] = { id: 'wait', type: 'rich_text', value: '', hasMore: false }
  expect(malformedWillAsk(card)).toMatchObject({ card_id: card.id, mate: null })
})

import { expect, it } from 'vitest'
import { fixtureId, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { checkIn, compactCheckIn, taskFields } from '../recordFields'

const now = Date.parse('2026-11-05T02:00:00Z')

it.each([
  ['2026-11-04', 'overdue', 'Overdue · Nov 4 9 AM ET'],
  ['2026-11-03', 'overdue', 'Overdue · Nov 3 9 AM ET'],
  ['2026-11-05', 'upcoming', 'Nov 5 9 AM ET'],
  ['2026-11-04T20:59:00-05:00', 'overdue', 'Overdue · Nov 4, 8:59 PM'],
  ['2026-11-04T21:01:00-05:00', 'upcoming', 'Nov 4, 9:01 PM'],
  ['2026-11-04T21:00:00-05:00', 'upcoming', 'Nov 4, 9:00 PM'],
])('classifies check-in %s by its calendar or timestamp precision', (start, state, label) => {
  const card = fixtureScene({ now }).cards.find(card => card.id === fixtureId(1))!
  card.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start } }
  expect(checkIn(card, now)).toEqual({ state, label })
  expect(taskFields(card, now).find(([name]) => name === 'Next check-in')).toEqual(['Next check-in', label])
})

it('preserves missing, unknown and not-applicable checkpoints', () => {
  const card = fixtureScene({ now }).cards.find(card => card.id === fixtureId(1))!
  delete card.source.properties['Next check-in']
  expect(checkIn(card, now)).toEqual({ state: 'missing', label: 'Not scheduled' })
  card.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start: 'invalid' } }
  expect(checkIn(card, now)).toEqual({ state: 'unknown', label: 'Unknown' })
  card.source.properties.Status!.value = 'Done'
  expect(checkIn(card, now)).toEqual({ state: 'not-applicable', label: 'Not applicable' })
})

it('uses named timezone instants for visible state, elapsed time and compact display', () => {
  const at = Date.parse('2026-11-10T15:00:00Z')
  const card = fixtureScene({ now: at }).cards.find(card => card.id === fixtureId(1))!
  card.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false,
    value: { start: '2026-11-10T17:00:00', time_zone: 'Europe/Paris' } }
  expect(checkIn(card, at)).toEqual({ state: 'upcoming', label: 'Nov 10, 11:00 AM' })
  expect(compactCheckIn(card, at)).toBe('Check-in 11:00a')
  expect(compactCheckIn(card, at + 2 * 3600000)).toBe('Overdue 1h')
})

import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ActiveFilters } from '../ActiveFilters'
import { applyPresentationAction, initialPresentation, type PresentationState } from '../presentation'
import { fixtureId, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'

afterEach(cleanup)
const scene = fixtureScene()
function Harness({ initial }: { initial: PresentationState }) {
  const [state, setState] = useState(initial)
  return <><ActiveFilters state={state} send={action => setState(value => applyPresentationAction(value, action, scene).state)} /><output data-testid="view">{JSON.stringify(state)}</output></>
}
const current = () => JSON.parse(screen.getByTestId('view').textContent!) as PresentationState

it('shows only actual terms and removes one facet while preserving organizer, other filters and Search focus', () => {
  const state: PresentationState = { ...initialPresentation(), search: { query: 'global term', facets: [{ field: 'initiative', value: 'Tin Star' }, { field: 'machine', value: 'hulk' }], patterns: ['blocked', 'stale'] }, donutFilter: { cards: ['Waiting For'], workers: ['Running'] }, searchFocus: [{ kind: 'card', id: fixtureId(1) }], searchReveal: { kind: 'card', id: fixtureId(1) } }
  render(<Harness initial={state} />)
  const shelf = screen.getByRole('complementary', { name: 'Applied filters' })
  expect(shelf).toHaveTextContent('Active filters 6')
  expect(shelf).not.toHaveTextContent('global term')
  fireEvent.click(within(shelf).getByRole('button', { name: 'Remove Initiative: Tin Star' }))
  expect(current()).toMatchObject({ organizer: state.organizer, searchFocus: state.searchFocus, searchReveal: state.searchReveal, donutFilter: state.donutFilter, search: { query: 'global term', facets: [{ field: 'machine', value: 'hulk' }], patterns: ['blocked', 'stale'] } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove Pattern: Blocked' }))
  expect(current().search?.patterns).toEqual(['stale'])
})

it('Clear all removes explicit filters while keeping scope, organizer, navigation, density-independent state and Search focus', () => {
  const state: PresentationState = { ...initialPresentation(), statusFilter: { preset: 'all', statuses: [] }, search: { query: 'global term', facets: [{ field: 'initiative', value: 'Tin Star' }], patterns: ['blocked'] }, donutFilter: { cards: ['Waiting For'], workers: ['Running'] }, exceptionsOnly: true, selection: { kind: 'card', id: fixtureId(1) }, searchFocus: [{ kind: 'card', id: fixtureId(1) }], searchReveal: { kind: 'card', id: fixtureId(1) }, collapsed: ['group:keep'], navigation: { cardId: fixtureId(1), revision: 0 } }
  render(<Harness initial={state} />)
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
  expect(current()).toMatchObject({ statusFilter: state.statusFilter, organizer: state.organizer, selection: state.selection, navigation: state.navigation, collapsed: state.collapsed, searchFocus: state.searchFocus, searchReveal: state.searchReveal, search: { query: 'global term', facets: [], patterns: [] }, donutFilter: { cards: [], workers: [] }, exceptionsOnly: false })
  expect(screen.getByText('No active filters')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled()
})

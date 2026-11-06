import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fixtureId, fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { Overview } from '../Overview'
import { preferencesKey } from '../presentationPreferences'
import type { FloorScene } from '../presentation'

const observed = vi.hoisted(() => ({ scene: null as unknown }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now() }) }))
vi.mock('../useDeskQueue', () => ({ useDeskQueue: () => ({ queue: fixtureQueue(), error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
let scene: FloorScene
beforeEach(() => {
  localStorage.clear(); scene = fixtureScene()
  scene.cards.find(card => card.id === fixtureId(1))!.source.properties.Name!.value = 'Release Coordinator'
  observed.scene = scene
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const mount = () => render(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
const input = () => screen.getByRole('combobox', { name: 'Find names, IDs and text' })
const search = (value: string) => fireEvent.change(input(), { target: { value } })
const cardIds = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.ov-card')].map(element => element.dataset.entityId)

describe('Smart Search in the existing Overview', () => {
  it('offers only explicit Initiative values and excludes parent ancestry', () => {
    for (const card of scene.cards) {
      delete card.source.properties.Initiative
      card.ancestry = ['parent-only']
    }
    scene.cards.find(card => card.id === fixtureId(1))!.source.properties.Initiative = { id: 'initiative', type: 'relation', value: ['  explicit  '], hasMore: false }
    scene.cards.find(card => card.id === fixtureId(2))!.source.properties.Initiative = { id: 'initiative', type: 'multi_select', value: ['unsupported'], hasMore: false }
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    const select = screen.getByRole('combobox', { name: 'Search initiative' })
    expect(within(select).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['', 'explicit'])
    fireEvent.change(select, { target: { value: 'explicit' } })
    expect(screen.getByRole('button', { name: 'Remove initiative: explicit' })).toBeTruthy()
    expect(within(screen.getByRole('listbox', { name: 'Search results' })).getByRole('option', { name: /Release Coordinator/ })).toBeTruthy()
  })

  it.each(['Smart Search (Ctrl or Command K)', 'Remove search text', '← Back', 'Remove cards: Waiting For'])('restores the saved view on Escape from %s after Apply', label => {
    localStorage.setItem(preferencesKey, JSON.stringify({ search: { query: '', patterns: [], facets: [] }, organizer: { outer: 'machine', inner: 'initiative', order: 'priority', direction: 'desc' }, statusFilter: { preset: 'custom', statuses: ['Waiting For'] }, donutFilter: { cards: ['Waiting For'], workers: [] } }))
    const { container } = mount()
    const original = container.querySelector<HTMLElement>(`.ov-card[data-entity-id="${fixtureId(4)}"]`)!
    fireEvent.click(original)
    original.focus()
    const viewport = container.querySelector('.ov-canvas')?.parentElement
    if (!viewport) throw new Error('Missing Overview viewport')
    viewport.scrollLeft = 21
    const saved = JSON.parse(localStorage.getItem(preferencesKey)!)
    const cards = cardIds(container)
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    search('Release')
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    expect(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' })).toHaveFocus()
    viewport.scrollLeft = 0
    const target = screen.getByRole('button', { name: label })
    target.focus()
    fireEvent.keyDown(target, { key: 'Escape' })
    expect(JSON.parse(localStorage.getItem(preferencesKey)!)).toEqual(saved)
    expect(cardIds(container)).toEqual(cards)
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(4)}"]`)).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(4)}"]`)).toHaveFocus()
    expect(container.querySelector('.ov')).toHaveAttribute('data-density', 'compact')
    expect(viewport.scrollLeft).toBe(21)
    expect(screen.queryByRole('button', { name: '← Back' })).toBeNull()
  })

  it('expands a previously collapsed Detailed result and restores its collapsed state on exit', () => {
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.click(screen.getByRole('button', { name: /^Detailed$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    const selector = `.ov-card[data-entity-id="${fixtureId(1)}"]`
    fireEvent.click(container.querySelector(selector)!)
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    search('Release')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.ov')).toHaveAttribute('data-density', 'detailed')
  })
  it('opens with Ctrl/Cmd K, searches with highlighted field evidence and focuses one-hop results with Enter', () => {
    const { container } = mount()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(input()).toHaveFocus()
    search('releese coordnator')
    expect(screen.getAllByRole('option').filter(element => element.id.startsWith('ov-search-hit-'))).toHaveLength(1)
    expect(within(screen.getByRole('listbox', { name: 'Search results' })).getByRole('option', { name: /Release Coordinator/ })).toHaveTextContent('Notion property')
    expect(container.querySelector('.ov-search-snippet mark')).toBeTruthy()
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.queryByRole('combobox', { name: 'Find names, IDs and text' })).toBeNull()
    const card = container.querySelector<HTMLElement>(`.ov-card[data-entity-id="${fixtureId(1)}"]`)!
    expect(card).toHaveAttribute('aria-expanded', 'true')
    expect(card).toHaveFocus()
    expect(container.querySelectorAll('.ov-execution')).toHaveLength(2)
    expect(screen.queryByRole('region', { name: 'Inspector' })).toBeNull()
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(cardIds(container)).toHaveLength(5)
    expect(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(input()).toHaveFocus()
  })
  it('offers outside-scope records without changing donut or base scope, then restores their exact settings', () => {
    localStorage.setItem(preferencesKey, JSON.stringify({ organizer: { outer: 'machine', inner: 'initiative', order: 'priority', direction: 'desc' }, statusFilter: { preset: 'custom', statuses: ['Waiting For'] }, donutFilter: { cards: ['Waiting For'], workers: [] } }))
    const { container } = mount()
    expect(cardIds(container)).toEqual([fixtureId(4)])
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    search('Roadmap')
    const result = within(screen.getByRole('listbox', { name: 'Search results' })).getByRole('option', { name: /Roadmap: planned integration/ })
    expect(result).toHaveTextContent('Outside current view')
    fireEvent.click(result)
    expect(cardIds(container)).toEqual([fixtureId(5)])
    expect(container.querySelector('.ov')).toHaveAttribute('data-preset', 'custom')
    fireEvent.click(screen.getByRole('button', { name: '← Back' }))
    expect(cardIds(container)).toEqual([fixtureId(4)])
    expect(container.querySelector('.ov')).toHaveAttribute('data-order', 'priority')
    expect(container.querySelector('.ov')).toHaveAttribute('data-direction', 'desc')
    expect(screen.getByRole('button', { name: 'Remove cards: Waiting For' })).toBeTruthy()
  })
  it('keeps unsupported patterns unavailable, explains matches and persists applied chips', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    for (const name of ['Stalled', 'Idle workers', 'State mismatch', 'Stale']) expect(screen.getByRole('button', { name: `${name} · unavailable` })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Blocked' }))
    const panel = screen.getByRole('region', { name: 'Smart Search' })
    expect(within(screen.getByRole('listbox', { name: 'Search results' })).getByRole('option', { name: /Waiting for input/ })).toBeTruthy()
    fireEvent.click(within(panel).getByText(/Why matched\?/))
    expect(panel).toHaveTextContent('Input from reviewer')
    fireEvent.change(screen.getByRole('combobox', { name: 'Search machine' }), { target: { value: 'Hulk' } })
    expect(screen.getByRole('button', { name: 'Remove machine: Hulk' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    const saved = JSON.parse(localStorage.getItem(preferencesKey)!)
    expect(saved.search).toMatchObject({ patterns: ['blocked'], facets: [{ field: 'machine', value: 'Hulk' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Clear Smart Search' }))
    expect(screen.queryByRole('button', { name: 'Remove machine: Hulk' })).toBeNull()
  })
  it('restores existing expanded roots and density on Escape instead of preserving temporary result expansion', () => {
    const { container } = mount()
    const original = container.querySelector<HTMLButtonElement>(`.ov-card[data-entity-id="${fixtureId(4)}"]`)!
    fireEvent.click(original)
    expect(original).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    search('Release')
    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(4)}"]`)).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(1)}"]`)).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.ov')).toHaveAttribute('data-density', 'compact')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fixtureId, fixtureQueue, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { DeskWorkspace, useDeskWorkspace } from '../../ask/DeskWorkspace'
import { Overview as NativeOverview } from '../Overview'
import { Overview } from '../../../test-fixtures/reconciliation/Overview'
import type { FloorScene } from '../presentation'
import { overviewDensityKey } from '../overviewDensity'
import { preferencesKey } from '../presentationPreferences'

const observed = vi.hoisted(() => ({ scene: null as unknown, error: null as string | null }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: observed.error, now: Date.now() }) }))
vi.mock('../useDeskQueue', () => ({ useDeskQueue: () => ({ queue: fixtureQueue(), error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
let scene: FloorScene
function set(id: number, values: Record<string, unknown>) {
  const card = scene.cards.find(card => card.id === fixtureId(id))!
  for (const [name, value] of Object.entries(values)) card.source.properties[name] = { id: name, type: 'rich_text', hasMore: false, value }
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); scene = fixtureScene(); observed.error = null
  set(1, { Status: 'Waiting For', 'Waiting For Type': 'Actor', 'Waiting For ID': 'Will' })
  set(6, { Status: 'Waiting For', 'Waiting For Type': 'Actor', 'Waiting For ID': 'Will' })
  set(4, { 'Waiting For Type': 'Event', 'Waiting For ID': 'cmsandbox PR #3362 merged' })
  observed.scene = scene
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function mount() { return render(<Overview workers={[]} messages={[]} submit={vi.fn()} />) }
const select = () => fireEvent.click(screen.getByRole('button', { name: 'Cards: Waiting For, 3' }))
const group = (name: string) => within(screen.getByRole('region', { name: 'Waiting For work' })).getByRole('button', { name })
const card = (host: HTMLElement, n: number) => host.querySelector<HTMLButtonElement>(`.ov-waiting-card[data-entity-id="${fixtureId(n)}"]`)!

describe('Waiting For in the native Overview', () => {
  it.each(['dropdown', 'chip'])('enters Waiting For through %s after selecting other work in Search', entry => {
    set(3, { Name: 'Search entry regression', Status: 'In Progress' })
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Search entry regression' } })
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Search results' })).getAllByRole('option')[0]!)
    expect(container.querySelector(`.ov-card.ov-search-match[data-entity-id="${fixtureId(3)}"]`)).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Waiting For work' })).toBeNull()
    if (entry === 'dropdown') {
      fireEvent.click(screen.getByRole('button', { name: 'Choose pattern' }))
      fireEvent.click(screen.getByRole('option', { name: 'Waiting For' }))
    } else fireEvent.click(screen.getByRole('button', { name: 'Waiting For' }))
    expect(screen.getByRole('region', { name: 'Waiting For work' })).toHaveTextContent('Waiting For · 3')
    expect(container.querySelectorAll('.ov-search-match')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
  })
  it('keeps the chip entry-only with a sole Custom Waiting For status', () => {
    localStorage.setItem(preferencesKey, JSON.stringify({ statusFilter: { preset: 'custom', statuses: ['Waiting For'] } }))
    mount()
    const chip = screen.getByRole('button', { name: 'Waiting For' })
    fireEvent.click(chip)
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Remove Cards: Waiting For' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Waiting For work' })).toHaveTextContent('Waiting For · 3')
  })
  it('preserves worker rows and organizer, filters only the Work groups and restores on exit', () => {
    const { container } = mount()
    const workers = [...container.querySelectorAll<HTMLElement>('.ov-execution')].map(row => row.dataset.entityId).sort()
    const organizer = container.querySelector('.ov')!.getAttribute('data-outer')
    select()
    expect(screen.getByRole('region', { name: 'Waiting For work' })).toHaveTextContent('Waiting For · 3')
    expect([...container.querySelectorAll<HTMLElement>('.ov-execution')].map(row => row.dataset.entityId).sort()).toEqual(workers)
    expect(container.querySelectorAll('.ov-card')).toHaveLength(3)
    fireEvent.click(within(screen.getByRole('group', { name: 'Waiting For Type' })).getByRole('button', { name: 'Event' }))
    expect(card(container, 1)).toBeNull(); expect(card(container, 4)).toBeTruthy()
    expect(container.querySelectorAll('.ov-execution')).toHaveLength(workers.length)
    select()
    expect(screen.queryByRole('region', { name: 'Waiting For work' })).toBeNull()
    expect(container.querySelector('.ov')!.getAttribute('data-outer')).toBe(organizer)
  })
  it('preserves Detailed workers while keeping affected Work rows compact', () => {
    localStorage.setItem(overviewDensityKey, 'detailed')
    const { container } = mount(); select()
    expect(container.querySelector('.ov-execution')).not.toHaveClass('ov-collapsed')
    expect(container.querySelectorAll('.ov-waiting-card')).toHaveLength(3)
    expect(container.querySelectorAll('.ov-waiting-card.ov-inline-expanded')).toHaveLength(0)
  })
  it('opens the existing Inspector and directly linked workers without expanding siblings', () => {
    const { container } = mount(); select()
    fireEvent.click(card(container, 1))
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeTruthy()
    expect(container.querySelectorAll('.ov-waiting-card')).toHaveLength(3)
    const linked = scene.claims.filter(link => link.cardId === fixtureId(1) && link.verification === 'confirmed' && link.state === 'current').map(link => link.executionId)
    for (const id of linked) expect(container.querySelector(`.ov-execution[data-entity-id='${id}']`)).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelectorAll('.ov-waiting-card.ov-inline-expanded')).toHaveLength(0)
    fireEvent.keyDown(container.querySelector('.ov')!, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Inspector' })).toBeNull()
  })
  it('retains independent expansion through refresh, reload and search restoration', () => {
    const { rerender, unmount } = mount(); select()
    const will = () => group('Will, 2 cards')
    fireEvent.click(will()); expect(will()).toHaveAttribute('aria-expanded', 'false')
    scene = { ...scene, generatedAt: new Date().toISOString() }; observed.scene = scene
    rerender(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
    expect(will()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Will' } })
    fireEvent.click(screen.getAllByRole('option')[0]!)
    expect(group('Will, 1 card')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    expect(will()).toHaveAttribute('aria-expanded', 'false')
    unmount(); mount()
    expect(will()).toHaveAttribute('aria-expanded', 'false')
  })
  it('moves selected cards between groups after refresh without duplicate rows', () => {
    const { container, rerender } = mount(); select()
    fireEvent.click(card(container, 1))
    set(1, { 'Waiting For ID': 'Duke Energy' })
    scene = { ...scene, generatedAt: new Date().toISOString() }; observed.scene = scene
    rerender(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
    expect(group('Duke Energy, 1 card')).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelectorAll(`.ov-waiting-card[data-entity-id='${fixtureId(1)}']`)).toHaveLength(1)
    expect(card(container, 1)).toHaveClass('selected')
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeTruthy()
    set(1, { Status: 'Queued' }); scene = { ...scene }; observed.scene = scene
    rerender(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
    expect(card(container, 1)).toBeNull()
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeTruthy()
  })
  it('shows precise missing-field information in Inspector and source failures without a false zero', () => {
    set(1, { 'Waiting For ID': '' })
    localStorage.setItem(preferencesKey, JSON.stringify({ donutFilter: { cards: ['Waiting For'], workers: [] } }))
    const { container, rerender } = mount()
    expect(screen.getByRole('region', { name: 'Needs classification' })).toHaveTextContent('1')
    fireEvent.click(card(container, 1))
    expect(screen.getByText('Waiting For ID is missing.')).toBeTruthy()
    observed.error = 'Read failed'
    rerender(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
    expect(screen.getByText(/Could not refresh Waiting For. Showing the last known cards./)).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Waiting For work' })).toHaveTextContent('Waiting For · 3')
  })
})


it.each(['outside scope', 'collapsed category'] as const)('temporarily reveals a flash in Waiting For with %s while preserving saved choices', async mode => {
  vi.useFakeTimers()
  localStorage.setItem(preferencesKey, JSON.stringify({ donutFilter: { cards: ['Waiting For'], workers: [] } }))
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    return new Response(JSON.stringify({ ok: true, data: body.type === 'register' ? { scene_id: 'test', key: 'secret' } : { commands: [] } }))
  }))
  let current!: ReturnType<typeof useDeskWorkspace>
  function Probe() { current = useDeskWorkspace(); return null }
  function Browser() { return <DeskWorkspace overviewActive onOverview={() => {}} workers={[]} messages={[]} submit={vi.fn()}><Probe /><NativeOverview workers={[]} /></DeskWorkspace> }
  const view = render(<Browser />), { container } = view
  await act(async () => {})
  const targetId = mode === 'outside scope' ? fixtureId(5) : fixtureId(1)
  if (mode === 'collapsed category') {
    fireEvent.click(group('Will, 2 cards'))
    fireEvent.click(within(screen.getByRole('group', { name: 'Waiting For Type' })).getByRole('button', { name: 'Event' }))
  }
  const expansion = sessionStorage.getItem('tinstar.overview.waitingFor.expansion.v1')
  const filters = structuredClone(current.state.donutFilter)
  expect(container.querySelector(`.ov-card[data-entity-id="${targetId}"]`)).toBeNull()
  act(() => { expect(current.send({ type: 'flash', targets: [{ kind: 'card', id: targetId }], origin: 'assistant' })?.outcome).toBe('applied') })
  expect(container.querySelector(`.ov-card[data-entity-id="${targetId}"]`)).toHaveClass('flashed')
  expect(current.state.donutFilter).toEqual(filters)
  expect(sessionStorage.getItem('tinstar.overview.waitingFor.expansion.v1')).toBe(expansion)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  view.rerender(<Browser />)
  expect(container.querySelector(`.ov-card[data-entity-id="${targetId}"]`)).toBeNull()
  expect(screen.getByRole('region', { name: 'Waiting For work' })).toBeTruthy()
  expect(current.state.donutFilter).toEqual(filters)
  expect(sessionStorage.getItem('tinstar.overview.waitingFor.expansion.v1')).toBe(expansion)
  if (mode === 'collapsed category') {
    expect(within(screen.getByRole('group', { name: 'Waiting For Type' })).getByRole('button', { name: 'Event' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(screen.getByRole('group', { name: 'Waiting For Type' })).getByRole('button', { name: 'All' }))
    expect(group('Will, 2 cards')).toHaveAttribute('aria-expanded', 'false')
  }
})

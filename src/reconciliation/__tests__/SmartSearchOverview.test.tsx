import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fixtureId, fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { Overview } from '../Overview'
import { preferencesKey } from '../presentationPreferences'
import type { FloorScene, PresentationAction } from '../presentation'
import { actionSchema } from '../../shared/reconciliationCommands'

const observed = vi.hoisted(() => ({ scene: null as unknown, send: null as null | ((action: PresentationAction) => unknown) }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now() }) }))
vi.mock('../usePresentation', async importOriginal => {
  const original = await importOriginal<typeof import('../usePresentation')>()
  return { usePresentation: (...args: Parameters<typeof original.usePresentation>) => {
    const result = original.usePresentation(...args)
    observed.send = result.send
    return result
  } }
})
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

describe('compact search palette and temporary graph focus', () => {
  it('opens empty without changing the floor, limits suggestions and omits replaced controls', () => {
    const { container } = mount(), before = cardIds(container)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(input()).toHaveFocus()
    expect(screen.getByRole('listbox', { name: 'Search results' }).children).toHaveLength(0)
    expect(cardIds(container)).toEqual(before)
    for (const label of ['Search entity', 'Search initiative', 'Search machine', 'Search manager']) expect(screen.queryByLabelText(label)).toBeNull()
    expect(container.textContent).not.toMatch(/Why matched|Index coverage|Apply filters/)
    search('worker')
    expect(screen.getAllByRole('option').length).toBeLessThanOrEqual(8)
    expect(cardIds(container)).toEqual(before)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
    expect(cardIds(container)).toEqual(before)
  })

  it('ranks fuzzy names and expands only a verified one-hop cluster while retaining dimmed context', () => {
    const link = scene.claims.find(link => link.cardId === fixtureId(1))!
    scene.claims.push({ ...link, id: 'second-hop', cardId: fixtureId(6) })
    const { container } = mount(), before = cardIds(container)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    search('releese coordnator')
    expect(within(screen.getByRole('listbox', { name: 'Search results' })).getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
    const selected = container.querySelector(`.ov-card[data-entity-id="${fixtureId(1)}"]`)!
    expect(selected).toHaveFocus()
    expect(selected).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelectorAll('.ov-execution.ov-search-match')).toHaveLength(2)
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(6)}"]`)).toHaveClass('ov-search-context')
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(6)}"]`)).toHaveAttribute('aria-expanded', 'false')
    expect(cardIds(container)).toEqual(before)
    expect(screen.queryByRole('region', { name: 'Inspector' })).toBeNull()
  })

  it('focuses a named machine and only its canonical workers and verified linked work', () => {
    const { container } = mount()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    search('Hulk')
    const machine = within(screen.getByRole('listbox', { name: 'Search results' })).getByRole('option', { name: /^Hulk.*Machine/ })
    fireEvent.click(machine)
    expect(container.querySelectorAll('.ov-execution.ov-search-match')).toHaveLength(4)
    expect(container.querySelectorAll('.ov-card.ov-search-match')).toHaveLength(2)
    expect(container.querySelectorAll('.ov-execution.ov-search-context')).toHaveLength(1)
    expect(container.querySelectorAll('.ov-execution[aria-expanded="true"]')).toHaveLength(4)
  })

  it('finds a PR by source identifier and never invents a worker/card connection', () => {
    const worker = scene.executions.find(worker => worker.identity.task_id === 'untracked-worker')!
    worker.source.pr.url = 'https://github.com/example/project/pull/3253'
    const { container } = mount()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    search('3253')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(container.querySelectorAll('.ov-execution.ov-search-match')).toHaveLength(1)
    expect(container.querySelectorAll('.ov-card.ov-search-match')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    expect(container.querySelectorAll('.ov-search-match')).toHaveLength(0)
  })

  it('reveals outside active scope without replacing existing results and restores all prior view settings', () => {
    localStorage.setItem(preferencesKey, JSON.stringify({ organizer: { outer: 'machine', inner: 'initiative', order: 'priority', direction: 'desc' }, statusFilter: { preset: 'custom', statuses: ['Waiting For'] }, donutFilter: { cards: ['Waiting For'], workers: [] }, search: { query: '', patterns: [], facets: [] } }))
    const { container } = mount()
    const original = container.querySelector<HTMLElement>(`.ov-card[data-entity-id="${fixtureId(4)}"]`)!
    fireEvent.click(original); original.focus()
    const viewport = container.querySelector('.ov-canvas')!.parentElement!
    viewport.scrollLeft = 21
    const saved = JSON.parse(localStorage.getItem(preferencesKey)!)
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    search('Roadmap: planned integration')
    const result = within(screen.getByRole('listbox', { name: 'Search results' })).getByRole('option', { name: /Roadmap: planned integration/ })
    expect(result).toHaveTextContent('Outside current view')
    fireEvent.click(result)
    expect(cardIds(container).sort()).toEqual([fixtureId(4), fixtureId(5)].sort())
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(4)}"]`)).toHaveClass('ov-search-context')
    viewport.scrollLeft = 0
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    expect(cardIds(container)).toEqual([fixtureId(4)])
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(4)}"]`)).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(4)}"]`)).toHaveFocus()
    expect(JSON.parse(localStorage.getItem(preferencesKey)!)).toEqual(saved)
    expect(viewport.scrollLeft).toBe(21)
    expect(container.querySelector('.ov')).toHaveAttribute('data-density', 'compact')
  })

  it('first Esc closes a reopened palette, second Esc clears focus; outside click closes only the palette', () => {
    const { container } = mount()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true }); search('Release'); fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
    expect(container.querySelectorAll('.ov-search-match')).toHaveLength(3)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelectorAll('.ov-search-match')).toHaveLength(0)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.pointerDown(container.querySelector('.ov-headings')!)
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
  })

  it.each(['card', 'worker'] as const)('temporarily reveals a planned %s after hiding roadmap', kind => {
    const planned = scene.cards.find(card => card.id === fixtureId(1))!
    planned.expectation = 'wait-planned'
    const claim = scene.claims.find(claim => claim.cardId === planned.id && claim.verification === 'confirmed')!
    const worker = scene.executions.find(worker => worker.id === claim.executionId)!
    const { container } = mount()
    act(() => { observed.send!(actionSchema.parse({ type: 'set-roadmap', expanded: false })) })
    const selector = `.ov-card[data-entity-id="${planned.id}"]`
    expect(container.querySelector(selector)).toBeNull()
    const before = cardIds(container)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    search(kind === 'card' ? 'Release Coordinator' : worker.identity.task_id!)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector(selector)).toBeNull()
    expect(cardIds(container)).toEqual(before)
  })

  it('restores Detailed collapsed state and density, and handles mobile Back in two levels', () => {
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.click(screen.getByRole('button', { name: /^Detailed$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    const selector = `.ov-card[data-entity-id="${fixtureId(1)}"]`
    fireEvent.click(container.querySelector(selector)!)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true }); search('Release'); fireEvent.keyDown(input(), { key: 'Enter' })
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'true')
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.ov')).toHaveAttribute('data-density', 'detailed')
  })
})

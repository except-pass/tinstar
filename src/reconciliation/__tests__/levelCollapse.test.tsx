import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fixtureId, fixtureQueue, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { Overview } from '../../../test-fixtures/reconciliation/Overview'
import { organizedGroups, waitingForWorkerScope } from '../../shared/floorOrganization'
import { applyPresentationAction, initialPresentation, semanticId } from '../presentation'
import type { FloorScene } from '../presentation'
import { preferencesKey } from '../presentationPreferences'
import { nextLevelCollapsed, overviewLevelControls } from '../overviewLevelCollapse'

const observed = vi.hoisted(() => ({ scene: null as unknown }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now() }) }))
vi.mock('../useDeskQueue', () => ({ useDeskQueue: () => ({ queue: fixtureQueue(), error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))

const organizer = { outer: 'initiative' as const, inner: 'epic' as const, order: 'operational' as const, direction: 'asc' as const }
let scene: FloorScene

function tag(cardId: string, initiative: string, epic: string) {
  const card = scene.cards.find(item => item.id === cardId)!
  card.source.properties.Initiative = { id: 'Initiative', type: 'select', value: initiative, hasMore: false }
  card.source.properties.Epic = { id: 'Epic', type: 'select', value: epic, hasMore: false }
}

beforeEach(() => {
  localStorage.clear()
  scene = fixtureScene()
  tag(fixtureId(1), 'Tin Star', 'Operational Floor')
  tag(fixtureId(2), 'Tin Star', 'Site Config')
  tag(fixtureId(3), 'Dirt Farm', 'CI')
  tag(fixtureId(6), 'Dirt Farm', 'CI')
  tag(fixtureId(4), 'Tin Star', 'Site Config')
  observed.scene = scene
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.setItem(preferencesKey, JSON.stringify({ organizer, statusFilter: { preset: 'all', statuses: [] } }))
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

const mount = () => render(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
const level = (name: RegExp | string) => screen.getByRole('button', { name })
const outers = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.ov-outer > .ov-group-head > button')]
const epics = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.ov-inner .ov-group > .ov-group-head > button')]
const expanded = (buttons: HTMLButtonElement[]) => buttons.filter(button => button.getAttribute('aria-expanded') === 'true')

describe('initiative and epic bulk collapse', () => {
  it('keeps each level independent and restores epic expansion after an initiative collapse', () => {
    const { container } = mount()
    expect(level('Initiatives — collapse all')).toBeEnabled()
    expect(level('Epics — collapse all')).toBeEnabled()
    expect(container.querySelector('[data-level="initiative"]')).toHaveAttribute('data-tier', 'one')
    expect(container.querySelector('[data-level="epic"]')).toHaveAttribute('data-tier', 'two')
    const epicButtons = epics(container)
    expect(epicButtons.length).toBeGreaterThan(1)
    const kept = epicButtons[0]!
    const keptName = kept.getAttribute('aria-label')!.replace(/^(Expand|Collapse) /, '')
    fireEvent.click(kept)
    expect(kept).toHaveAttribute('aria-expanded', 'false')
    expect(expanded(epicButtons).length).toBe(epicButtons.length - 1)

    fireEvent.click(level('Initiatives — collapse all'))
    expect(outers(container).every(button => button.getAttribute('aria-expanded') === 'false')).toBe(true)
    const disabledEpics = level(/Epics — no visible groups/)
    expect(disabledEpics).toBeDisabled()
    fireEvent.click(disabledEpics)
    expect(outers(container).every(button => button.getAttribute('aria-expanded') === 'false')).toBe(true)

    fireEvent.click(level('Initiatives — expand all'))
    expect(outers(container).every(button => button.getAttribute('aria-expanded') === 'true')).toBe(true)
    const restored = epics(container)
    expect(restored.find(button => button.getAttribute('aria-label')?.endsWith(keptName))).toHaveAttribute('aria-expanded', 'false')
    expect(expanded(restored).length).toBe(restored.length - 1)

    fireEvent.click(level('Epics — collapse all'))
    expect(epics(container).every(button => button.getAttribute('aria-expanded') === 'false')).toBe(true)
    expect(outers(container).every(button => button.getAttribute('aria-expanded') === 'true')).toBe(true)
    fireEvent.click(level('Epics — expand all'))
    expect(epics(container).every(button => button.getAttribute('aria-expanded') === 'true')).toBe(true)
    expect(outers(container).every(button => button.getAttribute('aria-expanded') === 'true')).toBe(true)

    fireEvent.click(outers(container)[0]!)
    expect(level('Initiatives — collapse all')).toBeEnabled()
    fireEvent.click(level('Initiatives — collapse all'))
    expect(outers(container).every(button => button.getAttribute('aria-expanded') === 'false')).toBe(true)
    fireEvent.click(level('Initiatives — expand all'))
    expect(epics(container).every(button => button.getAttribute('aria-expanded') === 'true')).toBe(true)
  })

  it('leaves hidden groups and the other level untouched in the collapsed set', () => {
    const state = { ...initialPresentation(), organizer, statusFilter: { preset: 'all' as const, statuses: [] } }
    const groups = organizedGroups(scene, state, Date.now())
    const controls = overviewLevelControls(groups, [], organizer)
    expect(controls.initiatives.disabled).toBe(false)
    expect(controls.epics.disabled).toBe(false)
    expect(controls.initiatives.action).toBe('collapse')
    const hidden = 'group:hidden-epic'
    const manager = semanticId({ kind: 'manager', id: '/fixture/hulk' })
    const collapsed = nextLevelCollapsed([hidden, manager, controls.epics.ids[0]!], controls.initiatives.ids, 'collapse')
    expect(collapsed).toEqual(expect.arrayContaining([hidden, manager, controls.epics.ids[0]!, ...controls.initiatives.ids]))
    expect(nextLevelCollapsed(collapsed, controls.initiatives.ids, 'expand')).toEqual([hidden, manager, controls.epics.ids[0]!])
    const visibleOnly = overviewLevelControls(groups, controls.initiatives.ids, organizer)
    expect(visibleOnly.epics.disabled).toBe(true)
    expect(visibleOnly.epics.name).toMatch(/no visible groups/)
    const epicCollapse = nextLevelCollapsed(collapsed, visibleOnly.epics.ids, 'collapse')
    expect(epicCollapse.filter(id => controls.initiatives.ids.includes(id))).toEqual(controls.initiatives.ids)
  })

  it.each(['donut', 'custom-status'] as const)('accepts Waiting For worker groups through set-expanded with %s filtering', mode => {
    const now = Date.now()
    let state = { ...initialPresentation(), organizer,
      statusFilter: { preset: mode === 'custom-status' ? 'custom' as const : 'all' as const, statuses: mode === 'custom-status' ? ['Waiting For'] : [] },
      donutFilter: { cards: ['Waiting For'], workers: [] } }
    const savedFilters = { statusFilter: state.statusFilter, donutFilter: state.donutFilter, organizer: state.organizer }
    const originalScene = structuredClone(scene)
    const workerGroups = organizedGroups(scene, waitingForWorkerScope(state), now).filter(group => group.workers.length)
    const workerGroup = workerGroups.find(group => group.cardIds.includes(fixtureId(1)))!
    expect(workerGroup).toBeDefined()
    expect(organizedGroups(scene, state, now).some(group => group.outerId === workerGroup.outerId)).toBe(false)
    const initiative = semanticId({ kind: 'group', id: workerGroup.outerId })
    const epic = semanticId({ kind: 'group', id: workerGroup.id })
    const activate = (level: 'initiatives' | 'epics') => {
      const control = overviewLevelControls(workerGroups, state.collapsed, organizer)[level]
      expect(control.disabled).toBe(false)
      for (const id of control.ids) {
        const result = applyPresentationAction(state, { type: 'set-expanded', target: { kind: 'group', id: id.slice('group:'.length) }, expanded: control.action === 'expand' }, scene, now)
        expect(result.outcome).toBe('applied')
        state = result.state as typeof state
      }
    }
    activate('epics')
    expect(state.collapsed).toContain(epic)
    expect(state.collapsed).not.toContain(initiative)
    const childState = [...state.collapsed]
    activate('initiatives')
    expect(state.collapsed).toContain(initiative)
    expect(state.collapsed).toEqual(expect.arrayContaining(childState))
    activate('initiatives')
    expect(state.collapsed).toEqual(childState)
    activate('epics')
    expect(state.collapsed).not.toContain(epic)
    expect(state.collapsed).not.toContain(initiative)
    expect({ statusFilter: state.statusFilter, donutFilter: state.donutFilter, organizer: state.organizer }).toEqual(savedFilters)
    expect(scene).toEqual(originalScene)
  })

  it('disables both controls when the current tree has neither level', () => {
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'By Machine' }))
    expect(level('Initiatives — no visible groups')).toBeDisabled()
    expect(level('Epics — no visible groups')).toBeDisabled()
    expect(container.querySelectorAll('.ov-outer').length).toBeGreaterThan(0)
  })
})

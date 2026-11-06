import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fixtureId, fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { Overview } from '../Overview'
import { overviewDensityKey } from '../overviewDensity'
import { preferencesKey } from '../presentationPreferences'
import { expandedRelationships } from '../overviewModel'
import type { FloorScene } from '../presentation'

const observed = vi.hoisted(() => ({ scene: null as unknown, error: null as string | null }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: observed.error, now: Date.now() }) }))
vi.mock('../useDeskQueue', () => ({ useDeskQueue: () => ({ queue: fixtureQueue(), error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
const resizeCallbacks = new Set<() => void>()
let scene: FloorScene
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(preferencesKey, JSON.stringify({ organizer: { outer: 'initiative', inner: 'status', order: 'checkIn', direction: 'asc' } }))
  scene = fixtureScene()
  const first = scene.claims.find(c => c.cardId === fixtureId(1))!
  // W1 -> T1,T6; W2 -> T1. Expanding W1 must never recursively open W2.
  scene.claims.push({ ...first, id: 'second-direct-task', cardId: fixtureId(6) })
  observed.scene = scene
  observed.error = null
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallbacks.add(callback) } observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); localStorage.clear(); resizeCallbacks.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const mount = () => {
  const view = render(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
  return view
}
const worker = (host: HTMLElement, taskId: string) => [...host.querySelectorAll<HTMLButtonElement>('.ov-execution')].find(el => el.dataset.entityId === scene.executions.find(w => w.identity.task_id === taskId)!.id)!
const task = (host: HTMLElement, id: number) => host.querySelector<HTMLButtonElement>(`.ov-card[data-entity-id="${fixtureId(id)}"]`)!
const open = (element: HTMLElement) => expect(element).toHaveAttribute('aria-expanded', 'true')
const closed = (element: HTMLElement) => expect(element).toHaveAttribute('aria-expanded', 'false')
function arrange(outer: string, inner = 'none') {
  fireEvent.change(screen.getByLabelText('Outer grouping'), { target: { value: outer } })
  fireEvent.change(screen.getByLabelText('Inner grouping'), { target: { value: inner } })
}

describe('Ultra Compact Overview', () => {
  it('defaults to collapsed endpoints with honest unmatched labels and full accessible titles', () => {
    const { container } = mount()
    expect(container.querySelector('.ov')).toHaveAttribute('data-density', 'compact')
    expect(screen.getByRole('button', { name: 'Ultra Compact' })).toHaveAttribute('aria-pressed', 'true')
    expect(container.querySelectorAll('.ov-collapsed')).toHaveLength(10)
    expect(container.textContent).not.toContain('No activity published')
    expect(task(container, 2).textContent).toContain('No linked worker')
    const w = worker(container, 'linked-worker')
    expect(w.getAttribute('title')).toBeTruthy()
    expect(w.getAttribute('aria-label')).toContain(w.getAttribute('title'))
  })
  it('expands one worker and every direct task, with no transitive expansion', () => {
    const { container } = mount()
    fireEvent.click(worker(container, 'linked-worker'))
    open(worker(container, 'linked-worker')); open(task(container, 1)); open(task(container, 6))
    closed(worker(container, 'helper-worker')); closed(task(container, 4))
    expect(screen.queryByLabelText('Inspector')).toBeNull()
    fireEvent.click(worker(container, 'linked-worker'))
    closed(task(container, 1)); closed(task(container, 6))
  })
  it('expands a task with two workers and keeps unrelated relationship roots independently open', () => {
    const { container } = mount()
    fireEvent.click(task(container, 1))
    open(task(container, 1)); open(worker(container, 'linked-worker')); open(worker(container, 'helper-worker'))
    closed(task(container, 6))
    fireEvent.click(worker(container, 'blocked-worker'))
    open(task(container, 4)); open(task(container, 1))
    fireEvent.click(task(container, 1))
    closed(worker(container, 'linked-worker')); closed(worker(container, 'helper-worker'))
    open(worker(container, 'blocked-worker')); open(task(container, 4))
  })
  it('unions overlapping roots without losing a shared counterpart when one closes', () => {
    const { container } = mount()
    fireEvent.click(worker(container, 'linked-worker'))
    fireEvent.click(worker(container, 'helper-worker'))
    fireEvent.click(worker(container, 'linked-worker'))
    open(task(container, 1)); closed(task(container, 6)); open(worker(container, 'helper-worker'))
  })
  it('deduplicates canonical tasks across groups and expands workers in both groups', () => {
    const { container } = mount()
    arrange('machine')
    expect(container.querySelectorAll(`.ov-card[data-entity-id="${fixtureId(1)}"]`)).toHaveLength(1)
    expect(container.querySelector('.ov-headings')).toHaveTextContent('NOTION TASKS · 5')
    fireEvent.click(task(container, 1))
    open(worker(container, 'linked-worker')); open(worker(container, 'helper-worker'))
    expect(task(container, 1).querySelector('.ov-reference')).toBeTruthy()
    expect(container.querySelectorAll('.ov-compact-connections .ov-line')).toHaveLength(4)
  })
  it('reveals direct tasks excluded by a status filter and restores the filter on collapse', () => {
    scene.cards.find(c => c.id === fixtureId(6))!.source.properties.Status!.value = 'Backlog'
    const { container } = mount()
    expect(task(container, 6)).toBeNull()
    fireEvent.click(worker(container, 'linked-worker'))
    open(task(container, 6))
    expect(screen.getByLabelText('Status preset')).toHaveValue('operational')
    fireEvent.click(worker(container, 'linked-worker'))
    expect(task(container, 6)).toBeNull()
  })
  it('labels confirmed Backlog counterparts outside the Operational view', () => {
    for (const id of [1, 6]) scene.cards.find(c => c.id === fixtureId(id))!.source.properties.Status!.value = 'Backlog'
    const { container } = mount()
    expect(task(container, 1)).toBeNull()
    expect(task(container, 6)).toBeNull()
    const group = worker(container, 'linked-worker').closest('.ov-group')!
    expect(group.querySelector('.ov-card-stack .ov-empty-col')).toHaveTextContent('Linked task outside this view')
    expect(group).not.toHaveTextContent('No linked task')
  })
  it('labels a confirmed worker hidden from the current view', () => {
    for (const w of scene.executions) w.liveness = 'finished'
    const { container } = mount()
    const group = task(container, 1).closest('.ov-group')!
    expect(group.querySelector('.ov-worker-stack .ov-empty-col')).toHaveTextContent('Linked worker outside this view')
  })
  it.each(['outer', 'inner'])('keeps a collapsed %s group closed when opening another relationship', level => {
    const { container } = mount()
    arrange('manager', 'status')
    fireEvent.click(worker(container, 'linked-worker'))
    const a = worker(container, 'linked-worker').closest(level === 'outer' ? '.ov-outer' : '.ov-group')!
    const toggle = a.querySelector<HTMLButtonElement>(':scope > header > button')!
    fireEvent.click(toggle)
    closed(toggle)
    fireEvent.click(task(container, 2))
    closed(toggle)
    open(task(container, 2))
    fireEvent.click(toggle)
    open(worker(container, 'linked-worker')); open(task(container, 1)); open(task(container, 6))
  })
  it('reopens a collapsed counterpart group without closing other relationships', () => {
    const { container } = mount()
    arrange('machine')
    fireEvent.click(screen.getByRole('button', { name: /^Collapse hulk$/i }))
    expect(worker(container, 'linked-worker')).toBeUndefined()
    fireEvent.click(task(container, 1))
    open(worker(container, 'linked-worker'))
    expect(screen.getByRole('button', { name: /^Collapse hulk$/i })).toHaveAttribute('aria-expanded', 'true')
  })
  it('retains expansion through sorting, organization, status changes and independent group collapse', () => {
    const { container } = mount()
    fireEvent.click(worker(container, 'linked-worker'))
    arrange('manager', 'status')
    fireEvent.click(screen.getByRole('button', { name: 'Reverse sort direction' }))
    fireEvent.change(screen.getByLabelText('Status preset'), { target: { value: 'all' } })
    open(task(container, 1)); open(task(container, 6))
    fireEvent.click(screen.getByRole('button', { name: /^Collapse hulk$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Expand hulk$/i }))
    open(task(container, 6))
  })
  it('persists either density across remount and preserves rich Detailed selection', () => {
    const first = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Detailed' }))
    expect(localStorage.getItem(overviewDensityKey)).toBe('detailed')
    fireEvent.click(within(worker(first.container, 'linked-worker').parentElement!).getByRole('button', { name: 'Open in Inspector' }))
    expect(screen.getByLabelText('Inspector')).toBeTruthy()
    first.unmount()
    const second = mount()
    expect(second.container.querySelector('.ov')).toHaveAttribute('data-density', 'detailed')
    fireEvent.click(screen.getByRole('button', { name: 'Ultra Compact' }))
    second.unmount()
    const third = mount()
    expect(third.container.querySelector('.ov')).toHaveAttribute('data-density', 'compact')
  })
  it('expands with Enter and Space while retaining the focused control', () => {
    const { container } = mount()
    const w = worker(container, 'linked-worker')
    w.focus()
    fireEvent.keyDown(w, { key: 'Enter' })
    open(w); open(task(container, 6)); expect(w).toHaveFocus()
    fireEvent.keyDown(w, { key: ' ' })
    closed(w); expect(w).toHaveFocus()
  })
  it('keeps partial coverage honest on compact rows', () => {
    scene.coverage.homes[0]!.observation.coverage = 'partial'
    const { container } = mount()
    expect(task(container, 2).textContent).toContain('Unknown worker')
    expect(screen.getByRole('button', { name: 'Coverage incomplete · Details' })).toBeTruthy()
    expect(container.textContent).not.toContain('No linked worker')
  })
  it('connects only current explicit confirmed links and does not expand unverified candidates', () => {
    const w = scene.executions.find(w => w.identity.task_id === 'candidate-worker')!
    const c = scene.claims[0]!
    scene.claims.push({ ...c, id: 'unverified', executionId: w.id, cardId: fixtureId(3), verification: 'unverified' as typeof c.verification })
    const { container } = mount()
    fireEvent.click(worker(container, 'candidate-worker'))
    closed(task(container, 3))
    expect([...container.querySelectorAll<SVGPathElement>('path')].find(el => el.dataset.workerId === w.id)).toBeUndefined()
    expect(expandedRelationships(scene, [{ kind: 'execution', id: w.id }])).toEqual(new Set([`execution:${w.id}`]))
  })
  it('uses actual endpoint geometry and reanchors on expansion, resize and scroll', () => {
    localStorage.setItem(preferencesKey, JSON.stringify({ organizer: { outer: 'none', inner: 'none', order: 'checkIn', direction: 'asc' } }))
    let shift = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isWorker = this.classList.contains('ov-execution'), isCard = this.classList.contains('ov-card')
      const height = this.getAttribute('aria-expanded') === 'true' ? 133 : 29
      const left = isCard ? 456 : 0, top = isWorker || isCard ? 40 + shift : 0
      return { x: left, y: top, left, top, width: 400, height, right: left + 400, bottom: top + height, toJSON() {} }
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { container } = mount()
    const edge = () => [...container.querySelectorAll<SVGPathElement>('path')].find(el => el.dataset.workerId === scene.claims.find(c => c.cardId === fixtureId(1))!.executionId && el.dataset.cardId === fixtureId(1))!
    expect(edge()).toHaveAttribute('d', 'M400,54.5 C430.8,54.5 425.2,54.5 456,54.5')
    fireEvent.click(worker(container, 'linked-worker'))
    expect(edge()).toHaveAttribute('d', 'M400,106.5 C430.8,106.5 425.2,106.5 456,106.5')
    shift = 20
    act(() => resizeCallbacks.forEach(callback => callback()))
    expect(edge().getAttribute('d')).toContain('M400,126.5')
    shift = 30
    fireEvent.scroll(window)
    expect(edge().getAttribute('d')).toContain('M400,136.5')
    shift = 40
    fireEvent.resize(window)
    expect(edge().getAttribute('d')).toContain('M400,146.5')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fixtureId, fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { Overview } from '../../../test-fixtures/reconciliation/Overview'
import { preferencesKey } from '../presentationPreferences'
import type { FloorScene, PresentationAction } from '../presentation'
import * as health from '../../shared/workHealth'
import { useWorkspaceHistory } from '../../ask/workspaceHistory'
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
  it('moves unknown and unverified link information into Source health while keeping conflicts explicit', () => {
    scene.coverage.absenceConclusions = 'suppressed'
    scene.coverage.homes[0]!.observation.coverage = 'partial'
    scene.claims.find(link => link.cardId === fixtureId(3))!.verification = 'conflicting'
    const { container } = mount()
    for (const card of container.querySelectorAll('.ov-card')) expect(card.textContent).not.toMatch(/Unknown worker|Link unverified/)
    expect(container.querySelectorAll('[data-tone="gap"], [data-tone="orphan"]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Coverage incomplete · Details' }))
    const health = screen.getByRole('region', { name: 'Source health' })
    expect(health).toHaveTextContent('cards with unknown workers')
    expect(health).toHaveTextContent('Incomplete coverage does not establish missing workers or work exceptions.')
    expect(health).toHaveTextContent('1 card has conflicting worker evidence. First Mate investigation is still required')
  })

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

  it('ranks fuzzy names and filters to a verified one-hop cluster with secondary counterparts', () => {
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
    expect(container.querySelectorAll('.ov-execution.ov-search-context')).toHaveLength(2)
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(6)}"]`)).toBeNull()
    expect(cardIds(container)).toEqual([fixtureId(1)])
    expect(cardIds(container)).not.toEqual(before)
    expect(screen.queryByRole('region', { name: 'Inspector' })).toBeNull()
  })

  it('focuses a named machine and only its canonical workers and verified linked work', () => {
    const { container } = mount()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    search('Hulk')
    const machine = within(screen.getByRole('listbox', { name: 'Search results' })).getByRole('option', { name: /^Hulk.*Machine/ })
    fireEvent.click(machine)
    expect(container.querySelectorAll('.ov-execution.ov-search-match')).toHaveLength(4)
    expect(container.querySelectorAll('.ov-card.ov-search-context')).toHaveLength(2)
    expect(container.querySelectorAll('.ov-execution.ov-search-context')).toHaveLength(0)
    expect(container.querySelectorAll('.ov-execution')).toHaveLength(4)
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

  it('filters to a result outside active scope and restores all prior view settings', () => {
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
    expect(cardIds(container)).toEqual([fixtureId(5)])
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(4)}"]`)).toBeNull()
    viewport.scrollLeft = 0
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    expect(cardIds(container)).toEqual([fixtureId(4)])
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(4)}"]`)).toHaveClass('selected')
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeTruthy()
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
    expect(container.querySelectorAll('.ov-search-match')).toHaveLength(1)
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

  it('replaces successive mobile focus without orphaning history or leaving Overview', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    window.history.replaceState({ page: 'Overview' }, '', window.location.href)
    const go = vi.spyOn(window.history, 'go')
    const { container } = mount(), before = cardIds(container)
    const saved = JSON.parse(localStorage.getItem(preferencesKey)!)
    const viewport = container.querySelector('.ov-canvas')!.parentElement!
    viewport.scrollLeft = 21
    const nextPop = () => new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    const choose = (query: string) => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
      search(query)
      fireEvent.keyDown(input(), { key: 'Enter' })
    }
    choose('Release')
    const replacement = nextPop()
    choose('Roadmap: planned integration')
    await act(async () => { await replacement })
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(5)}"]`)).toHaveClass('ov-search-match')
    const back = nextPop()
    await act(async () => { window.history.back(); await back })
    expect(container.querySelectorAll('.ov-search-match')).toHaveLength(0)
    expect(window.history.state).toEqual({ page: 'Overview' })
    expect(cardIds(container)).toEqual(before)
    expect(JSON.parse(localStorage.getItem(preferencesKey)!)).toEqual(saved)
    expect(viewport.scrollLeft).toBe(21)
    choose('Release')
    const clear = nextPop()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    await act(async () => { await clear })
    expect(window.history.state).toEqual({ page: 'Overview' })
    expect(screen.getByRole('region', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
    expect(cardIds(container)).toEqual(before)
    expect(go.mock.calls).toEqual([[-1], [-1]])
  })

  it('keeps focus on Back from the reopened palette with production workspace history', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    window.history.replaceState(null, '', window.location.href)
    function Workspace() {
      const views = useWorkspaceHistory('overview')
      return <Overview views={views} workers={[]} messages={[]} submit={vi.fn()} />
    }
    const { container } = render(<Workspace />)
    const back = async () => {
      const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
      await act(async () => { window.history.back(); await popped })
    }
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    search('Release'); fireEvent.keyDown(input(), { key: 'Enter' })
    expect(container.querySelectorAll('.ov-card.ov-search-match')).toHaveLength(1)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await back()
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
    expect(container.querySelectorAll('.ov-card.ov-search-match')).toHaveLength(1)
    await back()
    expect(container.querySelectorAll('.ov-card.ov-search-match')).toHaveLength(0)
  })

  it('restores Detailed collapsed state and density, and handles mobile Back in two levels', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    window.history.replaceState(null, '', window.location.href)
    const back = async () => {
      const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
      await act(async () => { window.history.back(); await popped })
    }
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.click(screen.getByRole('button', { name: /^Detailed$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    const selector = `.ov-card[data-entity-id="${fixtureId(1)}"]`
    fireEvent.click(container.querySelector(selector)!)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true }); search('Release'); fireEvent.keyDown(input(), { key: 'Enter' })
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await back()
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'true')
    await back()
    expect(container.querySelector(selector)).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.ov')).toHaveAttribute('data-density', 'detailed')
  })
})


describe('shared dial filtering contract', () => {
  const patterns = health.patterns
  // Exercise the consumer with all three evaluator outcomes, including future
  // evidence-backed matches for patterns whose current adapters report unknown.
  function outcomes(pattern: health.Pattern, matched: boolean) {
    const records = health.sceneWorkHealth(scene, Date.now()).map(record => ({ ...record, patterns: { ...record.patterns,
      [pattern]: { outcome: matched && record.cardId === fixtureId(1) ? 'match' : matched && record.cardId === fixtureId(2) ? 'unavailable' : 'no-match',
        reason: 'Worker last reported 3d ago', evidence: ['Worker last reported 3d ago'] } as health.PatternResult,
    } }))
    vi.spyOn(health, 'sceneWorkHealth').mockReturnValue(records)
  }
  it.each(patterns)('%s hides non-matches, retains one-hop counterparts as secondary, and summarizes unknown evidence once', pattern => {
    const claim = scene.claims.find(link => link.cardId === fixtureId(1))!
    scene.claims.push({ ...claim, id: 'second-hop', cardId: fixtureId(6) })
    outcomes(pattern, true)
    const { container } = mount()
    act(() => { observed.send!({ type: 'set-pattern', pattern }) })
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(1)}"]`)).toHaveClass('ov-search-match')
    const counterpart = [...container.querySelectorAll<HTMLElement>('.ov-execution')].find(element => element.dataset.entityId === claim.executionId)!
    expect(counterpart).toHaveClass('ov-search-context')
    expect(counterpart).not.toHaveClass('ov-search-match')
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(6)}"]`)).toBeNull()
    const untracked = scene.executions.find(worker => worker.identity.task_id === 'untracked-worker')!
    expect([...container.querySelectorAll<HTMLElement>('[data-entity-id]')].find(element => element.dataset.entityId === untracked.id) ?? null).toBeNull()
    const unknown = container.querySelector(`.ov-card[data-entity-id="${fixtureId(2)}"]`)!
    expect(unknown).toHaveTextContent('No worker')
    expect(container).not.toHaveTextContent("Can't tell")
    expect(container.querySelector('.ov-pattern-summary')).toBeNull()
    expect(within(container.querySelector('.ov-pattern-selected') as HTMLElement).getByText('1 not evaluated')).toBeVisible()
    fireEvent.click(counterpart)
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(6)}"]`)).toBeNull()
  })
  it.each(patterns)('%s shows its explicit empty state when every result is no-match', pattern => {
    outcomes(pattern, false)
    const { container } = mount()
    act(() => { observed.send!({ type: 'set-pattern', pattern }) })
    expect(container.querySelectorAll('.ov-item')).toHaveLength(0)
    expect(screen.getByText(health.patternEmptyText[pattern])).toBeVisible()
    expect(container.querySelector('.ov-pattern-summary')).toBeNull()
  })
  it('replaces an earlier search focus when choosing a dial pattern', () => {
    scene.cards.find(card => card.id === fixtureId(1))!.source.properties.Status!.value = 'Done'
    const { container } = mount()
    act(() => { observed.send!({ type: 'reveal-search', target: { kind: 'card', id: fixtureId(1) } }) })
    act(() => { observed.send!({ type: 'set-pattern', pattern: 'blocked' }) })
    expect(cardIds(container)).toEqual([fixtureId(4)])
    expect(container.querySelectorAll('.ov-search-context')).toHaveLength(1)
  })
})


describe('worker search roots under dial patterns', () => {
  it.each(health.dialPatterns.filter(pattern => pattern !== 'all'))('%s keeps the directly linked cards secondary to a matching worker', pattern => {
    const records = health.sceneWorkHealth(scene, Date.now()).map(record => ({ ...record, patterns: { ...record.patterns,
      [pattern]: { outcome: record.cardId === fixtureId(1) ? 'match' : 'no-match', reason: 'Test evidence', evidence: ['Test evidence'] } as health.PatternResult,
    } }))
    vi.spyOn(health, 'sceneWorkHealth').mockReturnValue(records)
    const { container } = mount()
    act(() => { observed.send!({ type: 'set-search', search: { query: 'linked-worker', patterns: [pattern], facets: [] } }) })
    expect(container.querySelectorAll('.ov-execution.ov-search-match')).toHaveLength(1)
    expect(container.querySelector(`.ov-card[data-entity-id="${fixtureId(1)}"]`)).toHaveClass('ov-search-context')
    expect(container.querySelectorAll('.ov-card')).toHaveLength(1)
    expect(container.querySelectorAll('.ov-execution')).toHaveLength(1)
  })
})


describe('All clears temporary search focus', () => {
  it.each(['current', 'stale'] as const)('restores the normal floor without gray cards after %s focus', freshness => {
    const { container } = mount(), before = cardIds(container)
    act(() => { observed.send!({ type: 'reveal-search', target: { kind: 'card', id: fixtureId(1) } }) })
    expect(cardIds(container)).toEqual([fixtureId(1)])
    if (freshness === 'stale') {
      observed.scene = { ...scene, cards: scene.cards.filter(card => card.id !== fixtureId(1)), claims: scene.claims.filter(claim => claim.cardId !== fixtureId(1)) }
    }
    act(() => { observed.send!({ type: 'set-pattern', pattern: null }) })
    expect(container.querySelector('.ov-pattern-selected')).toHaveTextContent('All')
    expect(cardIds(container).sort()).toEqual((freshness === 'stale' ? before.filter(id => id !== fixtureId(1)) : before).sort())
    expect(container.querySelectorAll('.ov-search-context, .ov-search-match')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
  })
})


it('choosing All exits the palette focus session without Escape restoring the previous pattern', () => {
  const { container } = mount()
  act(() => { observed.send!({ type: 'set-pattern', pattern: 'active' }) })
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  search('Release Coordinator')
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(cardIds(container)).toEqual([fixtureId(1)])
  fireEvent.click(screen.getByRole('button', { name: /^Select All,/ }))
  const all = cardIds(container)
  expect(all.length).toBeGreaterThan(1)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(container.querySelector('.ov-pattern-selected')).toHaveTextContent('All')
  expect(cardIds(container)).toEqual(all)
  expect(container.querySelectorAll('.ov-search-context, .ov-search-match')).toHaveLength(0)
})


describe('worker facts in existing card metadata', () => {
  it.each(['compact', 'detailed'] as const)('renders concrete facts without an extra card row in %s', density => {
    const finished = scene.executions.find(worker => worker.identity.task_id === 'helper-worker')!
    finished.source.last_event.state = 'done'
    finished.source.current_state.state = 'done'
    finished.liveness = 'finished'
    const claim = scene.claims.find(link => link.cardId === fixtureId(1))!
    scene.claims.push({ ...claim, id: 'declared-absent', executionId: 'not-observed', verification: 'unverified', state: 'last-known' })
    const worker = scene.executions.find(worker => worker.id === claim.executionId)!
    worker.source.harness = 'codex'
    worker.source.current_state.state = 'unknown'
    const { container } = mount()
    if (density === 'detailed') {
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
      fireEvent.click(screen.getByRole('button', { name: /^Detailed$/ }))
    }
    const card = container.querySelector<HTMLElement>(`.ov-card[data-entity-id="${fixtureId(1)}"]`)!
    expect(within(card).getByText(/1 worker, no update since/)).toHaveClass('ov-link-label')
    expect(card).not.toHaveTextContent(/codex pane|state unknown/i)
    const shownWorkers = [...container.querySelectorAll<HTMLElement>('.ov-execution')]
    const shown = shownWorkers.find(element => element.dataset.entityId === worker.id)!
    expect(shown).toHaveTextContent(/No update since/)
    expect(shownWorkers.some(element => element.dataset.entityId === finished.id)).toBe(false)
    expect(container.querySelector('.ov-pattern-summary')).toBeNull()
    expect(card).not.toHaveTextContent("Can't tell")
  })
})


describe('pattern coverage drilldown', () => {
  it('uses the existing floor focus to inspect exactly unknown cards and restores the selected pattern', () => {
    const records = health.sceneWorkHealth(scene, Date.now()).map(record => ({ ...record, patterns: { ...record.patterns,
      decision: { outcome: record.cardId === fixtureId(1) ? 'match' : record.cardId === fixtureId(2) || record.cardId === fixtureId(3) ? 'unavailable' : 'no-match',
        reason: 'Worker decision requests or assignment coverage are incomplete', evidence: ['Exact source evidence'] } as health.PatternResult,
    } }))
    vi.spyOn(health, 'sceneWorkHealth').mockReturnValue(records)
    const before = JSON.stringify(scene)
    const { container } = mount()
    expect(screen.queryByText(/Pattern unknown:/)).toBeNull()
    act(() => { observed.send!({ type: 'set-pattern', pattern: 'decision' }) })
    const original = [...new Set(cardIds(container))].sort()
    expect(within(container.querySelector('.ov-pattern-selected') as HTMLElement).getByText('2 not evaluated')).toBeVisible()
    fireEvent.click(container.querySelector('.ov-pattern-selected')!)
    const detail = screen.getByRole('dialog', { name: 'Needs me pattern coverage' })
    expect(detail).toHaveTextContent('1 confirmed needs me · 2 not evaluated')
    expect(detail).toHaveTextContent('Worker or assignment evidence is missing')
    const inspect = within(detail).getByRole('button', { name: 'Show 2 cards' })
    expect(inspect).toHaveFocus()
    expect(fireEvent.keyDown(inspect, { key: 'Enter' })).toBe(true)
    expect(screen.queryByRole('listbox', { name: 'Operational patterns' })).toBeNull()
    fireEvent.click(inspect)
    expect([...new Set(cardIds(container))].sort()).toEqual([fixtureId(2), fixtureId(3)])
    expect(container.querySelector('.ov-pattern-selected')).toHaveTextContent('Needs me')
    expect(container.querySelectorAll('.ov-card.ov-collapsed').length).toBeGreaterThan(0)
    const card = container.querySelector(`.ov-card[data-entity-id="${fixtureId(2)}"]`)!
    fireEvent.click(within(card.closest<HTMLElement>('.ov-item-frame')!).getByRole('button', { name: 'Open in Inspector' }))
    expect(screen.getByRole('region', { name: 'Inspector' })).toHaveTextContent('Selected pattern: unable to evaluate')
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    expect([...new Set(cardIds(container))].sort()).toEqual(original)
    act(() => { observed.send!({ type: 'set-pattern', pattern: 'blocked' }) })
    expect(screen.queryByText(/Pattern unknown:/)).toBeNull()
    act(() => { observed.send!({ type: 'set-pattern', pattern: null }) })
    expect(screen.queryByText(/Pattern unknown:/)).toBeNull()
    expect(JSON.stringify(scene)).toBe(before)
  })
  it.each([false, true])('scopes coverage and drilldown to roadmap visibility (%s)', expanded => {
    const planned = scene.cards.find(card => card.id === fixtureId(2))!
    planned.source.properties.Status!.value = 'Queued'
    planned.expectation = 'wait-planned'
    const { container } = mount()
    act(() => { observed.send!({ type: 'set-roadmap', expanded }) })
    act(() => { observed.send!({ type: 'set-pattern', pattern: 'stale' }) })
    const visible = [...new Set(cardIds(container))].sort()
    expect(visible.includes(planned.id)).toBe(expanded)
    expect(within(container.querySelector('.ov-pattern-selected') as HTMLElement).getByText(`${visible.length} not evaluated`)).toBeVisible()
    fireEvent.click(container.querySelector('.ov-pattern-selected')!)
    const detail = screen.getByRole('dialog', { name: 'Stale pattern coverage' })
    expect(detail).toHaveTextContent(`0 confirmed stale · ${visible.length} not evaluated`)
    fireEvent.click(within(detail).getByRole('button', { name: /Show .* cards/ }))
    expect([...new Set(cardIds(container))].sort()).toEqual(visible)
  })
  it('describes every predicate in a combined pattern selection', () => {
    const { container } = mount()
    act(() => { observed.send!({ type: 'set-status-filter', filter: { preset: 'custom', statuses: ['Waiting For'] } }) })
    act(() => { observed.send!({ type: 'set-search', search: { query: '', patterns: ['blocked', 'stale'], facets: [] } }) })
    const selected = container.querySelector('.ov-pattern-selected')!
    expect(selected).toHaveTextContent('Blocked + Stale')
    expect(selected).toHaveAccessibleName('Blocked + Stale, 0 confirmed, 1 not evaluated. Show details')
    const description = container.querySelector('#ov-pattern-description')!
    expect(description).toHaveTextContent('Blocked + Stale: Work that meets every selected pattern.')
    fireEvent.click(selected)
    const detail = screen.getByRole('dialog', { name: 'Blocked + Stale pattern coverage' })
    expect(detail).toHaveTextContent('0 confirmed blocked + stale · 1 not evaluated')
    expect(detail).toHaveTextContent('Progress timing is missing')
    expect(within(detail).getByRole('button', { name: 'Show 1 cards' })).toBeVisible()
  })
  it('counts only unique cards remaining under status scope', () => {
    const { container } = mount()
    act(() => { observed.send!({ type: 'set-status-filter', filter: { preset: 'custom', statuses: ['Waiting For'] } }) })
    act(() => { observed.send!({ type: 'set-pattern', pattern: 'stale' }) })
    expect([...new Set(cardIds(container))]).toEqual([fixtureId(4)])
    expect(within(container.querySelector('.ov-pattern-selected') as HTMLElement).getByText('1 not evaluated')).toBeVisible()
    fireEvent.click(container.querySelector('.ov-pattern-selected')!)
    expect(screen.getByRole('dialog', { name: 'Stale pattern coverage' })).toHaveTextContent('0 confirmed stale · 1 not evaluated')
  })
})

describe('initiative selection applies the canonical filter', () => {
  const preferences = () => JSON.parse(localStorage.getItem(preferencesKey)!)
  const shelf = () => screen.getByRole('complementary', { name: 'Applied filters' })
  const chooseInitiative = () => {
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    search('tin')
    fireEvent.click(screen.getByRole('option', { name: /^Tin Star\. Initiative/ }))
  }
  beforeEach(() => {
    for (const id of [1, 4]) scene.cards.find(card => card.id === fixtureId(id))!.source.properties.Initiative = { id: 'initiative', type: 'select', value: 'Tin Star', hasMore: false }
    scene.cards.find(card => card.id === fixtureId(2))!.source.properties.Status!.value = 'Waiting For'
    scene.cards.find(card => card.id === fixtureId(2))!.source.properties.Name!.value = 'Tin unrelated task'
  })

  it('intersects Waiting For, persists across organizers/reload, and removes each token independently', () => {
    let view = mount()
    fireEvent.click(screen.getByRole('button', { name: /^Filter Cards: Waiting For,/ }))
    expect(new Set(cardIds(view.container))).toEqual(new Set([fixtureId(2), fixtureId(4)]))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true }); search('tin')
    expect(shelf()).toHaveTextContent('Active filters 1')
    expect(preferences().search?.facets ?? []).toEqual([])
    fireEvent.click(screen.getByRole('option', { name: /^Tin Star\. Initiative/ }))
    expect(shelf()).toHaveTextContent('Active filters 2')
    expect(preferences().search).toEqual({ query: '', patterns: [], facets: [{ field: 'initiative', value: 'Tin Star' }] })
    expect(cardIds(view.container)).toEqual([fixtureId(4)])
    // Waiting For keeps its independent worker column; the initiative facet
    // must still exclude workers outside this initiative.
    const linkedWorkers = scene.claims.filter(claim => [fixtureId(1), fixtureId(4)].includes(claim.cardId) && claim.verification === 'confirmed').map(claim => claim.executionId)
    expect(new Set([...view.container.querySelectorAll<HTMLElement>('.ov-execution')].map(worker => worker.dataset.entityId))).toEqual(new Set(linkedWorkers))
    for (const name of ['By Machine', 'By Manager', 'By Initiative']) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(screen.getByRole('button', { name: 'Remove Initiative: Tin Star' })).toBeTruthy()
      expect(new Set(cardIds(view.container))).toEqual(new Set([fixtureId(4)]))
    }
    view.unmount(); view = mount()
    expect(shelf()).toHaveTextContent('Active filters 2')
    expect(cardIds(view.container)).toEqual([fixtureId(4)])
    fireEvent.click(screen.getByRole('button', { name: /^Filter Cards: In Progress,/ }))
    expect(new Set(cardIds(view.container))).toEqual(new Set([fixtureId(1), fixtureId(4)]))
    expect(shelf()).toHaveTextContent('Active filters 3')
    fireEvent.click(screen.getByRole('button', { name: /^Filter Cards: In Progress,/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Initiative: Tin Star' }))
    expect(new Set(cardIds(view.container))).toEqual(new Set([fixtureId(2), fixtureId(4)]))
    expect(screen.getByRole('button', { name: 'Remove Cards: Waiting For' })).toBeTruthy()
    chooseInitiative()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cards: Waiting For' }))
    expect(new Set(cardIds(view.container))).toEqual(new Set([fixtureId(1), fixtureId(4)]))
    expect(shelf()).toHaveTextContent('Active filters 1')
    const organizer = preferences().organizer
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(shelf()).toHaveTextContent('Active filters 0')
    expect(preferences().organizer).toEqual(organizer)
    expect(cardIds(view.container)).toContain(fixtureId(2))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(preferences().search.facets).toEqual([])
  })

  it.each(['Escape', 'Restore previous view'])('restores the temporary view with %s while retaining the selected initiative', exit => {
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: /^Filter Cards: Waiting For,/ }))
    chooseInitiative()
    const saved = preferences(), before = cardIds(container)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    search('Release Coordinator')
    expect(screen.getByRole('option', { name: /Release Coordinator.*Outside current view/ })).toBeTruthy()
    fireEvent.keyDown(input(), { key: 'ArrowDown' }); fireEvent.keyDown(input(), { key: 'Enter' })
    expect(cardIds(container)).toEqual([fixtureId(1)])
    expect(preferences().search.facets).toEqual([{ field: 'initiative', value: 'Tin Star' }])
    if (exit === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    expect(preferences()).toEqual(saved)
    expect(cardIds(container)).toEqual(before)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Initiative: Tin Star' }))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true }); search('Tin unrelated task')
    fireEvent.click(screen.getByRole('option', { name: /Tin unrelated task/ }))
    expect(preferences().search?.facets ?? []).toEqual([])
  })

  it.each([true, false])('keeps explicit Gaps-only edits after initiative selection from %s', initiallyEnabled => {
    const { container } = mount()
    act(() => observed.send!({ type: 'set-exceptions', enabled: initiallyEnabled }))
    chooseInitiative()
    expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeTruthy()
    if (initiallyEnabled) fireEvent.click(screen.getByRole('button', { name: 'Remove View: Gaps only' }))
    else act(() => observed.send!({ type: 'set-exceptions', enabled: true }))
    expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
    const before = cardIds(container)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(!!screen.queryByRole('button', { name: 'Remove View: Gaps only' })).toBe(!initiallyEnabled)
    expect(screen.getByRole('button', { name: 'Remove Initiative: Tin Star' })).toBeTruthy()
    expect(cardIds(container)).toEqual(before)
  })

  it.each(['compact', 'detailed'])('reveals through Gaps only without changing the filter in %s view', density => {
    const { container } = mount()
    if (density === 'detailed') {
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
      fireEvent.click(screen.getByRole('button', { name: /^Detailed$/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    }
    act(() => observed.send!({ type: 'set-exceptions', enabled: true }))
    const before = cardIds(container)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true }); search('Release Coordinator')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(cardIds(container)).toContain(fixtureId(1))
    expect(screen.getByRole('button', { name: 'Remove View: Gaps only' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    expect(screen.getByRole('button', { name: 'Remove View: Gaps only' })).toBeTruthy()
    expect(cardIds(container)).toEqual(before)
  })

  it('uses the relation identity with its display name, matching semantic set-search and Customize', () => {
    const parent = scene.cards.find(card => card.id === fixtureId(100))!
    parent.source.properties.Name!.value = 'Tin Star'
    for (const id of [1, 4]) scene.cards.find(card => card.id === fixtureId(id))!.source.properties.Initiative = { id: 'initiative', type: 'relation', value: [parent.id], hasMore: false }
    const { container } = mount()
    chooseInitiative()
    expect(preferences().search.facets).toEqual([{ field: 'initiative', value: parent.id }])
    expect(screen.getByRole('button', { name: 'Remove Initiative: Tin Star' })).toBeTruthy()
    const selected = cardIds(container)
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    act(() => { observed.send!(actionSchema.parse({ type: 'set-search', search: { query: '', patterns: [], facets: [{ field: 'initiative', value: parent.id }] } })) })
    expect(cardIds(container)).toEqual(selected)
    expect(screen.getByRole('button', { name: 'Remove Initiative: Tin Star' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.change(screen.getByLabelText('Status preset'), { target: { value: 'all' } })
    expect(preferences().search.facets).toEqual([{ field: 'initiative', value: parent.id }])
    expect(screen.getByRole('button', { name: 'Remove Initiative: Tin Star' })).toBeTruthy()
  })
})

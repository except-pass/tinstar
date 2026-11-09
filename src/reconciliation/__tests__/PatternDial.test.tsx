import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureId, fixtureReadinessScene, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { PatternDial, patternPreviews } from '../PatternDial'
import { applyPresentationAction, initialPresentation, type PresentationState } from '../presentation'
import { emptySearch } from '../../shared/smartSearch'
import { stalledOutcome, workHealth } from '../../shared/workHealth'
const now = Date.parse('2026-11-06T18:00:00Z')
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
function mount(saved = initialPresentation()) {
  const scene = fixtureScene({ now })
  return render(<Harness />)
  function Harness() {
    const [state, setState] = useState(saved)
    return <><PatternDial scene={scene} state={state} now={now} send={action => setState(current => applyPresentationAction(current, action, scene, now).state)} /><output data-testid="view">{JSON.stringify(state)}</output><button>Outside</button></>
  }
}
const selected = () => document.querySelector<HTMLButtonElement>('.ov-pattern-selected')!
const state = () => JSON.parse(screen.getByTestId('view').textContent!) as PresentationState

describe('Pattern Dial', () => {
  it('steps circularly with one click or arrow, and All removes only the pattern', () => {
    const saved = { ...initialPresentation(), donutFilter: { cards: ['In Progress'], workers: ['Running'] }, search: { query: 'release', facets: [{ field: 'machine' as const, value: 'Hulk' }], patterns: ['stalled' as const] } }
    mount(saved)
    expect(selected()).toHaveTextContent('Stalled')
    fireEvent.click(screen.getByRole('button', { name: /^Select Blocked/ }))
    expect(state().search?.patterns).toEqual(['blocked'])
    fireEvent.keyDown(selected(), { key: 'ArrowLeft' })
    fireEvent.click(screen.getByRole('button', { name: /^Select All,/ }))
    expect(state().search).toEqual({ ...saved.search, patterns: [] })
    expect(state().organizer).toEqual(saved.organizer)
    expect(state().donutFilter).toEqual(saved.donutFilter)
    expect(state().statusFilter).toEqual(saved.statusFilter)
    fireEvent.keyDown(selected(), { key: 'ArrowLeft' })
    expect(selected()).toHaveTextContent('Active')
    fireEvent.keyDown(selected(), { key: 'ArrowRight' })
    expect(selected()).toHaveTextContent('All')
  })
  it('coalesces a horizontal wheel burst and lets ordinary vertical scrolling through', () => {
    vi.useFakeTimers(); let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time); mount()
    const dial = screen.getByRole('group', { name: 'Operational pattern dial' })
    expect(fireEvent.wheel(dial, { deltaX: 0, deltaY: 80 })).toBe(true)
    expect(selected()).toHaveTextContent('All')
    expect(fireEvent.wheel(dial, { deltaX: 40, deltaY: 1 })).toBe(false)
    for (let i = 0; i < 8; i++) { time += 30; fireEvent.wheel(dial, { deltaX: 25, deltaY: 0 }) }
    expect(selected()).toHaveTextContent('Stalled')
    time += 250; fireEvent.wheel(dial, { deltaX: 30, deltaY: 0 })
    expect(selected()).toHaveTextContent('Blocked')
  })
  it('handles horizontal touch swipes once and does not turn vertical gestures into filters', () => {
    mount()
    const dial = screen.getByRole('group', { name: 'Operational pattern dial' })
    const pointer = (type: string, x: number, y: number) => fireEvent(dial, Object.assign(new Event(type, { bubbles: true }), { pointerType: 'touch', clientX: x, clientY: y }))
    pointer('pointerdown', 150, 10); pointer('pointerup', 145, 90)
    expect(selected()).toHaveTextContent('All')
    pointer('pointerdown', 150, 10); pointer('pointerup', 70, 15)
    expect(selected()).toHaveTextContent('Stalled')
    fireEvent.click(selected()) // Synthetic click after a swipe is consumed.
    expect(screen.queryByRole('tooltip')).toBeNull()
    pointer('pointerdown', 70, 10); pointer('pointerup', 150, 15)
    expect(selected()).toHaveTextContent('All')
  })
  it('delays hover/focus reminders, pins by tap, and dismisses without clearing the filter', () => {
    vi.useFakeTimers(); mount({ ...initialPresentation(), search: { ...emptySearch(), patterns: ['blocked'] } })
    fireEvent.mouseEnter(selected())
    act(() => vi.advanceTimersByTime(399)); expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => vi.advanceTimersByTime(1)); expect(screen.getByRole('tooltip')).toHaveTextContent('blocked can be healthy')
    expect(selected()).toHaveAttribute('aria-describedby', 'ov-pattern-description')
    fireEvent.click(selected()); fireEvent.mouseLeave(selected())
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.keyDown(selected(), { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(state().search?.patterns).toEqual(['blocked'])
    fireEvent.focus(selected()); act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.click(selected()); fireEvent.click(selected())
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(selected()); fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('source-truthful aggregate previews', () => {
  it('counts unique work across duplicate links, multiple workers and group references while ignoring its own detent', () => {
    const scene = fixtureScene({ now }), linked = scene.claims.find(link => link.cardId === fixtureId(1))!
    scene.claims.push({ ...linked, id: 'duplicate-reference' })
    for (const card of scene.cards) card.source.properties.Initiative = { id: 'initiative', type: 'relation', value: ['one', 'two'], hasMore: false }
    const view = { ...initialPresentation(), search: { ...emptySearch(), patterns: ['blocked' as const] } }
    const previews = patternPreviews(scene, view, now)
    expect(previews.active).toMatchObject({ count: 1, unknown: true })
    expect(previews.blocked).toMatchObject({ count: 1, unknown: false })
    expect(previews.all.count).toBe(5)
    expect(patternPreviews(scene, { ...view, donutFilter: { cards: ['Waiting For'], workers: [] } }, now).active.count).toBe(0)
    expect(patternPreviews(scene, { ...view, donutFilter: { cards: [], workers: ['Running'] } }, now).blocked.count).toBe(0)
    expect(patternPreviews(scene, { ...view, search: { ...view.search, facets: [{ field: 'machine', value: 'Bandit' }] } }, now).all.count).toBe(1)
  })
  it('renders complete counts and names the unavailable evidence class/home in partial tooltips', () => {
    const scene = fixtureReadinessScene({ now }), view = initialPresentation()
    expect(patternPreviews(scene, view, now).active).toMatchObject({ count: 1, unknown: false })
    expect(patternPreviews(scene, view, now).stalled).toMatchObject({ count: 1, unknown: false })
    const partial = fixtureReadinessScene({ now, stale: true })
    expect(patternPreviews(partial, view, now).active).toMatchObject({ count: 1, unknown: true })
    expect(patternPreviews(partial, view, now).stalled).toMatchObject({ count: 0, unknown: true })
    render(<PatternDial scene={partial} state={{ ...view, search: { ...emptySearch(), patterns: ['stalled'] } }} now={now} send={() => {}} />)
    expect(selected()).toHaveAccessibleName(/Stalled, \? matching tasks/)
    fireEvent.click(selected())
    expect(screen.getByRole('tooltip')).toHaveTextContent('Home snapshot stale or unreadable: /fixture/hulk')
    expect(screen.getByRole('tooltip')).toHaveTextContent('Runnable coverage incomplete for /fixture/hulk')
  })
  it('marks absent/partial inputs unknown instead of presenting an invented zero', () => {
    const scene = fixtureScene({ now, unavailable: true })
    expect(patternPreviews(scene, initialPresentation(), now).unstaffed).toMatchObject({ count: 0, unknown: true })
    expect(patternPreviews(scene, initialPresentation(), now).stalled).toMatchObject({ count: 0, unknown: true })
    scene.coverage.intentions.coverage = 'partial'
    expect(patternPreviews(scene, initialPresentation(), now).all.unknown).toBe(true)
    scene.cards = []; scene.executions = []; scene.claims = []
    expect(patternPreviews(scene, initialPresentation(), now).blocked).toMatchObject({ count: 0, unknown: true })
    const missing = fixtureScene({ now }); missing.executions = []
    expect(workHealth(missing, fixtureId(1), now).patterns.unstaffed.outcome).toBe('unavailable')
  })
  it('classifies known two-waiter aggregates as one stalled work, excludes running/resolving paths and unknown coverage', () => {
    const input = { inProgress: true, complete: true, workerCount: 2, running: 0, runnable: 0, activeResolverCount: 0 }
    expect(stalledOutcome(input)).toBe('match')
    expect(stalledOutcome({ ...input, running: 1 })).toBe('no-match')
    expect(stalledOutcome({ ...input, activeResolverCount: 1 })).toBe('no-match')
    expect(stalledOutcome({ ...input, runnable: 1 })).toBe('no-match')
    expect(stalledOutcome({ ...input, complete: false })).toBe('unavailable')
    expect(stalledOutcome({ ...input, activeResolverCount: null })).toBe('unavailable')
    expect(stalledOutcome({ ...input, runnable: null })).toBe('unavailable')
    expect(stalledOutcome({ ...input, workerCount: 0 })).toBe('no-match')
  })
})

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureId, fixturePatternCoverageScene, fixtureReadinessScene, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { PatternDial, patternPreviews } from '../PatternDial'
import { applyPresentationAction, initialPresentation, type PresentationState } from '../presentation'
import { emptySearch } from '../../shared/smartSearch'
import { dialNames, dialPatterns, stalledOutcome, workHealth } from '../../shared/workHealth'
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
  it('keeps keyboard navigation on the listbox and selects its active option', () => {
    mount({ ...initialPresentation(), search: { ...emptySearch(), patterns: ['blocked'] } })
    fireEvent.keyDown(selected(), { key: 'Enter' })
    const list = screen.getByRole('listbox')
    expect(list).toHaveFocus()
    for (const option of screen.getAllByRole('option')) expect(option.tabIndex).toBe(-1)
    for (const [key, pattern] of [
      ['ArrowDown', 'decision'], ['ArrowRight', 'unstaffed'],
      ['ArrowUp', 'decision'], ['ArrowLeft', 'blocked'], ['ArrowUp', 'stalled'],
    ]) {
      fireEvent.keyDown(list, { key })
      expect(list).toHaveFocus()
      expect(list).toHaveAttribute('aria-activedescendant', `ov-pattern-option-${pattern}`)
    }
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(state().search?.patterns).toEqual(['stalled'])
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(selected()).toHaveFocus()
  })
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
  it('steps one pattern per wheel notch in either direction and keeps the page still', () => {
    vi.useFakeTimers(); let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time); mount()
    const dial = screen.getByRole('group', { name: 'Operational pattern dial' })
    const outside = screen.getByRole('button', { name: 'Outside' })
    const turn = (deltaY: number, deltaMode = 0) => { time += 100; return fireEvent.wheel(dial, { deltaX: 0, deltaY, deltaMode }) }
    expect(turn(12)).toBe(false)
    expect(selected()).toHaveTextContent('All')
    expect(turn(100)).toBe(false)
    expect(selected()).toHaveTextContent('Stalled')
    expect(turn(-100)).toBe(false)
    expect(selected()).toHaveTextContent('All')
    expect(turn(-100)).toBe(false)
    expect(selected()).toHaveTextContent('Active')
    expect(turn(3, 1)).toBe(false)
    expect(selected()).toHaveTextContent('All')
    expect(fireEvent.wheel(outside, { deltaX: 0, deltaY: 100, deltaMode: 0 })).toBe(true)
    expect(selected()).toHaveTextContent('All')
  })
  it.each(['deltaX', 'deltaY'] as const)('preserves rapid notches on %s in both directions and every delta mode', axis => {
    vi.useFakeTimers(); let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time); mount()
    const dial = screen.getByRole('group', { name: 'Operational pattern dial' })
    for (const [deltaMode, magnitude] of [[0, 100], [0, 120], [1, 3], [2, 1]] as const) {
      for (const direction of [1, -1]) {
        for (let step = 1; step <= 3; step++) {
          expect(fireEvent.wheel(dial, { [axis]: direction * magnitude * (deltaMode === 0 ? 1 : 4 - step), deltaMode })).toBe(false)
          const index = direction === 1 ? step : 3 - step
          expect(state().search?.patterns ?? []).toEqual(index === 0 ? [] : [dialPatterns[index]])
          time += 50
        }
      }
    }
  })
  it.each(['deltaX', 'deltaY'] as const)('suppresses decaying momentum on %s and resets on silence or reversal', axis => {
    for (const direction of [1, -1]) {
      vi.useFakeTimers(); let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time); mount()
      const dial = screen.getByRole('group', { name: 'Operational pattern dial' })
      const expected = direction === 1 ? 'stalled' : 'active'
      for (const magnitude of [120, 100, 80, 60]) {
        expect(fireEvent.wheel(dial, { [axis]: direction * magnitude, deltaMode: 0 })).toBe(false)
        expect(state().search?.patterns).toEqual([expected])
        time += 16
      }
      time += 200
      expect(fireEvent.wheel(dial, { [axis]: direction * 40, deltaMode: 0 })).toBe(false)
      expect(state().search?.patterns).toEqual([direction === 1 ? 'blocked' : 'stale'])
      time += 16
      expect(fireEvent.wheel(dial, { [axis]: -direction * 40, deltaMode: 0 })).toBe(false)
      expect(state().search?.patterns).toEqual([expected])
      cleanup(); vi.restoreAllMocks()
    }
  })
  it('accumulates small pixel deltas before the first step', () => {
    let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time); mount()
    const dial = screen.getByRole('group', { name: 'Operational pattern dial' })
    for (const magnitude of [12, 28, 20, 10]) {
      expect(fireEvent.wheel(dial, { deltaY: magnitude, deltaMode: 0 })).toBe(false)
      expect(state().search?.patterns ?? []).toEqual(magnitude === 12 ? [] : ['stalled'])
      time += 16
    }
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
    act(() => vi.advanceTimersByTime(1)); expect(screen.getByRole('tooltip')).toHaveTextContent('Blocked: Work waiting for a named dependency.')
    expect(selected()).toHaveAttribute('aria-describedby', 'ov-pattern-description')
    fireEvent.click(selected()); fireEvent.mouseLeave(selected())
    expect(screen.getByRole('dialog')).toBeTruthy()
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

  it('opens every pattern on hold or keyboard without turning a click or a swipe', () => {
    vi.useFakeTimers()
    mount()
    const dial = screen.getByRole('group', { name: 'Operational pattern dial' })
    const point = (type: string, x: number, y: number, target: Element = dial) => fireEvent(target, Object.assign(new Event(type, { bubbles: true }), { pointerType: 'mouse', clientX: x, clientY: y, button: 0 }))
    const stalled = screen.getByRole('button', { name: /^Select Stalled/ })
    point('pointerdown', 10, 10, stalled)
    act(() => vi.advanceTimersByTime(200))
    point('pointerup', 10, 10, stalled)
    fireEvent.click(stalled)
    expect(selected()).toHaveTextContent('Stalled')
    expect(screen.queryByRole('listbox')).toBeNull()

    point('pointerdown', 30, 10)
    point('pointermove', 39, 10)
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByRole('listbox')).toBeNull()
    point('pointerup', 30, 12)
    expect(selected()).toHaveTextContent('Stalled')

    const touch = (type: string, x: number, y: number) => fireEvent(dial, Object.assign(new Event(type, { bubbles: true }), { pointerType: 'touch', clientX: x, clientY: y, button: 0 }))
    touch('pointerdown', 150, 10)
    touch('pointermove', 190, 12)
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByRole('listbox')).toBeNull()
    touch('pointerup', 70, 15)
    expect(selected()).toHaveTextContent('Blocked')
    fireEvent.click(selected())
    expect(screen.queryByRole('tooltip')).toBeNull()

    point('pointerdown', 40, 10, selected())
    act(() => vi.advanceTimersByTime(499))
    expect(screen.queryByRole('listbox')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    const list = screen.getByRole('listbox', { name: 'Operational patterns' })
    expect(list).toHaveAttribute('aria-activedescendant', 'ov-pattern-option-blocked')
    point('pointerup', 40, 10, selected())
    fireEvent.click(selected())
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(selected()).toHaveTextContent('Blocked')
    expect(screen.getAllByRole('option')).toHaveLength(dialPatterns.length)
    const previews = patternPreviews(fixtureScene({ now }), state(), now)
    const texts = dialPatterns.map(pattern => {
      const option = screen.getByRole('option', { name: new RegExp(`^${dialNames[pattern]},`) })
      const text = `${previews[pattern].count}${pattern !== 'all' && previews[pattern].coverage ? ' confirmed' : ''}`
      expect(option.querySelector('small')?.textContent).toBe(text)
      expect(option.getAttribute('title')).toMatch(/^[^:]+: [^.]+\.$/)
      expect(option.textContent).not.toMatch(/\?|\d\+|Pattern unknown/)
      return text
    })
    expect(texts).toContain('0 confirmed')
    expect(screen.getByRole('option', { name: /^Blocked,/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('option', { name: /^Needs me,/ }))
    expect(selected()).toHaveTextContent('Needs me')
    expect(selected()).toHaveFocus()
    expect(state().search?.patterns).toEqual(['decision'])
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.keyDown(selected(), { key: 'Enter' })
    expect(screen.getByRole('option', { name: /^Needs me,/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('listbox')).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(selected()).toHaveTextContent('Unstaffed')
    expect(selected()).toHaveFocus()
    expect(state().search?.patterns).toEqual(['unstaffed'])

    fireEvent.keyDown(screen.getByRole('button', { name: /^Select Mismatch/ }), { key: 'ArrowDown', altKey: true })
    expect(screen.getByRole('listbox')).toHaveFocus()
    expect(selected()).toHaveTextContent('Unstaffed')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowLeft' })
    expect(selected()).toHaveTextContent('Unstaffed')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(selected()).toHaveFocus()
    expect(state().search?.patterns).toEqual(['unstaffed'])
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
  it('renders complete counts and keeps machine evidence out of partial details', () => {
    const scene = fixtureReadinessScene({ now }), view = initialPresentation()
    expect(patternPreviews(scene, view, now).active).toMatchObject({ count: 1, unknown: false })
    expect(patternPreviews(scene, view, now).stalled).toMatchObject({ count: 1, unknown: false })
    const partial = fixtureReadinessScene({ now, stale: true })
    expect(patternPreviews(partial, view, now).active).toMatchObject({ count: 1, unknown: true })
    expect(patternPreviews(partial, view, now).stalled).toMatchObject({ count: 0, unknown: true })
    render(<PatternDial scene={partial} state={{ ...view, search: { ...emptySearch(), patterns: ['stalled'] } }} now={now} send={() => {}} />)
    expect(selected()).toHaveAccessibleName(/Stalled, 0 confirmed, 1 not evaluated/)
    fireEvent.click(selected())
    expect(screen.getByRole('dialog')).toHaveTextContent('Worker or assignment evidence is missing')
    expect(screen.getByRole('dialog')).not.toHaveTextContent('/fixture/hulk')
  })
  it('keeps conclusive visible counts complete despite an unrelated stale home', () => {
    const scene = fixtureReadinessScene({ now, stale: true })
    for (const card of scene.cards) card.source.properties.Status!.value = 'Done'
    const view = initialPresentation(), previews = patternPreviews(scene, view, now)
    for (const pattern of ['active', 'stalled'] as const) {
      expect(previews[pattern]).toEqual({ count: 0, unknown: false, reasons: [], coverage: null })
      const filtered = patternPreviews(scene, { ...view, donutFilter: { cards: [], workers: ['Running'] } }, now)
      expect(filtered[pattern].unknown).toBe(true)
      expect(filtered[pattern].reasons.join(' ')).toContain('Home snapshot stale or unreadable: /fixture/hulk')
    }
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


describe('compact coverage presentation', () => {
  it.each([
    { pattern: 'stalled' as const, confirmed: 0, unavailable: 12, expected: 'Stalled 0 confirmed' },
    { pattern: 'active' as const, confirmed: 8, unavailable: 11, expected: 'Active 8 confirmed' },
  ])('shows $expected and exact unavailable cards on click', ({ pattern, confirmed, unavailable, expected }) => {
    vi.useFakeTimers()
    const scene = fixturePatternCoverageScene({ now, confirmed, unavailable })
    const inspect = vi.fn()
    render(<PatternDial scene={scene} state={{ ...initialPresentation(), search: { ...emptySearch(), patterns: [pattern] } }} now={now} send={() => {}} onInspectCoverage={inspect} />)
    expect(selected()).toHaveTextContent(expected)
    expect(selected()).toHaveTextContent(`${unavailable} not evaluated`)
    expect(document.querySelector('.ov-pattern-dial')).not.toHaveTextContent(/\?|\d\+|Pattern unknown|Can't tell/)
    fireEvent.mouseEnter(selected()); act(() => vi.advanceTimersByTime(400))
    expect(screen.getByRole('tooltip').textContent).toBe(`${pattern === 'stalled' ? 'Stalled: In Progress work with no confirmed way to advance.' : 'Active: In Progress work with a confirmed way to advance.'}`)
    fireEvent.click(selected())
    expect(screen.queryByRole('tooltip')).toBeNull()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(`${confirmed} confirmed ${pattern} · ${unavailable} not evaluated`)
    expect(dialog).toHaveTextContent('Worker or assignment evidence is missing')
    const show = screen.getByRole('button', { name: `Show ${unavailable} cards` })
    expect(show).toHaveFocus(); fireEvent.click(show)
    expect(inspect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('restores exact complete counts when coverage returns, including true zero and neighbors', () => {
    const state = { ...initialPresentation(), search: { ...emptySearch(), patterns: ['stalled' as const] } }
    const { rerender } = render(<PatternDial scene={fixturePatternCoverageScene({ now, confirmed: 0, unavailable: 12 })} state={state} now={now} send={() => {}} />)
    expect(selected()).toHaveTextContent('0 confirmed')
    const complete = fixtureReadinessScene({ now })
    complete.cards.forEach(card => { card.source.properties.Status!.value = 'Done' })
    rerender(<PatternDial scene={complete} state={state} now={now} send={() => {}} />)
    expect(selected().textContent).toBe('Stalled 0')
    expect(document.querySelectorAll('.ov-pattern-coverage')).toHaveLength(0)
    rerender(<PatternDial scene={fixturePatternCoverageScene({ now })} state={{ ...state, search: { ...emptySearch(), patterns: [] } }} now={now} send={() => {}} />)
    expect(selected().textContent).toBe('All 19')
    expect(screen.getByRole('button', { name: /^Select Active/ })).toHaveTextContent('Active 8 confirmed11 not evaluated')
    expect(screen.getByRole('button', { name: /^Select Stalled/ })).toHaveTextContent('Stalled 0 confirmed11 not evaluated')
  })
})

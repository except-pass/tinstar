import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { organizedGroups } from '../../shared/floorOrganization'
import { actionSchema } from '../../shared/reconciliationCommands'
import { applyPresentationAction, initialPresentation, type PresentationAction } from '../presentation'
import { emptySearch } from '../../shared/smartSearch'
import { useSearchSession } from '../useSearchSession'
import type { OverviewDensity } from '../overviewDensity'

afterEach(() => { cleanup(); localStorage.clear() })

describe('search session organizer selection restoration', () => {
  it.each(['Escape', 'Back', 'Clear'] as const)('restores inner and outer group selections through %s', exit => {
    for (const level of ['id', 'outerId'] as const) {
      const scene = fixtureScene()
      const saved = { ...initialPresentation(), search: { ...emptySearch(), query: 'Waiting' }, organizer: { outer: 'status' as const, inner: 'machine' as const, order: 'operational' as const, direction: 'asc' as const } }
      const group = organizedGroups(scene, saved, Date.now()).find(group => group.cards.length)!
      expect(group).toBeTruthy()
      const target = { kind: 'group' as const, id: group[level] }
      const focused = applyPresentationAction(saved, actionSchema.parse({ type: 'focus', target }), scene)
      expect(focused.outcome).toBe('applied')
      expect(Object.values(scene.arrangements).flat().some(group => group.id === target.id)).toBe(false)
      const { result, unmount } = renderHook(() => {
        const [state, setState] = useState(focused.state)
        const current = useRef(state)
        const send = (action: PresentationAction) => {
          current.current = applyPresentationAction(current.current, actionSchema.parse(action), scene).state
          setState(current.current)
        }
        const canvas = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null)
        const [roots, setRoots] = useState<import('../presentation').Target[]>([])
        const [details, setDetails] = useState<string[]>([])
        const [density, setDensity] = useState<OverviewDensity>('compact')
        const session = useSearchSession({ active: true, scene, state, send, canvas, root, roots, setRoots, details, setDetails, density, setDensity })
        return { state, send, session }
      })
      act(() => result.current.session.begin())
      act(() => result.current.send({ type: 'set-search', search: { ...emptySearch(), query: 'no-such-record' } }))
      expect(organizedGroups(scene, result.current.state, Date.now()).some(group => group[level] === target.id)).toBe(false)
      act(() => result.current.session.choose({ kind: 'card', id: scene.cards[0]!.id }))
      act(() => {
        if (exit === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        else if (exit === 'Back') result.current.session.restore()
        else result.current.session.clear()
      })
      expect(result.current.state.selection).toEqual(target)
      expect(result.current.state.search).toEqual(exit === 'Clear' ? emptySearch() : saved.search)
      expect(result.current.state.searchReveal).toBeNull()
      expect(organizedGroups(scene, result.current.state, Date.now()).some(group => group[level] === target.id)).toBe(true)
      unmount()
    }
  })

  it('clears a saved selection whose group no longer exists', () => {
    const scene = fixtureScene(), state = initialPresentation()
    const restored = applyPresentationAction(state, { type: 'restore-search-view', view: { ...state, selection: { kind: 'group', id: 'removed-group' } } }, scene)
    expect(restored.state.selection).toBeNull()
  })
})


it.each(['Clear', 'Escape'] as const)('restores a focused workspace snapshot atomically and retains %s recovery', exit => {
  const scene = fixtureScene(), baseline = initialPresentation()
  const target = { kind: 'card' as const, id: scene.cards[0]!.id }
  const { result, rerender } = renderHook(({ active }) => {
    const [state, setState] = useState(baseline), current = useRef(state)
    const send = (action: PresentationAction) => {
      current.current = applyPresentationAction(current.current, actionSchema.parse(action), scene).state
      setState(current.current)
    }
    const canvas = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null)
    const [roots, setRoots] = useState<import('../presentation').Target[]>([])
    const [details, setDetails] = useState<string[]>([])
    const [density, setDensity] = useState<OverviewDensity>('compact')
    const session = useSearchSession({ active, scene, state, send, canvas, root, roots, setRoots, details, setDetails, density, setDensity })
    return { state, send, session }
  }, { initialProps: { active: true } })
  act(() => result.current.session.begin(false))
  act(() => result.current.session.choose(target))
  const focused = {
    ...result.current.state, search: { ...emptySearch(), query: 'focused lens' }, collapsed: ['group:saved'],
    selection: target, navigation: { cardId: target.id, revision: 0 }, exceptionsOnly: true, roadmapExpanded: false,
    linksVisible: false, arrangement: 'machine' as const, sort: 'activity' as const,
  }
  act(() => result.current.send({ type: 'restore-search-view', view: {
    search: focused.search, searchReveal: focused.searchReveal, searchFocus: focused.searchFocus,
    selection: focused.selection, collapsed: focused.collapsed, navigation: focused.navigation,
    exceptionsOnly: focused.exceptionsOnly, roadmapExpanded: focused.roadmapExpanded, organizer: focused.organizer,
    statusFilter: focused.statusFilter, donutFilter: focused.donutFilter, linksVisible: focused.linksVisible,
    arrangement: focused.arrangement, sort: focused.sort,
  } }))
  const saved = result.current.session.captureView()
  rerender({ active: false })
  act(() => result.current.session.choose({ kind: 'card', id: scene.cards[1]!.id }))
  act(() => result.current.session.restoreView(saved))
  rerender({ active: true })
  for (const field of ['search', 'searchReveal', 'searchFocus', 'selection', 'collapsed', 'navigation', 'exceptionsOnly', 'roadmapExpanded', 'organizer', 'statusFilter', 'donutFilter', 'linksVisible', 'arrangement', 'sort'] as const) {
    expect(result.current.state[field]).toEqual(saved.state[field])
  }
  expect(result.current.session.captureView().roots).toEqual(saved.roots)
  act(() => {
    if (exit === 'Clear') result.current.session.clear()
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(result.current.state.searchReveal).toBeNull()
  expect(result.current.state.searchFocus).toBeUndefined()
  expect(result.current.state.collapsed).toEqual(baseline.collapsed)
  expect(result.current.state.exceptionsOnly).toBe(baseline.exceptionsOnly)
})

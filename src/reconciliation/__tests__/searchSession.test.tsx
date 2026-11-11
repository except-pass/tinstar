import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { organizedGroups } from '../../shared/floorOrganization'
import { actionSchema } from '../../shared/reconciliationCommands'
import { applyPresentationAction, initialPresentation, type PresentationAction } from '../presentation'
import { emptySearch } from '../../shared/smartSearch'
import { useSearchSession } from '../useSearchSession'
import type { OverviewDensity } from '../overviewDensity'

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

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
      act(() => result.current.session.choose({ kind: 'card', id: scene.cards[0]!.id }))
      expect(organizedGroups(scene, result.current.state, Date.now()).some(group => group[level] === target.id)).toBe(false)
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

  it.each(['Escape', 'Back', 'Restore'] as const)('preserves both directions of Gaps-only edits through %s', async exit => {
    for (const initiallyEnabled of [true, false]) {
      vi.stubGlobal('matchMedia', () => ({ matches: exit === 'Back' }))
      vi.spyOn(window.history, 'go')
      window.history.replaceState(null, '', window.location.href)
      const scene = fixtureScene()
      const { result, unmount } = renderHook(() => {
        const [state, setState] = useState({ ...initialPresentation(), exceptionsOnly: initiallyEnabled })
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
      act(() => result.current.session.choose({ kind: 'card', id: scene.cards[0]!.id }, undefined, 'Tin Star'))
      act(() => result.current.session.begin())
      // Replacing the lens unwinds a history entry before the user's Back.
      const replaced = exit === 'Back' ? new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true })) : null
      act(() => result.current.session.choose({ kind: 'card', id: scene.cards[0]!.id }))
      if (replaced) await act(async () => { await replaced })
      act(() => result.current.send({ type: 'set-exceptions', enabled: !initiallyEnabled }))
      const filters = result.current.state.search
      act(() => {
        if (exit === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        else if (exit === 'Back') {
          window.history.replaceState(null, '', window.location.href)
          window.dispatchEvent(new PopStateEvent('popstate'))
        } else result.current.session.restore()
      })
      expect(result.current.state.exceptionsOnly).toBe(!initiallyEnabled)
      expect(result.current.state.search).toEqual(filters)
      expect(result.current.state.searchFocus).toBeUndefined()
      expect(result.current.session.active).toBe(false)
      unmount()
    }
  })

  it('clears a saved selection whose group no longer exists', () => {
    const scene = fixtureScene(), state = initialPresentation()
    const restored = applyPresentationAction(state, { type: 'restore-search-view', view: { ...state, selection: { kind: 'group', id: 'removed-group' } } }, scene)
    expect(restored.state.selection).toBeNull()
  })
})



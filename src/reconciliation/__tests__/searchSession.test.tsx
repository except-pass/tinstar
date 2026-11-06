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
        const session = useSearchSession({ scene, state, send, canvas, root, roots, setRoots, details, setDetails, density, setDensity })
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

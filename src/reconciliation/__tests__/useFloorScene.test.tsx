import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureScene, fixtureSources, fixtureId } from '../../../test-fixtures/reconciliation/scenes'
import { apiFetch } from '../../apiClient'
import { useFloorScene } from '../useFloorScene'
import { usePresentation } from '../usePresentation'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { overviewGroups } from '../overviewModel'
import { patternPreviews } from '../PatternDial'
import { statusProjection } from '../../shared/floorOrganization'
import { workHealth } from '../../shared/workHealth'
import type { FloorScene } from '../presentation'

vi.mock('../../apiClient', () => ({ apiFetch: vi.fn() }))
const start = Date.parse('2026-11-09T16:00:00Z')
const response = (scene: FloorScene) => new Response(JSON.stringify({ ok: true, data: scene }))
function deferred() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>(accept => { resolve = accept })
  return { promise, resolve }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); vi.mocked(apiFetch).mockReset(); localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear() })
const flush = async () => { await act(async () => { await Promise.resolve() }) }

describe('one floor refresh owner', () => {
  it('publishes a complete scene and successful source time, then polls every 30 seconds', async () => {
    const initial = fixtureScene({ now: start }), next = fixtureScene({ now: start + 30_000 })
    vi.mocked(apiFetch).mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(next))
    const { result } = renderHook(() => useFloorScene())
    await flush()
    expect(result.current.scene).toEqual(initial)
    expect(result.current.lastSuccessfulSyncAt).toBe(initial.coverage.intentions.observedAt)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(result.current.scene).toEqual(next)
    expect(result.current.lastSuccessfulSyncAt).toBe(next.coverage.intentions.observedAt)
    expect(vi.mocked(apiFetch).mock.calls.map(([url]) => url)).toEqual(['/api/reconciliation/scene', '/api/reconciliation/scene'])
  })
  it('coalesces repeated manual requests and exposes busy state until the same read completes', async () => {
    const pending = deferred()
    vi.mocked(apiFetch).mockResolvedValueOnce(response(fixtureScene({ now: start }))).mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => useFloorScene())
    await flush()
    let a!: Promise<void>, b!: Promise<void>
    act(() => { a = result.current.refresh(); b = result.current.refresh() })
    expect(a).toBe(b)
    expect(result.current.refreshing).toBe(true)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(apiFetch).mock.calls[1]![0]).toBe('/api/reconciliation/scene?refresh=1')
    await act(async () => { pending.resolve(response(fixtureScene({ now: start }))); await a })
    expect(result.current.refreshing).toBe(false)
  })
  it('refreshes a stale view on browser focus/visibility using the same operation, without hidden-view polling', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response(fixtureScene({ now: Date.now() })))
    const { result, rerender } = renderHook(({ active }) => useFloorScene(active), { initialProps: { active: false } })
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); window.dispatchEvent(new Event('focus')) })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    rerender({ active: true })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')) })
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(result.current.lastSuccessfulSyncAt).toBe(new Date(start + 31_000).toISOString())
    expect(vi.mocked(apiFetch).mock.calls[1]![0]).toBe('/api/reconciliation/scene?refresh=1')
  })
  it('retains last-known data and success time on failure/partial reads, and recovers on success', async () => {
    const initial = fixtureScene({ now: start }), partial = fixtureScene({ now: start + 1000 }), recovered = fixtureScene({ now: start + 2000 })
    partial.coverage.intentions.coverage = 'partial'; partial.coverage.intentions.status = 'partial'
    vi.mocked(apiFetch).mockResolvedValueOnce(response(initial)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response(partial)).mockResolvedValueOnce(response(recovered))
    const { result } = renderHook(() => useFloorScene())
    await flush()
    await act(async () => { await result.current.refresh() })
    expect(result.current.scene).toMatchObject({ cards: initial.cards, searchReadFailed: true })
    expect(result.current.error).toContain('Last-known records')
    expect(result.current.lastSuccessfulSyncAt).toBe(initial.coverage.intentions.observedAt)
    await act(async () => { await result.current.refresh() })
    expect(result.current.scene).toEqual(partial)
    expect(result.current.lastSuccessfulSyncAt).toBe(initial.coverage.intentions.observedAt)
    await act(async () => { await result.current.refresh() })
    expect(result.current.scene).toEqual(recovered)
    expect(result.current.lastSuccessfulSyncAt).toBe(recovered.coverage.intentions.observedAt)
    expect(result.current.error).toBeNull()
  })
  it('discards a pre-mutation response and coalesces multiple mutations into one forced follow-up', async () => {
    const old = deferred(), updated = deferred()
    vi.mocked(apiFetch).mockResolvedValueOnce(response(fixtureScene({ now: start }))).mockReturnValueOnce(old.promise).mockReturnValueOnce(updated.promise)
    const { result } = renderHook(() => useFloorScene())
    await flush()
    const initial = result.current.scene
    let a!: Promise<void>, b!: Promise<void>
    act(() => { a = result.current.refresh(); b = result.current.refreshAfterMutation(); void result.current.refreshAfterMutation() })
    expect(a).toBe(b)
    await act(async () => { old.resolve(response(fixtureScene({ now: start + 1000 }))); await Promise.resolve() })
    expect(result.current.scene).toBe(initial)
    expect(apiFetch).toHaveBeenCalledTimes(3)
    const changed = fixtureScene({ now: start + 2000 })
    changed.cards[0]!.source.properties.Status!.value = 'Done'
    await act(async () => { updated.resolve(response(changed)); await b })
    expect(result.current.scene).toEqual(changed)
    expect(result.current.refreshing).toBe(false)
  })
  it('aborts on unmount and never publishes a late response', async () => {
    const pending = deferred()
    vi.mocked(apiFetch).mockReturnValue(pending.promise)
    const { unmount } = renderHook(() => useFloorScene())
    const signal = vi.mocked(apiFetch).mock.calls[0]![1]!.signal!
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(response(fixtureScene({ now: start }))) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})


it('publishes status/worker transitions atomically to rows, dial and status counts while preserving the view', async () => {
  let status = 'Waiting For', workerState = 'blocked'
  vi.mocked(apiFetch).mockImplementation(async () => {
    const sources = fixtureSources({ now: Date.now() })
    sources.intentions.data!.cards.find(card => card.id === fixtureId(4))!.properties.Status!.value = status
    const task = sources.fleet.flatMap(home => home.observation.data!.tasks).find(task => task.id === 'blocked-worker')!
    task.current_state.state = workerState
    task.last_event.state = workerState
    return response(new SceneReconciler().reconcile(sources, Date.now()))
  })
  const { result } = renderHook(() => {
    const floor = useFloorScene()
    const presentation = usePresentation(floor.scene, null, !!floor.error, false)
    return { ...floor, ...presentation }
  })
  await flush()
  act(() => {
    result.current.send({ type: 'set-pattern', pattern: 'blocked' })
    result.current.send({ type: 'set-organizer', organizer: { outer: 'manager', inner: 'none', order: 'priority', direction: 'desc' } })
    result.current.send({ type: 'focus', target: { kind: 'card', id: fixtureId(4) } })
  })
  const saved = result.current.state
  const cardIds = () => [...new Set(overviewGroups(result.current.scene!, result.current.state, result.current.now).flatMap(group => group.cards.map(card => card.id)))]
  const previews = () => patternPreviews(result.current.scene!, result.current.state, result.current.now)
  const projection = () => statusProjection(result.current.scene!, result.current.state, result.current.now)
  expect(cardIds()).toEqual([fixtureId(4)])
  expect(previews().blocked.count).toBe(1)
  expect(projection().cardCandidates.map(card => card.source.properties.Status!.value)).toEqual(['Waiting For'])
  status = 'Done'
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(result.current.state).toEqual(saved)
  expect(cardIds()).toEqual([])
  expect(previews().blocked.count).toBe(0)
  expect(projection().cards).toEqual([])
  expect(projection().workers).toEqual([])
  expect(workHealth(result.current.scene!, fixtureId(4), result.current.now).patterns.stalled.outcome).toBe('no-match')
  status = 'Archived'
  await act(async () => { await result.current.refresh() })
  expect(cardIds()).toEqual([])
  status = 'Waiting For'
  await act(async () => { await result.current.refresh() })
  expect(cardIds()).toEqual([fixtureId(4)])
  expect(previews().blocked.count).toBe(1)
  expect(result.current.state).toEqual(saved)
  status = 'In Progress'; workerState = 'waiting'
  await act(async () => { await result.current.refresh() })
  act(() => { result.current.send({ type: 'set-pattern', pattern: 'stalled' }) })
  // Current adapters do not publish runnable/resolver coverage. Preserve that
  // truthful unknown; the separate runnable-count lane supplies confirmed stalls.
  expect(cardIds()).toContain(fixtureId(4))
  expect(workHealth(result.current.scene!, fixtureId(4), result.current.now).patterns.stalled.outcome).toBe('unavailable')
  workerState = 'working'
  await act(async () => { await result.current.refresh() })
  expect(cardIds()).not.toContain(fixtureId(4))
  expect(previews().active.count).toBe(2)
  expect(workHealth(result.current.scene!, fixtureId(4), result.current.now).patterns.stalled.outcome).toBe('no-match')
})

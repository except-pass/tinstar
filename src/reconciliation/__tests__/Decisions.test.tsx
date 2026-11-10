import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Decisions } from '../Decisions'
import { fixtureId, fixtureQueue, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { initialPresentation, type PresentationState } from '../presentation'
import { loadPresentationPreferences, savePresentationPreferences } from '../presentationPreferences'
import { renderHook } from '@testing-library/react'
import { usePresentation } from '../usePresentation'
const workspace = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../ask/DeskWorkspace', () => ({ useDeskWorkspace: () => workspace.value }))
vi.mock('../../ask/AskSurface', () => ({ AskSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
let state: PresentationState
beforeEach(() => {
  localStorage.clear()
  state = initialPresentation()
  Element.prototype.scrollIntoView = vi.fn()
  workspace.value = { scene: fixtureScene(), queue: fixtureQueue(), state, now: Date.now(), send: vi.fn(), connection: { scene_id: 'same-window' } }
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('Decisions', () => {
  it('finds conditional cards and sends canonical shared focus without opening a second Desk', () => {
    const { container } = render(<Decisions />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Roadmap' } })
    const row = container.querySelector<HTMLButtonElement>(`[data-card-id="${fixtureId(5)}"]`)!
    expect(row).toHaveTextContent('Future or conditional')
    fireEvent.click(row)
    expect(workspace.value.send).toHaveBeenCalledWith({ type: 'focus', target: { kind: 'card', id: fixtureId(5) }, origin: 'manual' })
    expect(container.querySelector('[data-presentation-scene]')).toHaveAttribute('data-scene-id', 'same-window')
  })
  it('uses shared selection for its summary and retains that selection through refresh', () => {
    state.selection = { kind: 'card', id: fixtureId(5) }
    savePresentationPreferences(state)
    expect(loadPresentationPreferences().selection).toEqual(state.selection)
    render(<Decisions />)
    expect(screen.getByLabelText('Selected decision')).toHaveTextContent('Roadmap: planned integration')
    expect(within(screen.getByLabelText('Selected decision')).getByRole('link', { name: /Read Notion card/ })).toHaveAttribute('href', `https://www.notion.so/${fixtureId(5)}`)
  })
  it('reveals a flash outside search, restores scroll, and keeps steady selection separate', async () => {
    vi.useFakeTimers()
    const view = render(<Decisions />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } })
    const list = screen.getByLabelText('Decision requests')
    list.scrollTop = 90
    state.flash = { ids: [`card:${fixtureId(5)}`], until: Date.now() + 2000 }
    view.rerender(<Decisions />)
    const row = view.container.querySelector(`[data-card-id="${fixtureId(5)}"]`)!
    expect(row).toHaveClass('flashed')
    expect(row).not.toHaveClass('selected')
    expect(row.scrollIntoView).toHaveBeenCalled()
    list.scrollTop = 300
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(list.scrollTop).toBe(90)
    expect(view.container.querySelector('.flashed')).toBeNull()
    expect(view.container.querySelector('[data-card-id]')).toBeNull()
  })
  it('does not treat scene ownership as a published action in rows, search or summary', () => {
    const queue = fixtureQueue(), scene = fixtureScene()
    queue.items = [{ ...queue.items[0]!, cardIds: [fixtureId(5)], action: null }]
    scene.cards.find(card => card.id === fixtureId(5))!.nextAction = 'Will'
    workspace.value.queue = queue
    workspace.value.scene = scene
    state.selection = { kind: 'card', id: fixtureId(5) }
    const view = render(<Decisions />)
    expect(screen.getByLabelText('Selected decision')).toHaveTextContent('Next action not published')
    expect(view.container.querySelector('[data-card-id]')).not.toHaveTextContent('Will')
    state.selection = null
    view.rerender(<Decisions />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Will' } })
    expect(view.container.querySelector('[data-card-id]')).toBeNull()
  })
  it.each(['clear', 'replace', 'unmount'] as const)('restores both scroll axes in all ancestors on flash %s', async transition => {
    vi.useFakeTimers()
    const view = render(<Decisions />)
    const list = screen.getByLabelText('Decision requests')
    const outer = view.container
    list.scrollTop = 90
    list.scrollLeft = 12
    outer.scrollTop = 40
    outer.scrollLeft = 7
    Element.prototype.scrollIntoView = vi.fn(() => {
      list.scrollTop = 300
      list.scrollLeft = 100
      outer.scrollTop = 200
      outer.scrollLeft = 50
    })
    state.flash = { ids: [`card:${fixtureId(5)}`], until: Date.now() + 2000 }
    view.rerender(<Decisions />)
    expect(outer.scrollTop).toBe(200)
    if (transition === 'unmount') view.unmount()
    else {
      state.flash = transition === 'clear' ? null : { ids: [`card:${fixtureId(5)}`], until: Date.now() + 3000 }
      view.rerender(<Decisions />)
      if (transition === 'replace') await act(async () => { vi.advanceTimersByTime(3000) })
    }
    expect([list.scrollTop, list.scrollLeft, outer.scrollTop, outer.scrollLeft]).toEqual([90, 12, 40, 7])
  })
  it('leaves scrolling under manual control after a flash', async () => {
    vi.useFakeTimers()
    state.flash = { ids: [`card:${fixtureId(5)}`], until: Date.now() + 2000 }
    render(<Decisions />)
    const list = screen.getByLabelText('Decision requests')
    fireEvent.wheel(document.body)
    list.scrollTop = 210
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(list.scrollTop).toBe(210)
  })
  it('shows unavailable and stale coverage instead of a false empty result', () => {
    workspace.value.queueError = 'Queue source unavailable; retained items are last-known.'
    const queue = fixtureQueue()
    queue.items = []
    workspace.value.queue = queue
    render(<Decisions />)
    expect(screen.getByText(/Shared card focus is unavailable/)).toBeVisible()
    expect(screen.getByText(/Source coverage is incomplete/)).toBeVisible()
  })
  it('shows unlinked request details without card focus or flash claims', () => {
    const queue = fixtureQueue()
    queue.items = [{ ...queue.items[0]!, id: 'hold:unlinked', title: `fm-hold-v1:${btoa('Choose a recovery path')}`, cardIds: [], evidence: [] }]
    workspace.value.queue = queue
    const view = render(<Decisions />)
    fireEvent.click(screen.getByText('Choose a recovery path'))
    expect(screen.getByText('No linked card; card focus and flash are unavailable.')).toBeVisible()
    expect(view.container.querySelector('[data-card-id]')).toBeNull()
    expect(screen.getByLabelText('Selected decision')).toHaveTextContent('Select a card')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } })
    expect(screen.queryByText('Choose a recovery path')).toBeNull()
  })
  it('disables focus for a queued card absent from the source scene', () => {
    const scene = fixtureScene()
    scene.cards = scene.cards.filter(card => card.id !== fixtureId(5))
    workspace.value.scene = scene
    const view = render(<Decisions />)
    expect(view.container.querySelector(`[data-card-id="${fixtureId(5)}"]`)).toBeDisabled()
    expect(screen.getByRole('link', { name: /Read source card/ })).toBeVisible()
  })
})
describe('Decisions presentation acknowledgment', () => {
  it('rejects scene cards absent from this queue, stale reads, and absent source cards', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { scene_id: 'test', key: 'secret' } }))))
    const scene = fixtureScene(), queue = fixtureQueue()
    const { result, rerender } = renderHook(({ failed }) => usePresentation(scene, queue, false, false, true, failed), { initialProps: { failed: false } })
    expect(result.current.send({ type: 'flash', targets: [{ kind: 'card', id: fixtureId(100) }] })?.outcome).toBe('unknown-id')
    expect(result.current.send({ type: 'flash', targets: [{ kind: 'card', id: 'absent' }] })?.outcome).toBe('unknown-id')
    act(() => { expect(result.current.send({ type: 'focus', target: { kind: 'card', id: fixtureId(5) } })?.outcome).toBe('applied') })
    expect(result.current.state.selection).toEqual({ kind: 'card', id: fixtureId(5) })
    rerender({ failed: true })
    expect(result.current.send({ type: 'flash', targets: [{ kind: 'card', id: fixtureId(5) }] })?.outcome).toBe('queue-source-unavailable')
  })
})

it('uses the shared Needs Will projection and shows advisory unknowns and honest PR/request ages', () => {
  const queue = fixtureQueue(), item = queue.items[0]!
  queue.needsWill = [{ ...item, requestSince: null, ageBasis: 'unknown', requests: [], pulls: [{ id: 'example/repo#1', repository: 'example/repo', number: 1, url: 'https://github.com/example/repo/pull/1', title: 'Merge me', author: 'agent', draft: false, head: 'a'.repeat(40), base: 'main', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', observedAt: '2026-11-10T00:00:00Z', freshness: 'fresh', links: [], readiness: null }] }]
  queue.operationalExceptions = [{ cardId: fixtureId(1), title: 'Slow source card', state: 'unknown', reasons: ['Linked home snapshot expired'], sources: [] }]
  workspace.value.queue = queue
  render(<Decisions />)
  expect(screen.getByText('Request age unknown')).toBeInTheDocument()
  expect(screen.getByText(/PR opened 2026-11-01.*not request age/)).toBeInTheDocument()
  expect(screen.getByText('Execution unknown')).toBeInTheDocument()
  expect(screen.getByText('Linked home snapshot expired')).toBeInTheDocument()
  expect(document.querySelectorAll('.decisions-row, .decisions-request')).toHaveLength(1)
})

it('answers a typed published choice through the shared workflow without dismissing the request', async () => {
  const queue = fixtureQueue(), item = { ...queue.items[0]!, cardIds: [fixtureId(5)] }
  queue.needsWill = [{ ...item, requestSince: null, ageBasis: 'unknown', pulls: [], requests: [{ cardId: fixtureId(5), id: 'published-mailbox', action: 'Decision', preserveAction: false, requestedFrom: 'Will', question: 'Choose replication', since: null, sourceId: 'proposal-note', answered: false, options: [{ id: 'r1', label: 'One copy' }, { id: 'r3', label: 'Three copies' }] }] }]
  workspace.value.queue = queue
  state.selection = { kind: 'card', id: fixtureId(5) }
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, data: { outcome: 'partially-saved', saved_fields: ['note'], decision_resolution: { state: 'pending', message: 'Decision recorded · First Mate not yet updated' } } })))
  vi.stubGlobal('fetch', fetch)
  render(<Decisions />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Three copies' })) })
  const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body))
  expect(body).toMatchObject({ operation: 'update', input: { kind: 'answer_decision', card_id: fixtureId(5), request_id: 'published-mailbox', option_id: 'r3', answer: 'Three copies', next: { owner: 'Firstmate', status: 'Queued' } } })
  expect(screen.getByLabelText('Selected decision')).toHaveTextContent('Decision recorded · First Mate not yet updated')
  expect(document.querySelectorAll('.decisions-row')).toHaveLength(1)
  expect(fetch).toHaveBeenCalledTimes(1)
})

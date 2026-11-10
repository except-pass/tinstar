import { workflowMarkers } from '../../shared/workflowMarkers'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Decisions } from '../Decisions'
import { requestAnchor } from '../../shared/deskSource'
import type { QueueSource } from '../../server/reconciliation/queue'
import { fixtureId, fixtureQueue, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { applyPresentationAction, initialPresentation, type PresentationState } from '../presentation'
import { loadPresentationPreferences, savePresentationPreferences } from '../presentationPreferences'
import { renderHook } from '@testing-library/react'
import { SceneSessions } from '../../server/reconciliation/sessions'
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
    expect(row).toHaveTextContent('Waiting on a prerequisite')
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
    expect(screen.getByLabelText('Selected decision')).toHaveTextContent('Roadmap: planned integration')
    expect(within(screen.getByLabelText('Selected decision')).queryByText('Will', { exact: true })).toBeNull()
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
    expect(screen.getByText(/Shared card focus is unavailable/).closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText(/Some evidence needs verification/)).toBeVisible()
  })
  it('shows unlinked request details without card focus or flash claims', () => {
    const queue = fixtureQueue()
    queue.items = [{ ...queue.items[0]!, id: 'hold:unlinked', title: `fm-hold-v1:${btoa('Choose a recovery path')}`, cardIds: [], evidence: [] }]
    workspace.value.queue = queue
    const view = render(<Decisions />)
    fireEvent.click(screen.getByText('Choose a recovery path'))
    expect(screen.getByLabelText('Selected decision')).toHaveAttribute('data-decision-id', 'hold:unlinked')
    expect(workspace.value.send).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-card-id]')).toBeNull()
    expect(screen.getByLabelText('Selected decision')).toHaveTextContent('Choose a recovery path')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } })
    expect(within(screen.getByLabelText('Decision requests')).queryByText('Choose a recovery path')).toBeNull()
    expect(screen.getByLabelText('Selected decision')).toHaveTextContent('Choose a recovery path')
  })
  it('disables focus for a queued card absent from the source scene', () => {
    const scene = fixtureScene()
    scene.cards = scene.cards.filter(card => card.id !== fixtureId(5))
    workspace.value.scene = scene
    const view = render(<Decisions />)
    fireEvent.click(view.container.querySelector(`[data-card-id="${fixtureId(5)}"]`)!)
    expect(workspace.value.send).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /Read Notion card/ })).toBeVisible()
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
  fireEvent.click(document.querySelector('.decisions-row')!)
  expect(screen.getByText('Request age unknown').closest('details')).not.toHaveAttribute('open')
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
  const workflowCalls = fetch.mock.calls.filter(([url]) => String(url).includes('/api/reconciliation/workflow'))
  const body = JSON.parse(String(workflowCalls[0]![1]!.body))
  expect(body).toMatchObject({ operation: 'update', input: { kind: 'answer_decision', card_id: fixtureId(5), request_id: 'published-mailbox', option_id: 'r3', answer: 'Three copies', next: { owner: 'Firstmate', status: 'Queued' } } })
  expect(screen.getByLabelText('Selected decision')).toHaveTextContent('Decision recorded · First Mate not yet updated')
  expect(document.querySelectorAll('.decisions-row')).toHaveLength(1)
  expect(workflowCalls).toHaveLength(1)
})

it('keeps sibling proposal choices enabled and replaces saved status with refreshed reconciliation', async () => {
  const queue = fixtureQueue(), item = { ...queue.items[0]!, cardIds: [fixtureId(5)] }
  const request = { cardId: fixtureId(5), id: 'proposal-a', action: 'Decision', preserveAction: false, requestedFrom: 'Will', question: 'First decision', since: null, sourceId: 'a', answered: false, options: [{ id: 'a', label: 'Answer A' }] }
  queue.needsWill = [{ ...item, requestSince: null, ageBasis: 'unknown', pulls: [], requests: [request, { ...request, id: 'proposal-b', sourceId: 'b', question: 'Second decision', options: [{ id: 'b', label: 'Answer B' }] }] }, { ...item, id: 'source-b', requestSince: null, ageBasis: 'unknown', pulls: [], requests: [], decisionResolution: { state: 'pending', message: 'Sibling pending', request_id: 'proposal-b' } }]
  workspace.value.queue = queue
  state.selection = { kind: 'card', id: fixtureId(5) }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { outcome: 'partially-saved', saved_fields: ['note'], decision_resolution: { state: 'pending', message: 'Decision recorded · First Mate not yet updated' } } }))))
  const view = render(<Decisions />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Answer A' })) })
  expect(screen.getByRole('button', { name: 'Answer A' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Answer B' })).toBeEnabled()
  workspace.value.queue = { ...queue, needsWill: [...queue.needsWill, { ...queue.needsWill[0]!, id: 'source-a', decisionResolution: { state: 'verification-needed', message: 'Source A needs verification', request_id: 'proposal-a' } }] }
  view.rerender(<Decisions />)
  expect(screen.getByLabelText('Selected decision').querySelector('[role="status"]')).toHaveTextContent('Source A needs verification')
  expect(screen.getByLabelText('Selected decision').querySelector('[role="status"]')).not.toHaveTextContent('not yet updated')
  expect(screen.getByRole('button', { name: 'Answer B' })).toBeEnabled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Answer B' })) })
  expect(screen.getByRole('button', { name: 'Answer B' })).toBeDisabled()
  expect(screen.getByLabelText('Selected decision').querySelectorAll('[role="status"]')).toHaveLength(1)
})

it('keeps multi-card requests canonical and removes the same resolved decision after the shared queue refresh', () => {
  const queue = fixtureQueue(), item = { ...queue.items[0]!, cardIds: [fixtureId(1), fixtureId(5)] }
  queue.items = [item]
  workspace.value.queue = queue
  const view = render(<Decisions />)
  expect(view.container.querySelectorAll('.decisions-row')).toHaveLength(1)
  fireEvent.click(view.container.querySelector('.decisions-row')!)
  expect(screen.getByLabelText('Selected decision')).toHaveAttribute('data-decision-id', item.id)
  workspace.value.queue = { ...queue, items: [] }
  view.rerender(<Decisions />)
  expect(view.container.querySelectorAll('.decisions-row')).toHaveLength(0)
  expect(screen.queryByLabelText('Selected decision')).toBeNull()
})
it('keeps coordination bundles in diagnostics rather than presenting one omnibus decision', () => {
  const queue = fixtureQueue()
  queue.items = [{ ...queue.items[0]!, title: 'Owner calls via main: bus restore, tariff route, designer restart timing' }]
  workspace.value.queue = queue
  const view = render(<Decisions />)
  expect(view.container.querySelectorAll('.decisions-row')).toHaveLength(0)
  const note = screen.getByText(/Owner calls via main/)
  expect(note.closest('details')).not.toHaveAttribute('open')
  expect(screen.getByText(/Some requests need verification/)).toBeVisible()
})

it('preserves recommendation verbs as questions and hides workflow protocol metadata', async () => {
  const queue = fixtureQueue()
  queue.items = [{ ...queue.items[0]!, cardIds: [fixtureId(5)], action: 'Should we recommend 3 replicas or keep 1?' }]
  workspace.value.queue = queue
  const original = ['Question: Keep 1 replica or move to 3?', ...Object.values(workflowMarkers).map(prefix => `${prefix} {"id":"private-request"}`)].join('\n')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { blocks: [{ id: 'note', text: original }] } }))))
  render(<Decisions />)
  fireEvent.click(document.querySelector('.decisions-row')!)
  const evidence = await screen.findByText('Question: Keep 1 replica or move to 3?', { selector: 'p' })
  expect(evidence).toBeVisible()
  for (const marker of ['private-request', 'private-decision', 'private-operation']) expect(evidence).not.toHaveTextContent(marker)
  const detail = screen.getByLabelText('Selected decision')
  expect(detail).toHaveTextContent('Should we recommend 3 replicas or keep 1?')
  expect(detail).not.toHaveTextContent('First Mate recommends')
  expect(within(detail).queryByLabelText('Operation')).toBeNull()
  expect(within(detail).queryByText('Edit / note')).toBeNull()
  expect(within(detail).getByLabelText('Answer')).toBeInTheDocument()
  const technical = within(detail).getAllByText('Technical details')[0]!.closest('details')!
  expect(technical).not.toHaveAttribute('open')
  expect(technical).toHaveTextContent('private-request')
  for (const prefix of Object.values(workflowMarkers)) {
    expect(evidence).not.toHaveTextContent(prefix)
    expect(technical).toHaveTextContent(prefix)
  }
})

it('retains the explicitly opened request when its click focuses a shared card', () => {
  const queue = fixtureQueue(), base = queue.items[0]!
  queue.items = [{ ...base, id: 'first', cardIds: [fixtureId(5)] }, { ...base, id: 'second', cardIds: [fixtureId(5)] }]
  workspace.value.queue = queue
  const view = render(<Decisions />)
  fireEvent.click(view.container.querySelector('[data-decision-id="second"]')!)
  state.selection = { kind: 'card', id: fixtureId(5) }
  view.rerender(<Decisions />)
  expect(screen.getByLabelText('Selected decision')).toHaveAttribute('data-decision-id', 'second')
})
it('exposes every supporting card context in one canonical request', async () => {
  const queue = fixtureQueue()
  queue.items = [{ ...queue.items[0]!, cardIds: [fixtureId(1), fixtureId(5)] }]
  workspace.value.queue = queue
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ ok: true, data: { blocks: [{ id: 'source', text: url.includes(fixtureId(1)) ? 'First supporting question' : 'Second supporting question' }] } }))))
  const view = render(<Decisions />)
  fireEvent.click(view.container.querySelector('.decisions-row')!)
  expect(await screen.findByText('First supporting question', { selector: 'p' })).toBeVisible()
  expect(await screen.findByText('Second supporting question', { selector: 'p' })).toBeVisible()
  expect(view.container.querySelectorAll('.decisions-row')).toHaveLength(1)
  for (const id of [fixtureId(1), fixtureId(5)]) expect(view.container.querySelector(`a[href="https://www.notion.so/${id}"]`)).toBeVisible()
  const related = screen.getAllByRole('button', { name: 'Open related work' })
  fireEvent.click(related[1]!)
  expect(workspace.value.send).toHaveBeenCalledWith({ type: 'navigate-card', cardId: fixtureId(5) })
})

it('labels merged PR response controls with their own questions and routes each answer', async () => {
  const queue = fixtureQueue(), pull = 'https://github.com/example/repo/pull/42'
  const questions = ['May we merge the security fix?', 'Should we defer the rollout?']
  const sources: QueueSource[] = questions.map((question, index) => {
    const request = { home: 'test-home', taskId: `worker-${index}`, kind: 'decision' as const, id: `question-${index}` }
    return { kind: 'firstmate', id: request.taskId, field: 'decision', request, action: `fm-hold-v1:${btoa(question)}`, responseAnchor: requestAnchor(request), readiness: 'ready-now', status: 'fresh', coverage: 'complete', observedAt: null, expiresAt: null }
  })
  queue.items = [{ ...queue.items[0]!, id: 'merged-pr-request', identities: [pull], title: 'PR review', action: 'Review the PR questions', readiness: 'ready-now', cardIds: [], sources, evidence: [{ kind: 'pull-request', url: pull }] }]
  workspace.value.queue = queue
  const submit = vi.fn(async () => ({ saved: true, canReceive: true as const }))
  workspace.value.submit = submit
  const view = render(<Decisions />)
  fireEvent.click(view.container.querySelector('.decisions-row')!)
  expect(view.container.querySelectorAll('.decisions-row')).toHaveLength(1)
  expect(screen.getByLabelText('Selected decision')).toHaveAttribute('data-decision-id', 'merged-pr-request')
  for (const [index, question] of questions.entries()) {
    const section = screen.getByText(question).closest('section')!
    expect(section).toBeVisible()
    expect(section).not.toHaveTextContent('fm-hold-v1:')
    expect(within(section).getByRole('slider', { name: 'Slide to dismiss' })).toBeVisible()
    fireEvent.click(within(section).getByText('Answer', { exact: true }))
    fireEvent.change(within(section).getByLabelText('Answer this decision'), { target: { value: `Response ${index}` } })
    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Send to First Mate' })) })
    expect(submit).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({ anchorKey: sources[index]!.responseAnchor, kind: 'answer', text: `Response ${index}` }))
  }
})

it('prioritizes explicit card targets over retained items and reveals them through search', () => {
  const scene = fixtureScene(), queue = fixtureQueue()
  const first = { ...queue.items[0]!, id: 'request-a', cardIds: [fixtureId(1)] }
  const second = { ...queue.items[0]!, id: 'request-b', cardIds: [fixtureId(5)] }
  queue.items = [first, second]
  workspace.value.queue = queue
  state.queueItemId = first.id
  const view = render(<Decisions />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matching question' } })
  const open = (target: { cardId?: string; itemId?: string }) => {
    const result = applyPresentationAction(state, { type: 'open-queue', ...target }, scene, Date.now(), queue)
    expect(result.outcome).toBe('applied')
    state = result.state
    workspace.value.state = state
    view.rerender(<Decisions />)
  }
  open({ cardId: fixtureId(5) })
  expect(screen.getByLabelText('Selected decision')).toHaveAttribute('data-decision-id', second.id)
  expect(view.container.querySelector('.decisions-row')).toHaveAttribute('data-decision-id', second.id)
  open({ itemId: first.id })
  expect(screen.getByLabelText('Selected decision')).toHaveAttribute('data-decision-id', first.id)
  expect(view.container.querySelector('.decisions-row')).toHaveAttribute('data-decision-id', first.id)
  const contextCard = scene.cards.find(card => ![fixtureId(1), fixtureId(5)].includes(card.id))!
  open({ cardId: contextCard.id })
  expect(screen.queryByLabelText('Selected decision')).toBeNull()
  expect(within(screen.getByLabelText('Card context')).getByRole('link', { name: /Read Notion card/ })).toHaveAttribute('href', `https://www.notion.so/${contextCard.id}`)
  expect(view.container.querySelectorAll('.decisions-row')).toHaveLength(0)
  state = { ...state, queueCardId: null, queueItemId: 'removed-request', selection: { kind: 'card', id: fixtureId(1) } }
  workspace.value.state = state
  view.rerender(<Decisions />)
  expect(screen.queryByLabelText('Selected decision')).toBeNull()
  expect(screen.queryByLabelText('Card context')).toBeNull()
})

it.each(['item', 'card'] as const)('focus supersedes a prior %s queue target in rendered Decisions', openKind => {
  const scene = fixtureScene(), queue = fixtureQueue()
  const source = (id: string, question: string): QueueSource => {
    const request = { home: 'test-home', taskId: id, kind: 'decision' as const, id }
    return { kind: 'firstmate', id, field: 'decision', request, action: question, responseAnchor: requestAnchor(request), readiness: 'ready-now', status: 'fresh', coverage: 'complete', observedAt: null, expiresAt: null }
  }
  queue.items = [
    { ...queue.items[0]!, id: 'request-a', cardIds: [fixtureId(1)], readiness: 'ready-now', sources: [source('a', 'Approve the first request?')] },
    { ...queue.items[0]!, id: 'request-b', cardIds: [fixtureId(5)], readiness: 'ready-now', sources: [source('b', 'Approve the second request?')] },
  ]
  workspace.value.queue = queue
  workspace.value.submit = vi.fn()
  const opened = applyPresentationAction(state, { type: 'open-queue', ...(openKind === 'item' ? { itemId: 'request-a' } : { cardId: fixtureId(1) }) }, scene, Date.now(), queue)
  expect(opened.outcome).toBe('applied')
  state = opened.state
  workspace.value.state = state
  const view = render(<Decisions />)
  expect(screen.getByLabelText('Selected decision')).toHaveAttribute('data-decision-id', 'request-a')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matching question' } })
  const scrolled: Element[] = []
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this) })
  const focused = applyPresentationAction(state, { type: 'focus', target: { kind: 'card', id: fixtureId(5) }, origin: 'manual' }, scene, Date.now(), queue)
  expect(focused.outcome).toBe('applied')
  expect(focused.state).toMatchObject({ selection: { kind: 'card', id: fixtureId(5) }, queueOpen: false, queueCardId: null })
  state = focused.state
  workspace.value.state = state
  view.rerender(<Decisions />)
  const detail = screen.getByLabelText('Selected decision')
  expect(detail).toHaveAttribute('data-decision-id', 'request-b')
  expect(within(detail).getByText('Approve the second request?')).toBeVisible()
  expect(within(detail).queryByText('Approve the first request?')).toBeNull()
  expect(within(detail).getByRole('slider', { name: 'Slide to dismiss' })).toBeVisible()
  expect(view.container.querySelector('.decisions-row')).toHaveAttribute('data-decision-id', 'request-b')
  expect(scrolled.at(-1)).toHaveAttribute('data-decision-id', 'request-b')
})

describe('complete Decisions reveal delivery', () => {
  it.each(['foreground', 'background', 'cancelled background'] as const)('reveals primary A and secondary B outside the local query during %s delivery', async mode => {
    vi.useFakeTimers()
    const scene = fixtureScene(), queue = fixtureQueue(), broker = new SceneSessions()
    const a = { kind: 'card' as const, id: fixtureId(1) }, b = { kind: 'card' as const, id: fixtureId(5) }
    queue.items = [a, b].map((target, index) => ({ ...queue.items[0]!, id: `reveal-${index}`, title: index ? 'Secondary B' : 'Primary A', cardIds: [target.id] }))
    let hidden = mode !== 'foreground'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible')
    vi.spyOn(document, 'hasFocus').mockImplementation(() => !hidden)
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => [{ width: 300, height: 40 }] as unknown as DOMRectList)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const y = this.dataset.cardId === b.id ? 100 : 10
      return { x: 10, y, left: 10, top: y, right: 310, bottom: y + 40, width: 300, height: 40, toJSON() {} }
    })
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (_x: number, y: number) => document.querySelector(`[data-card-id="${y > 90 ? b.id : a.id}"]`) })
    vi.stubGlobal('fetch', vi.fn(async (_url, request) => {
      const payload = JSON.parse(request.body)
      const data = payload.type === 'register' ? broker.register(payload.state, payload.rendered_scene)
        : payload.type === 'sync' ? { commands: broker.sync(payload.scene_id, payload.state, payload.acknowledgments, payload.rendered_scene), designated: false } : {}
      return new Response(JSON.stringify({ ok: true, data }))
    }))
    let presentation!: ReturnType<typeof usePresentation>
    function Browser() {
      presentation = usePresentation(scene, queue, false, true, true)
      workspace.value = { scene, queue, now: Date.now(), ...presentation }
      return <Decisions />
    }
    const tick = async (ms = 1050) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
    const view = render(<Browser />)
    await tick()
    const query = screen.getByRole('searchbox')
    fireEvent.change(query, { target: { value: 'Primary A' } })
    expect(view.container.querySelector(`[data-card-id="${b.id}"]`)).toBeNull()
    const tab = broker.list()[0]!, commandId = 'reveal-both'
    expect(broker.enqueue({ scene_id: tab.scene_id, command_id: commandId, expected_revision: tab.revision, ttl_ms: 8000, action: { type: 'reveal-search', target: a, targets: [b] } }, scene).outcome).toBe('queued')
    await tick()
    expect(presentation.state.searchFocus).toEqual([a, b])
    expect(presentation.state.flash?.ids).toEqual([`card:${a.id}`, `card:${b.id}`])
    for (const target of [a, b]) expect(view.container.querySelector(`[data-card-id="${target.id}"]`)).toHaveClass('flashed')
    expect(query).toHaveValue('Primary A')
    const revision = presentation.state.revision
    if (hidden) {
      await tick(5500)
      expect(view.container.querySelector(`[data-card-id="${b.id}"]`)).toBeNull()
      expect(broker.result(tab.scene_id, commandId).delivery).toMatchObject({ stage: 'not-visible', pending: true })
      if (mode === 'cancelled background') fireEvent.keyDown(query, { key: 'ArrowLeft' })
      hidden = false
      act(() => window.dispatchEvent(new Event('focus')))
    }
    await tick(); await tick()
    expect(presentation.state.revision).toBe(revision)
    expect(query).toHaveValue('Primary A')
    if (mode === 'cancelled background') {
      expect(view.container.querySelector(`[data-card-id="${b.id}"]`)).toBeNull()
      expect(broker.result(tab.scene_id, commandId).delivery).toMatchObject({ stage: 'not-visible', pending: false, reason: 'Superseded by user interaction.' })
    } else {
      expect(broker.result(tab.scene_id, commandId).delivery).toMatchObject({ stage: 'foreground-visible', targets: [`card:${a.id}`, `card:${b.id}`], visible_targets: [`card:${a.id}`, `card:${b.id}`], pending: false })
      fireEvent.wheel(screen.getByLabelText('Decision requests'))
      fireEvent.change(query, { target: { value: 'Primary A ' } })
      expect(view.container.querySelector(`[data-card-id="${b.id}"]`)).toBeNull()
      expect(query).toHaveValue('Primary A ')
      await tick(5000)
      act(() => window.dispatchEvent(new Event('focus')))
      expect(view.container.querySelector(`[data-card-id="${b.id}"]`)).toBeNull()
    }
  })
})

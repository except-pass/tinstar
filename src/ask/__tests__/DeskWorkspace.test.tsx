import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import App from '../../App'
import { observeTargets } from '../../reconciliation/presentationVisibility'
import { Overview } from '../../reconciliation/Overview'
import { DeskWorkspace, useDeskWorkspace } from '../DeskWorkspace'
import { AskCardAction } from '../Ask'
import { DeskRail } from '../DeskRail'
import { clampDeskWidth, deskPreferencesKey, loadDeskPreferences } from '../deskPreferences'
import { fixtureId, fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { askItemSchema } from '../../shared/ask'
const source = vi.hoisted(() => ({ scene: null as unknown, queue: null as ReturnType<typeof fixtureQueue> | null, queueError: null as string | null }))
vi.mock('../../reconciliation/useFloorScene', () => ({ useFloorScene: () => ({ scene: source.scene, error: null, now: Date.now() }) }))
vi.mock('../../reconciliation/useDeskQueue', () => ({ useDeskQueue: () => ({ queue: source.queue, error: source.queueError }), useReviewQueue: () => ({ queue: source.queue, error: source.queueError }) }))
const read = vi.fn()
const record = () => askItemSchema.parse({ request_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), question: 'Where is the evidence?', input_mode: 'text', context: { anchor: { kind: 'work', page_id: fixtureId(1), label: 'Task', url: null, observed_at: null }, view: { scene: 'overview' } }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'sent', reply: null, error: null, read_at: null, dismissed_at: null })
let items: ReturnType<typeof record>[]
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear(); items = [record(), record()]; source.scene = fixtureScene(); source.queue = null; source.queueError = null
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  vi.stubGlobal('matchMedia', () => ({ matches: window.innerWidth <= 850, addEventListener() {}, removeEventListener() {} }))
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  read.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const data = url === '/api/fleet' ? { ready: true, workers: [], attention: [], errors: [] }
      : url === '/api/fleet/messages' ? []
      : url === '/api/releases' ? { pulls: [], unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false }
      : url === '/api/quota' ? { providers: [], checkedAt: null, fetchedAt: null, commandError: null }
      : url === '/api/ask/requests' ? items : url === '/api/reconciliation/ui' ? body.type === 'register' ? { scene_id: 'test', key: 'secret' } : { commands: [] } : {}
    return new Response(JSON.stringify(url === '/api/quota' ? data : { ok: true, data }))
  })
  vi.stubGlobal('fetch', read)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function Shell({ page = 'overview' }: { page?: string }) {
  return <DeskWorkspace overviewActive={page === 'overview'} decisionsActive={page === 'decisions'} onOverview={() => {}} workers={[]} messages={[]} submit={vi.fn()}><main key={page}>{page}<AskCardAction cardId={fixtureId(1)} /></main></DeskWorkspace>
}
const rail = (request = 0) => <DeskRail openRequest={request} unread={2} attention={1} onClose={() => {}}><button>Inbox item</button></DeskRail>
// Overview and App navigation under a second full suite exceeds the 5s default.
describe('desk workspace', () => {
it('has one compact header and one History control while retaining resize and collapse', async () => {
  render(<App />)
  const desk = screen.getByLabelText('Discuss')
  expect(within(desk).getByRole('heading', { name: 'Discuss' })).toBeVisible()
  expect(within(desk).getByRole('button', { name: 'Collapse Discuss' })).toBeVisible()
  expect(within(desk).getAllByRole('button', { name: /^History/ })).toHaveLength(1)
  for (const label of ['Find worker', 'Message receipts', 'Ask First Mate', 'Reset Desk size']) expect(within(desk).queryByRole('button', { name: label })).toBeNull()
  expect(within(desk).queryByText('YOU / ONE INBOX')).toBeNull()
  expect(within(desk).queryByText('Desk size')).toBeNull()
  expect(screen.getByRole('separator', { name: 'Resize Discuss' })).toBeVisible()
  await act(async () => {})
})

it('counts only conversations, keeps decisions out of Discuss and never reads listed answers', async () => {
  const answer = { ...record(), status: 'answered' as const, reply: { summary: 'Ready to review', detail: 'Evidence', references: [], suggested_actions: [] } }
  const followUp = { ...record(), conversation_id: answer.conversation_id, question: 'A follow-up', created_at: '2099-01-01T00:00:00Z' }
  const archived = { ...record(), dismissed_at: new Date().toISOString() }
  items = [answer, followUp, archived, ...Array.from({ length: 45 }, (_, i) => ({ ...record(), question: `Pending question ${i}` }))]
  source.queue = fixtureQueue()
  render(<Shell />)
  const tabs = screen.getByRole('navigation', { name: 'Discuss views' })
  await waitFor(() => expect(within(tabs).getByRole('button', { name: 'Needs you 1' })).toHaveAttribute('aria-pressed', 'true'))
  expect(screen.queryByRole('region', { name: 'Decision queue' })).toBeNull()
  expect(document.querySelectorAll('[data-ask-id]')).toHaveLength(1)
  expect(within(tabs).getByRole('button', { name: 'History 1' })).toBeVisible()
  fireEvent.click(within(tabs).getByRole('button', { name: 'Waiting 45' }))
  expect(document.querySelectorAll('[data-ask-id]')).toHaveLength(45)
  fireEvent.click(within(tabs).getByRole('button', { name: 'Needs you 1' }))
  expect(screen.queryByRole('region', { name: 'Decision queue' })).toBeNull()
  expect(document.querySelectorAll('[data-ask-id]')).toHaveLength(1)
  expect(read.mock.calls.some(([url]) => /\/read$/.test(String(url)))).toBe(false)
  expect(items.map(item => item.read_at)).toEqual(items.map(() => null))
})

it('keeps queue failures and expired evidence out of conversation counts', async () => {
  source.queue = fixtureQueue()
  const view = render(<Shell />)
  const tabs = screen.getByRole('navigation', { name: 'Discuss views' })
  await act(async () => {})
  source.queueError = 'Queue source unavailable'
  view.rerender(<Shell />)
  expect(within(tabs).getByRole('button', { name: 'Needs you 0' })).toBeVisible()
  fireEvent.click(within(tabs).getByRole('button', { name: 'Needs you 0' }))
  expect(screen.queryByText('Requests could not refresh.')).toBeNull()
  expect(screen.queryByRole('textbox', { name: 'Answer this decision' })).toBeNull()
  source.queueError = null
  source.queue = { ...source.queue, items: source.queue.items.map(item => ({ ...item, sources: item.sources.map(s => ({ ...s, expiresAt: '2020-01-01T00:00:00Z' })) })) }
  view.rerender(<Shell />)
  expect(within(tabs).getByRole('button', { name: 'Needs you 0' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('textbox', { name: 'Answer this decision' })).toBeNull()
})

it('keeps one inbox and a draft through all section switches and collapse/reopen', async () => {
  const view = render(<Shell />)
  await screen.findAllByText('Where is the evidence?')
  const desk = screen.getByLabelText('Discuss')
  fireEvent.click(screen.getByRole('button', { name: 'Ask First Mate about this task' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'Draft kept while browsing' } })
  for (const page of ['decisions', 'releases', 'pulls', 'worker', 'overview']) {
    view.rerender(<Shell page={page} />)
    expect(screen.getByLabelText('Discuss')).toBe(desk)
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('Draft kept while browsing')
  }
  fireEvent.click(screen.getByRole('button', { name: 'Close question' }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Discuss' }))
  expect(desk).not.toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /Open Discuss/ }))
  expect(screen.getByLabelText('Discuss')).toBe(desk)
  expect(within(desk).getAllByText('Where is the evidence?')).toHaveLength(2)
})
it('polls once per interval while independent answers arrive in another section', async () => {
  vi.useFakeTimers()
  const view = render(<Shell />)
  await act(async () => {})
  expect(read.mock.calls.filter(([url]) => url === '/api/ask/requests')).toHaveLength(1)
  view.rerender(<Shell page="releases" />)
  items = items.map((item, index) => ({ ...item, status: 'answered', reply: { summary: `Independent answer ${index}`, detail: 'Evidence', references: [], suggested_actions: [] } }))
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(read.mock.calls.filter(([url]) => url === '/api/ask/requests')).toHaveLength(2)
  expect(screen.getByText('Independent answer 0')).toBeVisible()
  expect(screen.getByText('Independent answer 1')).toBeVisible()
})
it('disconnects the Overview UI bridge while away and re-registers without losing presentation', async () => {
  const view = render(<Shell />)
  await waitFor(() => expect(read.mock.calls.some(([url, init]) => url === '/api/reconciliation/ui' && JSON.parse(String(init?.body)).type === 'register')).toBe(true))
  view.rerender(<Shell page="pulls" />)
  await waitFor(() => expect(read.mock.calls.some(([url, init]) => url === '/api/reconciliation/ui' && JSON.parse(String(init?.body)).type === 'disconnect')).toBe(true))
  view.rerender(<Shell />)
  await waitFor(() => expect(read.mock.calls.filter(([url, init]) => url === '/api/reconciliation/ui' && JSON.parse(String(init?.body)).type === 'register')).toHaveLength(2))
})
it('keeps the same MCP registration across Overview and Decisions', async () => {
  const view = render(<Shell />)
  const requests = (type: string) => read.mock.calls.filter(([url, init]) => url === '/api/reconciliation/ui' && JSON.parse(String(init?.body)).type === type)
  await waitFor(() => expect(requests('register')).toHaveLength(1))
  view.rerender(<Shell page="decisions" />)
  view.rerender(<Shell />)
  expect(requests('disconnect')).toHaveLength(0)
  expect(requests('register')).toHaveLength(1)
})
it('shows retained questions before contextual sources become available', async () => {
  source.scene = null
  render(<Shell page="releases" />)
  expect(await screen.findAllByText('Where is the evidence?')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Ask First Mate about this task' }))
  expect(screen.getByRole('status')).toHaveTextContent('Discuss is temporarily unavailable')
  expect(screen.getByText(/Source context is unavailable/).closest('details')).not.toHaveAttribute('open')
})
it('restores desktop width/collapse across reload and allows accessible reset', () => {
  localStorage.setItem(deskPreferencesKey, JSON.stringify({ width: 456, collapsed: true }))
  const view = render(rail())
  fireEvent.click(screen.getByRole('button', { name: /Open Discuss/ }))
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '456')
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '472')
  view.unmount(); render(rail())
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '472')
  fireEvent.doubleClick(screen.getByRole('separator'))
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '320')
})
it('clamps resizing on available width and recovers the preferred desktop width after a temporary shrink', () => {
  localStorage.setItem(deskPreferencesKey, JSON.stringify({ width: 600, collapsed: false }))
  render(rail())
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '600')
  Object.defineProperty(window, 'innerWidth', { value: 900 }); fireEvent.resize(window)
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '438')
  expect(loadDeskPreferences().width).toBe(600)
  Object.defineProperty(window, 'innerWidth', { value: 1440 }); fireEvent.resize(window)
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '600')
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' })
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '240')
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' })
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '640')
  expect(clampDeskWidth(1000, 900)).toBe(500)
})
it('uses the same mobile sheet subtree and preserves desktop collapse when opening and closing it', () => {
  Object.defineProperty(window, 'innerWidth', { value: 390 })
  localStorage.setItem(deskPreferencesKey, JSON.stringify({ width: 456, collapsed: true }))
  render(rail())
  const trigger = screen.getByRole('button', { name: /Open Discuss, 2 unread answers, 1 need attention/ })
  fireEvent.click(trigger)
  const sheet = screen.getByRole('dialog', { name: 'Discuss' })
  expect(within(sheet).getByRole('button', { name: 'Close Discuss' })).toHaveFocus()
  fireEvent.keyDown(sheet, { key: 'Escape' })
  expect(sheet).not.toBeVisible(); expect(trigger).toHaveFocus()
  expect(loadDeskPreferences()).toEqual({ width: 456, collapsed: true })
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog', { name: 'Discuss' })).toBe(sheet)
})
it('handles invalid or unavailable browser preferences without preventing use', () => {
  localStorage.setItem(deskPreferencesKey, '{bad')
  expect(loadDeskPreferences()).toEqual({ width: 320, collapsed: false })
  localStorage.setItem(deskPreferencesKey, JSON.stringify({ width: -50, collapsed: 'yes' }))
  expect(loadDeskPreferences()).toEqual({ width: 240, collapsed: false })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('restricted') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('restricted') })
  render(rail())
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Discuss' }))
  fireEvent.click(screen.getByRole('button', { name: /Open Discuss/ }))
  expect(screen.getByRole('button', { name: 'Inbox item' })).toBeVisible()
})

function NavigationShell() {
  const [page, setPage] = useState('overview')
  return <DeskWorkspace overviewActive={page === 'overview'} decisionsActive={page === 'decisions'} onOverview={() => setPage('overview')} workers={[]} messages={[]} submit={vi.fn()}>
    <button onClick={() => setPage('releases')}>Visit Releases</button>
    <button onClick={() => setPage('pulls')}>Visit PRs</button>
    <button onClick={() => setPage('overview')}>Visit Overview</button>
    {page === 'overview' ? <Overview workers={[]} /> : <p>Other section</p>}
  </DeskWorkspace>
}
it.each(['Clear', 'Escape'])('restores search focus after section remount using %s', async method => {
  const view = render(<NavigationShell />)
  const before = [...view.container.querySelectorAll('.ov-card')].map(element => element.getAttribute('data-entity-id'))
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  fireEvent.change(screen.getByRole('combobox', { name: 'Find names, IDs and text' }), { target: { value: 'Roadmap: planned integration' } })
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Find names, IDs and text' }), { key: 'Enter' })
  expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeVisible()
  for (const section of ['Releases', 'PRs']) {
    fireEvent.click(screen.getByRole('button', { name: 'Visit ' + section }))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Smart Search' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Visit Overview' }))
    expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeVisible()
  }
  if (method === 'Clear') fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
  else fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
  expect([...view.container.querySelectorAll('.ov-card')].map(element => element.getAttribute('data-entity-id'))).toEqual(before)
})
it.each(['ask', 'execution', 'claim'])('preserves mobile Desk for Ask and dismisses operational queue navigation on %s', async origin => {
  Object.defineProperty(window, 'innerWidth', { value: 390 })
  localStorage.setItem(deskPreferencesKey, JSON.stringify({ width: 456, collapsed: true }))
  source.queue = fixtureQueue()
  if (origin === 'execution' || origin === 'claim') {
    const scene = fixtureScene()
    items[0]!.context.target = { kind: origin, id: origin === 'execution' ? scene.executions[0]!.id : scene.claims[0]!.id }
  }
  render(<NavigationShell />)
  await waitFor(() => expect(read.mock.calls.some(([url]) => url === '/api/ask/requests')).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: 'Visit Releases' }))
  fireEvent.click(screen.getByRole('button', { name: /Open Discuss/ }))
  const desk = screen.getByRole('dialog', { name: 'Discuss' })
  fireEvent.click(within(desk).getByRole('button', { name: /^Waiting(?: \d+)?$/ }))
  expect(desk.querySelector('[data-desk-card-id]')).toBeNull()
  fireEvent.click(within(desk).getAllByText('Where is the evidence?')[0]!)
  expect(desk).toBeVisible()
  expect(screen.getByRole('region', { name: 'Overview' })).toBeVisible()
  expect(loadDeskPreferences()).toEqual({ width: 456, collapsed: true })
  expect(screen.getByRole('dialog', { name: 'Discuss' })).toBe(desk)
  expect(desk.querySelectorAll('[data-ask-id]')).toHaveLength(2)
})

it.each(['Clear', 'Escape', 'repeated search', 'repeated search Escape'])('keeps mobile restoration in Overview through App history using %s', async method => {
  Object.defineProperty(window, 'innerWidth', { value: 390 })
  const go = vi.spyOn(window.history, 'go')
  const view = render(<App />)
  await screen.findAllByText('Where is the evidence?')
  const nav = screen.getByRole('navigation', { name: 'Activity' })
  const before = [...view.container.querySelectorAll('.ov-card')].map(element => element.getAttribute('data-entity-id'))
  const viewport = view.container.querySelector('.ov-canvas')!.parentElement!
  viewport.scrollLeft = 21
  const choose = (query: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
    const input = screen.getByRole('combobox', { name: 'Find names, IDs and text' })
    fireEvent.change(input, { target: { value: query } })
    fireEvent.keyDown(input, { key: 'Enter' })
  }
  choose('Roadmap: planned integration')
  expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeVisible()
  fireEvent.click(within(nav).getByRole('button', { name: /^Releases/ }))
  expect(window.location.search).toContain('view=releases')
  fireEvent.click(within(nav).getByRole('button', { name: 'Overview' }))
  expect(window.location.search).toBe('')
  expect(screen.getByRole('button', { name: 'Clear search focus' })).toBeVisible()
  if (method.startsWith('repeated search')) {
    choose('Build live reconciliation')
    expect(go).not.toHaveBeenCalled()
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    if (method.endsWith('Escape')) fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    await act(async () => { await popped })
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
  } else {
    if (method === 'Clear') fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
    else fireEvent.keyDown(window, { key: 'Escape' })
    expect(go).not.toHaveBeenCalled()
  }
  expect(window.location.search).toBe('')
  expect(within(nav).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  expect(screen.queryByRole('button', { name: 'Clear search focus' })).toBeNull()
  expect([...view.container.querySelectorAll('.ov-card')].map(element => element.getAttribute('data-entity-id'))).toEqual(before)
  expect(view.container.querySelector('.ov-canvas')!.parentElement!.scrollLeft).toBe(21)
  const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { window.history.back(); await popped })
  expect(window.location.search).toContain('view=releases')
  expect(within(nav).getByRole('button', { name: /^Releases/ })).toHaveAttribute('aria-current', 'page')
})


it.each(['same time', 'newest first', 'oldest first'])('updates an expanded inline thread in place through the single poller with requests at %s', async order => {
  items = items.map((item, index) => ({ ...item, question: `Where is the evidence for request ${index}?`, created_at: new Date(Date.UTC(2026, 0, 1) + (order === 'same time' ? 0 : order === 'newest first' ? 1 - index : index) * 1000).toISOString() }))
  vi.useFakeTimers()
  render(<Shell page="releases" />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: /Waiting for answer.*Where is the evidence for request 0/ }))
  const thread = screen.getByRole('region', { name: /Answer thread/ })
  expect(thread).toHaveTextContent('Waiting for answer')
  items = items.map((item, index) => ({ ...item, status: 'answered', reply: { summary: `Independent answer ${index}`, detail: `Complete evidence ${index}`, references: [], suggested_actions: [] } }))
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(screen.getByRole('region', { name: /Answer thread/ })).toBe(thread)
  expect(thread).toHaveTextContent('Complete evidence 0')
  expect(screen.getByRole('button', { name: /New answer.*Independent answer 1/ })).toBeVisible()
  expect(read.mock.calls.filter(([url]) => url === '/api/ask/requests')).toHaveLength(2)
})

it('retains the expanded three-turn thread and inline draft through Overview, PRs and Releases', async () => {
  const first = items[0]!
  items = [first, ...['Can it proceed?', 'Who reviews it?'].map((question, index) => ({ ...record(), conversation_id: first.conversation_id, question, created_at: `2099-01-0${index + 1}T00:00:00Z` }))]
  const view = render(<Shell />)
  fireEvent.click(await screen.findByRole('button', { name: /^Waiting for answer.*Who reviews it/ }))
  const thread = screen.getByRole('region', { name: /Answer thread/ })
  const field = screen.getByRole('textbox', { name: 'Reply to First Mate' })
  fireEvent.change(field, { target: { value: 'What about that review?' } })
  const tabs = screen.getByRole('navigation', { name: 'Discuss views' })
  for (const tab of ['History', 'Needs you', 'Waiting']) {
    fireEvent.click(within(tabs).getByRole('button', { name: new RegExp(`^${tab} `) }))
    expect(screen.getByLabelText('Reply to First Mate', { selector: 'textarea' })).toBe(field)
    expect(field).toHaveValue('What about that review?')
  }
  expect(field).toBeVisible()
  for (const page of ['pulls', 'releases', 'overview']) {
    view.rerender(<Shell page={page} />)
    expect(screen.getByRole('region', { name: /Answer thread/ })).toBe(thread)
    expect(screen.getByRole('textbox', { name: 'Reply to First Mate' })).toBe(field)
    expect(field).toHaveValue('What about that review?')
    for (const item of items) expect(thread).toHaveTextContent(item.question)
  }
  fireEvent.keyDown(field, { key: 'Escape' })
  expect(screen.getByRole('button', { name: 'Collapse answer' })).toHaveFocus()
  expect(field).toHaveValue('What about that review?')
})
}, 30_000)


it.each([390, 1440])('routes manual decisions without closing Discuss at %spx', async width => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  source.queue = fixtureQueue()
  function QueueProbe() {
    const { send, state } = useDeskWorkspace()
    return <><button onClick={() => send({ type: 'open-queue', itemId: source.queue!.items[0]!.id })}>Open decision</button><output aria-label="Decision pane open">{String(state.queueOpen)}</output></>
  }
  function Navigation() {
    const [page, setPage] = useState('overview')
    return <DeskWorkspace overviewActive={page === 'overview'} decisionsActive={page === 'decisions'} onOverview={() => setPage('overview')} onDecisions={() => setPage('decisions')} workers={[]} messages={[]} submit={vi.fn()}><main><span data-testid="page">{page}</span><button onClick={() => setPage('overview')}>Visit Overview</button><QueueProbe /></main></DeskWorkspace>
  }
  render(<Navigation />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: /Open Discuss/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Open decision' }))
  expect(screen.getByLabelText('Discuss')).toBeVisible()
  expect(screen.getByTestId('page')).toHaveTextContent('decisions')
  expect(screen.getByLabelText('Decision pane open')).toHaveTextContent('true')
  fireEvent.click(within(screen.getByLabelText('Discuss')).getByRole('button', { name: width === 390 ? 'Close Discuss' : 'Collapse Discuss' }))
  expect(screen.getByLabelText('Decision pane open')).toHaveTextContent('true')
  fireEvent.click(screen.getByRole('button', { name: 'Visit Overview' }))
  expect(screen.getByTestId('page')).toHaveTextContent('overview')
  fireEvent.click(screen.getByRole('button', { name: 'Open decision' }))
  expect(screen.getByTestId('page')).toHaveTextContent('decisions')
})

it.each(['navigate-card', 'next_queue_item', 'next', 'previous', 'card', 'item', 'default'].flatMap(mode => [false, true].map(background => ({ mode, background }))))('closes mobile Discuss for $mode with background=$background and observes delivery', async ({ mode, background }) => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  source.queue = fixtureQueue()
  const rows = source.queue.needsWill ?? source.queue.items
  const destination = rows[mode === 'next' || mode === 'next_queue_item' ? 1 : 0]!
  const cardId = destination.cardIds[0]!
  let hidden = background
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible')
  vi.spyOn(document, 'hasFocus').mockImplementation(() => !hidden)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => [{ width: 300, height: 40 }] as unknown as DOMRectList)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 10, right: 310, top: 10, bottom: 50, width: 300, height: 40 } as DOMRect))
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.desk-backdrop') ?? document.querySelector(`.decisions-row[data-card-id="${cardId}"]`) })
  const action = mode === 'navigate-card' ? { type: 'navigate-card', cardId }
    : ['next_queue_item', 'next', 'previous'].includes(mode) ? { type: 'navigate-queue', direction: mode === 'previous' ? 'previous' : 'next' }
    : mode === 'card' ? { type: 'open-queue', cardId }
    : mode === 'item' ? { type: 'open-queue', itemId: destination.id } : { type: 'open-queue' }
  const fallback = read.getMockImplementation()!
  let sent = false
  read.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== '/api/reconciliation/ui') return fallback(url, init)
    const body = JSON.parse(String(init?.body))
    const data = body.type === 'register' ? { scene_id: 'test', session_code: 'A123BC', key: 'secret', designated: false }
      : body.type === 'sync' && !sent ? { commands: [{ scene_id: 'test', command_id: 'navigate', expected_revision: body.state.revision, expires_at: Date.now() + 8000, action: { ...action, origin: 'assistant', expectedRevision: body.state.revision } }] } : { commands: [] }
    if (body.type === 'sync') sent = true
    return new Response(JSON.stringify({ ok: true, data }))
  })
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /^Open Discuss/ }))
  expect(screen.getByRole('dialog', { name: 'Discuss' })).toBeVisible()
  const tick = async (ms = 1100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  await tick()
  expect(location.search).toContain('view=decisions')
  expect(document.querySelector(`.decisions-row[data-card-id="${cardId}"]`)).toHaveClass('selected')
  expect(screen.getByLabelText('Discuss')).not.toBeVisible()
  expect(document.querySelector('.desk-backdrop')).toBeNull()
  expect(document.querySelector('[data-scene-id]')).toHaveAttribute('data-scene-id', 'test')
  const acknowledgments = () => read.mock.calls.flatMap(([url, init]) => url === '/api/reconciliation/ui' ? JSON.parse(String(init?.body)).acknowledgments ?? [] : [])
  const revision = document.querySelector('[data-scene-id]')!.getAttribute('data-revision')
  if (background) {
    await tick(5500)
    expect(acknowledgments()).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: expect.objectContaining({ stage: 'not-visible', pending: true }) })]))
    hidden = false
    act(() => window.dispatchEvent(new Event('focus')))
  }
  await tick(); await tick()
  expect(document.querySelector('[data-scene-id]')).toHaveAttribute('data-revision', revision)
  expect(acknowledgments()).toEqual(expect.arrayContaining([expect.objectContaining({ command_id: 'navigate', delivery: expect.objectContaining({ stage: 'foreground-visible', visible_targets: [`card:${cardId}`], pending: false }) })]))
})


it.each(['card', 'execution'] as const)('routes a mixed reveal with an additional %s from Decisions to Overview', async kind => {
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/?view=decisions')
  source.queue = fixtureQueue()
  const scene = fixtureScene(), cardId = source.queue.items[0]!.cardIds[0]!
  const extra = kind === 'execution' ? scene.executions[0]!.id : scene.cards.find(card => !source.queue!.items.some(item => item.cardIds.includes(card.id)))!.id
  const fallback = read.getMockImplementation()!
  let sent = false
  read.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== '/api/reconciliation/ui') return fallback(url, init)
    const body = JSON.parse(String(init?.body))
    const data = body.type === 'register' ? { scene_id: 'test', key: 'secret' }
      : body.type === 'sync' && !sent ? { commands: [{ scene_id: 'test', command_id: 'mixed', expected_revision: body.state.revision, expires_at: Date.now() + 8000, action: { type: 'reveal-search', target: { kind: 'card', id: cardId }, targets: [{ kind, id: extra }], origin: 'assistant', expectedRevision: body.state.revision } }] } : { commands: [] }
    if (body.type === 'sync') sent = true
    return new Response(JSON.stringify({ ok: true, data }))
  })
  render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
  expect(new URLSearchParams(location.search).get('view')).toBeNull()
  expect(document.querySelector('.ov')).toBeTruthy()
  expect([...document.querySelectorAll<HTMLElement>('[data-semantic-id]')].some(node => node.dataset.semanticId === `${kind}:${extra}`)).toBe(true)
})


it.each(['navigate-card', 'focus', 'flash', 'reveal-search'] as const)('delivers %s for secondary and coordination cards through Overview, including background replay', async type => {
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/?view=decisions')
  source.queue = fixtureQueue()
  const rows = source.queue.needsWill ?? source.queue.items
  const primary = rows[0]!.cardIds[0]!, secondary = fixtureId(4)
  rows[0]!.cardIds = [primary, secondary]
  rows[1]!.title = 'Owner calls via operational coordination'
  const coordination = rows[1]!.cardIds[0]!
  let hidden = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible')
  vi.spyOn(document, 'hasFocus').mockImplementation(() => !hidden)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => [{ width: 100, height: 40 }] as unknown as DOMRectList)
  const ids = [primary, secondary, coordination]
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = ids.indexOf((this.dataset.semanticId ?? '').replace('card:', ''))
    const left = 10 + Math.max(0, index) * 110
    return { left, right: left + 100, top: 10, bottom: 50, width: 100, height: 40 } as DOMRect
  })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (x: number) => document.querySelector(`.ov [data-semantic-id="card:${ids[Math.floor((x - 10) / 110)]}"]`) })
  const fallback = read.getMockImplementation()!
  let command = 0
  read.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== '/api/reconciliation/ui') return fallback(url, init)
    const body = JSON.parse(String(init?.body))
    let data: unknown = body.type === 'register' ? { scene_id: 'test', key: 'secret' } : { commands: [] }
    if (body.type === 'sync' && command < 2) {
      const id = command++ === 0 ? secondary : coordination
      const target = { kind: 'card', id }, targets = [{ kind: 'card', id: primary }, target]
      const action = type === 'navigate-card' ? { type, cardId: id } : type === 'focus' ? { type, target } : type === 'flash' ? { type, targets } : { type, target: targets[0], targets: [target] }
      data = { commands: [{ scene_id: 'test', command_id: String(command), expected_revision: body.state.revision, expires_at: Date.now() + 8000, action: { ...action, origin: 'assistant', expectedRevision: body.state.revision } }] }
    }
    return new Response(JSON.stringify({ ok: true, data }))
  })
  render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
  expect(new URLSearchParams(location.search).get('view')).toBeNull()
  expect(observeTargets([`card:${secondary}`], 'overview').rendered_targets).toEqual([`card:${secondary}`])
  await act(async () => { await vi.advanceTimersByTimeAsync(6500) })
  hidden = false
  act(() => window.dispatchEvent(new Event('focus')))
  await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
  const expected = (type === 'flash' || type === 'reveal-search' ? [primary, coordination] : [coordination]).map(id => `card:${id}`)
  expect(observeTargets(expected, 'overview')).toMatchObject({ stage: 'foreground-visible', rendered_targets: expected, visible_targets: expected, pending: false })
  const acknowledgments = read.mock.calls.flatMap(([url, init]) => url === '/api/reconciliation/ui' ? JSON.parse(String(init?.body)).acknowledgments ?? [] : [])
  expect(acknowledgments).toEqual(expect.arrayContaining([expect.objectContaining({ command_id: '2', delivery: expect.objectContaining({ stage: 'foreground-visible', visible_targets: expected, pending: false }) })]))
})

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import App from '../../App'
import { Overview } from '../../reconciliation/Overview'
import { DeskWorkspace } from '../DeskWorkspace'
import { AskCardAction } from '../Ask'
import { DeskRail } from '../DeskRail'
import { clampDeskWidth, deskPreferencesKey, loadDeskPreferences } from '../deskPreferences'
import { fixtureId, fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { askItemSchema } from '../../shared/ask'
const source = vi.hoisted(() => ({ scene: null as unknown, queue: null as ReturnType<typeof fixtureQueue> | null }))
vi.mock('../../reconciliation/useFloorScene', () => ({ useFloorScene: () => ({ scene: source.scene, error: null, now: Date.now() }) }))
vi.mock('../../reconciliation/useDeskQueue', () => ({ useDeskQueue: () => ({ queue: source.queue, error: null }) }))
const read = vi.fn()
const record = () => askItemSchema.parse({ request_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), question: 'Where is the evidence?', input_mode: 'text', context: { anchor: { kind: 'work', page_id: fixtureId(1), label: 'Task', url: null, observed_at: null }, view: { scene: 'overview' } }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'sent', reply: null, error: null, read_at: null, dismissed_at: null })
let items: ReturnType<typeof record>[]
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear(); items = [record(), record()]; source.scene = fixtureScene(); source.queue = null
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
  return <DeskWorkspace overviewActive={page === 'overview'} onOverview={() => {}} workers={[]} messages={[]} submit={vi.fn()}><main key={page}>{page}<AskCardAction cardId={fixtureId(1)} /></main></DeskWorkspace>
}
const rail = (request = 0) => <DeskRail openRequest={request} unread={2} attention={1} onClose={() => {}}><button>Inbox item</button></DeskRail>
it('keeps one inbox and a draft through all section switches and collapse/reopen', async () => {
  const view = render(<Shell />)
  await screen.findAllByText('Where is the evidence?')
  const desk = screen.getByLabelText('Your desk')
  fireEvent.click(screen.getByRole('button', { name: 'Ask First Mate about this task' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'Draft kept while browsing' } })
  for (const page of ['releases', 'pulls', 'worker', 'overview']) {
    view.rerender(<Shell page={page} />)
    expect(screen.getByLabelText('Your desk')).toBe(desk)
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('Draft kept while browsing')
  }
  fireEvent.click(screen.getByRole('button', { name: 'Close question' }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Your desk' }))
  expect(desk).not.toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /Open Your desk/ }))
  expect(screen.getByLabelText('Your desk')).toBe(desk)
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
it('shows retained questions before contextual sources become available', async () => {
  source.scene = null
  render(<Shell page="releases" />)
  expect(await screen.findAllByText('Where is the evidence?')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Ask First Mate about this task' }))
  expect(screen.getByText(/Source context is unavailable/)).toHaveAttribute('role', 'status')
})
it('restores desktop width/collapse across reload and allows accessible reset', () => {
  localStorage.setItem(deskPreferencesKey, JSON.stringify({ width: 456, collapsed: true }))
  const view = render(rail())
  fireEvent.click(screen.getByRole('button', { name: /Open Your desk/ }))
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '456')
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' })
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '472')
  view.unmount(); render(rail())
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '472')
  fireEvent.click(screen.getByText('Desk size'))
  fireEvent.click(screen.getByRole('button', { name: 'Reset Desk size' }))
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
  const trigger = screen.getByRole('button', { name: /Open Your desk, 2 unread answers, 1 need attention/ })
  fireEvent.click(trigger)
  const sheet = screen.getByRole('dialog', { name: 'Your desk' })
  expect(within(sheet).getByRole('button', { name: 'Close Your desk' })).toHaveFocus()
  fireEvent.keyDown(sheet, { key: 'Escape' })
  expect(sheet).not.toBeVisible(); expect(trigger).toHaveFocus()
  expect(loadDeskPreferences()).toEqual({ width: 456, collapsed: true })
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog', { name: 'Your desk' })).toBe(sheet)
})
it('handles invalid or unavailable browser preferences without preventing use', () => {
  localStorage.setItem(deskPreferencesKey, '{bad')
  expect(loadDeskPreferences()).toEqual({ width: 320, collapsed: false })
  localStorage.setItem(deskPreferencesKey, JSON.stringify({ width: -50, collapsed: 'yes' }))
  expect(loadDeskPreferences()).toEqual({ width: 240, collapsed: false })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('restricted') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('restricted') })
  render(rail())
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Your desk' }))
  fireEvent.click(screen.getByRole('button', { name: /Open Your desk/ }))
  expect(screen.getByRole('button', { name: 'Inbox item' })).toBeVisible()
})

function NavigationShell() {
  const [page, setPage] = useState('overview')
  return <DeskWorkspace overviewActive={page === 'overview'} onOverview={() => setPage('overview')} workers={[]} messages={[]} submit={vi.fn()}>
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
it.each(['queue', 'ask', 'execution', 'claim'])('preserves mobile Desk for Ask and dismisses operational queue navigation on %s', async origin => {
  Object.defineProperty(window, 'innerWidth', { value: 390 })
  localStorage.setItem(deskPreferencesKey, JSON.stringify({ width: 456, collapsed: true }))
  source.queue = fixtureQueue()
  if (origin === 'execution' || origin === 'claim') {
    const scene = fixtureScene()
    items[0]!.context.target = { kind: origin, id: origin === 'execution' ? scene.executions[0]!.id : scene.claims[0]!.id }
  }
  render(<NavigationShell />)
  await screen.findAllByText('Where is the evidence?')
  fireEvent.click(screen.getByRole('button', { name: 'Visit Releases' }))
  fireEvent.click(screen.getByRole('button', { name: /Open Your desk/ }))
  const desk = screen.getByRole('dialog', { name: 'Your desk' })
  if (origin === 'queue') fireEvent.click(desk.querySelector<HTMLButtonElement>(`[data-desk-card-id="${fixtureId(1)}"]`)!)
  else fireEvent.click(within(desk).getAllByText('Where is the evidence?')[0]!)
  if (origin === 'queue') expect(desk).not.toBeVisible()
  else expect(desk).toBeVisible()
  expect(screen.getByRole('region', { name: 'Overview' })).toBeVisible()
  expect(loadDeskPreferences()).toEqual({ width: 456, collapsed: true })
  if (origin === 'queue') fireEvent.click(screen.getByRole('button', { name: /Open Your desk/ }))
  expect(screen.getByRole('dialog', { name: 'Your desk' })).toBe(desk)
  expect(desk.querySelectorAll('[data-ask-id]')).toHaveLength(2)
})

it.each(['Clear', 'Escape', 'repeated search'])('keeps mobile restoration in Overview through App history using %s', async method => {
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
  if (method === 'repeated search') {
    choose('Build live reconciliation')
    expect(go).not.toHaveBeenCalled()
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear search focus' }))
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


it('updates an expanded inline thread in place as independent answers arrive through the single poller', async () => {
  vi.useFakeTimers()
  render(<Shell page="releases" />)
  await act(async () => {})
  fireEvent.click(screen.getAllByRole('button', { name: /Sent.*Where is the evidence/ })[0]!)
  const thread = screen.getByRole('region', { name: /Answer thread/ })
  expect(thread).toHaveTextContent('Waiting for First Mate')
  items = items.map((item, index) => ({ ...item, status: 'answered', reply: { summary: `Independent answer ${index}`, detail: `Complete evidence ${index}`, references: [], suggested_actions: [] } }))
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(screen.getByRole('region', { name: /Answer thread/ })).toBe(thread)
  expect(thread).toHaveTextContent('Complete evidence 0')
  expect(screen.getByRole('button', { name: /New answer.*Independent answer 1/ })).toBeVisible()
  expect(read.mock.calls.filter(([url]) => url === '/api/ask/requests')).toHaveLength(2)
})

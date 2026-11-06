import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Overview } from '../../reconciliation/Overview'
import { fixtureId, fixtureQueue, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { preferencesKey } from '../../reconciliation/presentationPreferences'
import { askItemSchema, type AskItem } from '../../shared/ask'
import type { FloorScene } from '../../shared/reconciliationPresentation'

const observed = vi.hoisted(() => ({ scene: null as unknown }))
vi.mock('../../reconciliation/useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now() }) }))
const queue = fixtureQueue()
vi.mock('../../reconciliation/useDeskQueue', () => ({ useDeskQueue: () => ({ queue, error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
let records: AskItem[], scene: FloorScene
const requests: Array<Record<string, unknown>> = []
const seed = (): AskItem => askItemSchema.parse({
  request_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), question: 'Why is this waiting?', input_mode: 'text',
  context: { anchor: { kind: 'work', page_id: fixtureId(1), label: 'Captured task', url: `https://www.notion.so/${fixtureId(1)}`, observed_at: null }, view: { scene: 'overview' } },
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'answered',
  reply: { summary: 'Review is pending', detail: 'First Mate checked the live dependency.', references: [{ label: 'Evidence', url: 'https://example.test/evidence' }], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null,
})
beforeEach(() => {
  localStorage.clear(); records = []; requests.length = 0; scene = fixtureScene(); observed.scene = scene
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; this.querySelector<HTMLElement>('textarea,button')?.focus() } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    let data: unknown = {}
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url === '/api/reconciliation/ui') data = body?.type === 'register' ? { scene_id: crypto.randomUUID(), key: 'test-session' } : { commands: [] }
    if (url === '/api/ask/requests') {
      if (body) {
        requests.push(body)
        const row = { ...seed(), question: body.question, status: 'sent' as const, reply: null }
        row.context.anchor.page_id = body.card_id
        records.push(row); data = row
      } else data = records
    }
    const match = /\/api\/ask\/requests\/([^/]+)\/(read|dismiss|retry)$/.exec(url)
    if (match) {
      const row = records.find(record => record.request_id === match[1])!
      if (match[2] === 'read') row.read_at = new Date().toISOString()
      if (match[2] === 'dismiss') row.dismissed_at = new Date().toISOString()
      data = row
    }
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
  }))
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const mount = () => render(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
const card = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(`.ov-card[data-entity-id="${fixtureId(1)}"]`)!
const touch = (element: HTMLElement, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x = 100, y = 100) => fireEvent[type](element, { touches: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] })

describe('one-card text Ask and Desk', () => {
  it('keeps tap/vertical/cancel semantics and opens a context composer on left release without sending', () => {
    const { container } = mount(), task = card(container)
    touch(task, 'touchStart'); touch(task, 'touchMove', 96, 106); touch(task, 'touchEnd', 96, 106)
    fireEvent.click(task)
    expect(task).toHaveAttribute('aria-expanded', 'true')
    touch(task, 'touchStart'); touch(task, 'touchMove', 90, 140); touch(task, 'touchEnd', 30, 140)
    expect(screen.queryByRole('dialog')).toBeNull()
    touch(task, 'touchStart'); touch(task, 'touchMove', 30, 100); touch(task, 'touchCancel')
    expect(screen.queryByRole('dialog')).toBeNull()
    touch(task, 'touchStart'); touch(task, 'touchMove', 30, 100)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Chrome releases implicit touch pointer capture before emitting touchend.
    const captureRelease = new Event('lostpointercapture', { bubbles: true })
    Object.defineProperty(captureRelease, 'pointerId', { value: 7 })
    fireEvent(task, captureRelease)
    touch(task, 'touchEnd', 30, 100)
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Remove task context' })).toBeVisible()
    expect(requests).toHaveLength(0)
    fireEvent.click(task)
    expect(task).toHaveAttribute('aria-expanded', 'true')
  })
  it('leaves a horizontally scrollable direction native and provides a visible keyboard alternative', () => {
    const { container } = mount(), task = card(container), workspace = container.querySelector<HTMLElement>('.ov-workspace')!
    workspace.style.overflowX = 'auto'
    Object.defineProperty(workspace, 'scrollWidth', { configurable: true, value: 700 })
    Object.defineProperty(workspace, 'clientWidth', { configurable: true, value: 300 })
    touch(task, 'touchStart'); touch(task, 'touchMove', 20, 100); touch(task, 'touchEnd')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(task.parentElement!).getByRole('button', { name: 'Ask about this item' }))
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('')
  })
  it('submits the canonical card ID only after review, shows Sent, then survives a second mount', async () => {
    const first = mount()
    const task = card(first.container)
    touch(task, 'touchStart'); touch(task, 'touchMove', 30, 100); touch(task, 'touchEnd')
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'What is the blocker?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requests).toMatchObject([{ card_id: fixtureId(1), question: 'What is the blocker?', view: { scene: 'overview' } }])
    expect(requests[0]).not.toHaveProperty('owner')
    expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('Sent')
    first.unmount(); mount()
    await waitFor(() => expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('What is the blocker?'))
  })
  it('returns an unread answer to a hidden card, flashes it, keeps details and dismisses only to searchable history', async () => {
    records = [seed()]
    scene.cards.find(card => card.id === fixtureId(1))!.source.properties.Status!.value = 'Backlog'
    const { container } = mount()
    expect(card(container)).toBeNull()
    await waitFor(() => expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('New answer'))
    fireEvent.click(screen.getByRole('button', { name: /New answer.*Why is this waiting/ }))
    expect(card(container)).toBeVisible()
    expect(card(container)).toHaveClass('flashed')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Full answer & evidence'))
    expect(screen.getByRole('dialog')).toHaveTextContent('First Mate checked the live dependency.')
    expect(screen.getByRole('link', { name: 'Evidence' })).toHaveAttribute('href', 'https://example.test/evidence')
    fireEvent.click(screen.getByRole('button', { name: 'Back to task' }))
    await waitFor(() => expect(screen.getByLabelText('Questions for First Mate')).not.toHaveTextContent('New answer'))
    fireEvent.click(screen.getByText('Actions', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss to history' }))
    await waitFor(() => expect(within(screen.getByLabelText('Questions for First Mate')).queryByText('Why is this waiting?')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Question history' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search question history' }), { target: { value: 'dependency' } })
    expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('Why is this waiting?')
    expect(requests).toHaveLength(0)
  })
  it('does not apply a hidden history search to active questions', async () => {
    const archived = { ...seed(), question: 'Archived deployment', dismissed_at: new Date().toISOString() }
    records = [archived, seed()]
    mount()
    const desk = screen.getByLabelText('Questions for First Mate')
    await waitFor(() => expect(desk).toHaveTextContent('Why is this waiting?'))
    fireEvent.click(screen.getByRole('button', { name: 'Question history' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search question history' }), { target: { value: 'deployment' } })
    expect(desk).toHaveTextContent('Archived deployment')
    expect(desk).not.toHaveTextContent('Why is this waiting?')
    fireEvent.click(screen.getByRole('button', { name: 'Back to questions' }))
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(desk).toHaveTextContent('Why is this waiting?')
    expect(desk).toHaveTextContent('New answer')
    expect(desk).not.toHaveTextContent('Archived deployment')
  })
  it.each([
    ['compact', false, 'search'], ['compact', true, 'search'],
    ['detailed', false, 'search'], ['detailed', true, 'search'],
    ['compact', false, 'donut'], ['compact', true, 'donut'],
    ['detailed', false, 'donut'], ['detailed', true, 'donut'],
  ] as const)('reveals an excluded answer anchor in %s, history=%s, filter=%s', async (density, history, filter) => {
    records = [{ ...seed(), dismissed_at: history ? new Date().toISOString() : null }]
    localStorage.setItem('tinstar.overview.density', density)
    const { container } = mount()
    await waitFor(() => expect(screen.getByLabelText('Questions for First Mate')).toBeTruthy())
    if (filter === 'search') {
      fireEvent.click(screen.getByRole('button', { name: 'Smart Search (Ctrl or Command K)' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Find names, IDs and text' }), { target: { value: 'no-such-anchor-xyz' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: /^Cards statuses:/ }))
      fireEvent.click(within(screen.getByRole('region', { name: 'Cards statuses' })).getByRole('button', { name: /Waiting For/ }))
    }
    expect(card(container)).toBeNull()
    const before = JSON.parse(localStorage.getItem(preferencesKey)!)
    const visibleBefore = [...container.querySelectorAll<HTMLElement>('.ov-card')].map(card => card.dataset.entityId)
    if (history) fireEvent.click(screen.getByRole('button', { name: 'Question history' }))
    const answer = await screen.findByRole('button', { name: /New answer.*Why is this waiting/ })
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    fireEvent.click(answer)
    expect(card(container)).toBeVisible()
    expect(card(container)).toHaveClass('flashed')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    const after = JSON.parse(localStorage.getItem(preferencesKey)!)
    expect(after).toEqual(before)
    expect([...container.querySelectorAll<HTMLElement>('.ov-card')].map(card => card.dataset.entityId).filter(id => id !== fixtureId(1))).toEqual(visibleBefore)
    expect(screen.queryByRole('link', { name: 'Open the source task' })).toBeNull()
  })
  it('offers the original source when a retained card is trashed', async () => {
    records = [seed()]
    scene.cards.find(card => card.id === fixtureId(1))!.source.in_trash = true
    const { container } = mount()
    fireEvent.click(await screen.findByRole('button', { name: /New answer.*Why is this waiting/ }))
    expect(card(container)).toBeNull()
    expect(screen.getByRole('link', { name: 'Open the source task' })).toHaveAttribute('href', records[0]!.context.anchor.url)
  })
  it('shows the original source when its card is missing and keeps follow-ups correlated', async () => {
    const original = seed(); records = [original]; scene.cards = scene.cards.filter(card => card.id !== fixtureId(1))
    mount()
    await waitFor(() => expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('New answer'))
    fireEvent.click(screen.getByRole('button', { name: /New answer.*Why is this waiting/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent('no longer on the floor')
    expect(screen.getByRole('link', { name: 'Open the source task' })).toHaveAttribute('href', original.context.anchor.url)
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'What evidence changed?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
    await waitFor(() => expect(requests[0]).toMatchObject({ follow_up_to: original.request_id, card_id: fixtureId(1) }))
  })
})

it.each([
  ['.ov-check', 'next_check_in', 'Why is this overdue?'],
  ['.ov-task-status', 'status', 'Why is this task in this status? What is happening now?'],
  ['.ov-context-field[title^="Waiting For:"]', 'waiting_for', "What's preventing this from moving forward?"],
  ['.ov-owner', 'owner', 'What is this owner doing on the task?'],
  ['.ov-priority', 'priority', 'Why does this task have this priority?'],
  ['.ov-age', 'last_edited', 'What changed in the last edit?'],
  ['strong', 'title', "What's the current situation with this task?"],
] as const)('right-click %s seeds an editable draft and exact typed field without sending', async (selector, field, draft) => {
  const source = scene.cards.find(card => card.id === fixtureId(1))!
  source.source.properties.Priority = { id: 'priority', type: 'select', value: 'Medium', hasMore: false }
  source.source.properties['Next check-in'] = { id: 'check', type: 'date', value: { start: '2026-11-05T12:00:00Z' }, hasMore: false }
  source.source.properties['Waiting For'] = { id: 'waiting', type: 'rich_text', value: 'Review capacity', hasMore: false }
  const { container } = mount(), task = card(container)
  fireEvent.click(task)
  const clicked = task.querySelector(selector)!
  expect(clicked).toBeTruthy()
  const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  fireEvent(clicked, contextMenu)
  expect(contextMenu.defaultPrevented).toBe(true)
  const question = screen.getByRole('textbox', { name: 'Question' })
  expect(question).toHaveValue(draft)
  expect(question).toHaveFocus()
  expect(requests).toHaveLength(0)
  expect(task).toHaveAttribute('aria-expanded', 'true')
  fireEvent.change(question, { target: { value: draft + ' Please explain.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  const expectedValue = field === 'last_edited' ? source.source.last_edited_time : field === 'title' ? source.source.properties.Name!.value : field === 'next_check_in' ? JSON.stringify(source.source.properties['Next check-in']!.value) : field === 'waiting_for' ? 'Review capacity' : source.source.properties[{ status: 'Status', owner: 'Owner', priority: 'Priority' }[field]!]!.value
  // Next check-in uses the same typed property formatter as the floor; the raw
  // date object is represented by its start/end values rather than DOM text.
  if (field !== 'next_check_in') expect(requests[0]!.field_value).toEqual(expectedValue)
  else expect(requests[0]!.field_value).toContain('2026')
  expect(requests[0]).toMatchObject({ card_id: fixtureId(1), field_key: field, question: draft + ' Please explain.' })
})

it('offers blank Ask for collapsed card and worker identities without expanding either', async () => {
  const { container } = mount(), task = card(container)
  fireEvent.click(within(task.parentElement!).getByRole('button', { name: 'Ask about this item' }))
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('')
  expect(task).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(screen.getByRole('button', { name: 'Close question' }))
  const worker = container.querySelector<HTMLElement>('.ov-execution')!
  fireEvent.click(within(worker.parentElement!).getByRole('button', { name: 'Ask about this item' }))
  const question = screen.getByRole('textbox', { name: 'Question' })
  expect(question).toHaveValue('')
  fireEvent.change(question, { target: { value: 'What is this worker doing?' } })
  fireEvent.keyDown(question, { key: 'Enter', shiftKey: true })
  expect(requests).toHaveLength(0)
  fireEvent.keyDown(question, { key: 'Enter' })
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: { kind: 'execution', id: worker.dataset.entityId } })
  expect(requests[0]).not.toHaveProperty('card_id')
})

it('right-click background stays blank and outside/link context menus stay native', () => {
  const { container } = mount(), task = card(container)
  const outside = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  fireEvent(screen.getByRole('heading', { name: 'Your desk' }), outside)
  expect(outside.defaultPrevented).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.contextMenu(task)
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('')
  const dialog = screen.getByRole('dialog')
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(within(task.parentElement!).getByRole('button', { name: 'Open in Inspector' }))
  const link = screen.getByRole('link', { name: 'Open Notion card ↗' })
  const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  fireEvent(link, native)
  expect(native.defaultPrevented).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('right-click relationship carries its canonical claim identity, with keyboard and blank icon alternatives', async () => {
  const { container } = mount()
  const line = container.querySelector<SVGPathElement>('.ov-relationship-hit')!
  expect(line).toBeTruthy()
  fireEvent.contextMenu(line)
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('How are these two items related?')
  expect(requests).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: { kind: 'claim', id: line.dataset.claimId }, field_key: 'relationship' })
  fireEvent.keyDown(line, { key: 'Enter' })
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('How are these two items related?')
})

it('Desk starts with records and omits intro chrome; history dismissal is a secondary action', async () => {
  records = [seed()]
  mount()
  const desk = screen.getByLabelText('Your desk')
  await waitFor(() => expect(desk).toHaveTextContent('Why is this waiting?'))
  expect(desk.querySelector('.ask-desk')?.previousElementSibling).toBeNull()
  for (const text of ['No verified Notion card ready.', 'First Mate requests', 'Questions', 'Ask about a task']) expect(within(desk).queryByText(text)).toBeNull()
  expect(within(desk).queryByText(/Later & needs verification/)).toBeNull()
  expect(within(desk).getByText('Review is pending')).toBeVisible()
  expect(within(desk).getByText('Captured task')).toBeVisible()
  expect(within(desk).getByText(/New answer/)).toBeVisible()
  expect(within(desk).getByRole('button', { name: 'Dismiss to history' })).not.toBeVisible()
  fireEvent.click(within(desk).getByText('Actions', { selector: 'summary' }))
  expect(within(desk).getByRole('button', { name: 'Dismiss to history' })).toBeVisible()
})

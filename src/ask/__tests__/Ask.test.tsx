import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Overview } from '../../../test-fixtures/reconciliation/Overview'
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
        row.context.anchor.page_id = body.target?.kind === 'execution' ? body.target.id : body.target?.kind === 'claim' ? scene.claims.find(claim => claim.id === body.target.id)!.cardId : body.card_id
        if (body.target) { row.context.target = body.target; row.context.anchor.kind = body.target.kind === 'execution' ? 'worker' : 'link' }
        if (body.element) row.context.element = body.element
        if (body.field_key) { row.context.field_key = body.field_key; row.context.field_value = body.field_value }
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
    expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('First Mate checked the live dependency.')
    expect(screen.getByRole('link', { name: /Evidence/ })).toHaveAttribute('href', 'https://example.test/evidence')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse answer' }))
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
    if (filter === 'search') localStorage.setItem(preferencesKey, JSON.stringify({ search: { query: 'no-such-anchor-xyz', patterns: [], facets: [] } }))
    const { container } = mount()
    await waitFor(() => expect(screen.getByLabelText('Questions for First Mate')).toBeTruthy())
    if (filter === 'donut') {
      fireEvent.click(screen.getByRole('button', { name: /^Cards statuses:/ }))
      fireEvent.click(within(screen.getByRole('region', { name: 'Cards statuses' })).getByRole('button', { name: /Waiting For/ }))
    }
    expect(card(container)).toBeNull()
    const before = JSON.parse(localStorage.getItem(preferencesKey)!)
    if (history) fireEvent.click(screen.getByRole('button', { name: 'Question history' }))
    const answer = await screen.findByRole('button', { name: /New answer.*Why is this waiting/ })
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    fireEvent.click(answer)
    expect(card(container)).toBeVisible()
    expect(card(container)).toHaveClass('flashed')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    const after = JSON.parse(localStorage.getItem(preferencesKey)!)
    expect(after).toEqual(before)
    // Answer anchors use the shared focus lens: retain the target and its
    // direct counterparts while leaving persisted filters unchanged.
    expect([...new Set([...container.querySelectorAll<HTMLElement>('.ov-card')].map(card => card.dataset.entityId))]).toEqual([fixtureId(1)])
    expect(screen.queryByText('The original task is no longer on the floor.')).toBeNull()
  })
  it('offers the original source when a retained card is trashed', async () => {
    records = [seed()]
    scene.cards.find(card => card.id === fixtureId(1))!.source.in_trash = true
    const { container } = mount()
    fireEvent.click(await screen.findByRole('button', { name: /New answer.*Why is this waiting/ }))
    expect(card(container)).toBeNull()
    expect(screen.getByRole('link', { name: /Open originating source/ })).toHaveAttribute('href', records[0]!.context.anchor.url)
  })
  it('shows the original source when its card is missing and keeps follow-ups correlated', async () => {
    const original = seed(); records = [original]; scene.cards = scene.cards.filter(card => card.id !== fixtureId(1))
    mount()
    await waitFor(() => expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('New answer'))
    fireEvent.click(screen.getByRole('button', { name: /New answer.*Why is this waiting/ }))
    expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('no longer on the floor')
    expect(screen.getByRole('link', { name: /Open originating source/ })).toHaveAttribute('href', original.context.anchor.url)
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
  for (const text of ['No verified Notion card ready.', 'First Mate requests', 'Questions', 'Ask about a task']) expect(within(desk).queryByText(text)).toBeNull()
  expect(within(desk).queryByText(/Later & needs verification/)).toBeNull()
  expect(within(desk).getByText('Review is pending')).toBeVisible()
  expect(within(desk).getByText('Captured task')).toBeVisible()
  expect(within(desk).getByText(/New answer/)).toBeVisible()
  expect(within(desk).getByRole('button', { name: 'Dismiss to history' })).not.toBeVisible()
  fireEvent.click(within(desk).getByText('Actions', { selector: 'summary' }))
  expect(within(desk).getByRole('button', { name: 'Dismiss to history' })).toBeVisible()
})

it('returns a retained worker answer after remount to its exact filtered execution and highlights it', async () => {
  const worker = scene.executions.find(worker => worker.identity.task_id === 'linked-worker')!
  const answer = seed()
  answer.context.target = { kind: 'execution', id: worker.id }
  answer.context.anchor = { ...answer.context.anchor, kind: 'worker', page_id: worker.id, label: 'Captured worker', url: null }
  records = [answer]
  const first = mount(); first.unmount()
  const { container } = mount()
  fireEvent.click(screen.getByRole('button', { name: /^Workers: Blocked/ }))
  expect([...container.querySelectorAll<HTMLElement>('.ov-execution')].find(el => el.dataset.entityId === worker.id)).toBeUndefined()
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*Why is this waiting/ }))
  const returned = [...container.querySelectorAll<HTMLElement>('.ov-execution')].find(el => el.dataset.entityId === worker.id)!
  expect(returned).toHaveClass('flashed')
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('Captured worker')
  fireEvent.click(screen.getByRole('button', { name: 'Follow up' }))
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('')
  fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'What has changed?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(requests[0]).toMatchObject({ target: { kind: 'execution', id: worker.id }, follow_up_to: answer.request_id }))
})

it('opens blank Ask for a relationship from its Inspector connection control', async () => {
  const { container } = mount(), task = card(container)
  fireEvent.click(within(task.parentElement!).getByRole('button', { name: 'Open in Inspector' }))
  const relationship = screen.getByLabelText('Inspector').querySelector('.ov-related')!
  fireEvent.click(within(relationship as HTMLElement).getByRole('button', { name: 'Ask about this item' }))
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('')
  expect(screen.getByRole('dialog')).toHaveTextContent('Relationship')
  fireEvent.change(screen.getByRole('textbox', { name: 'Question' }), { target: { value: 'Explain this relationship.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(requests[0]).toMatchObject({ target: { kind: 'claim', id: scene.claims.find(claim => claim.cardId === fixtureId(1))!.id } }))
})

it('hides Ask on historical Inspector connections while keeping supported connections actionable', () => {
  const current = scene.claims.find(claim => claim.cardId === fixtureId(1))!
  scene.claimHistory.push({ ...current, id: 'retained-history', state: 'historical' })
  const { container } = mount(), task = card(container)
  fireEvent.click(within(task.parentElement!).getByRole('button', { name: 'Open in Inspector' }))
  const connections = [...screen.getByLabelText('Inspector').querySelectorAll<HTMLElement>('.ov-related')]
  const history = connections.find(connection => within(connection).queryByText('History'))!
  expect(history).toBeTruthy()
  expect(within(history).queryByRole('button', { name: 'Ask about this item' })).toBeNull()
  expect(within(connections.find(connection => within(connection).queryByText('Linked'))!).getByRole('button', { name: 'Ask about this item' })).toBeVisible()
})

it.each(['detailed', 'compact'] as const)('returns a retained claim answer to only its relationship in %s', async density => {
  localStorage.setItem('tinstar.overview.density', density)
  const claims = scene.claims.filter(claim => claim.cardId === fixtureId(1))
  expect(claims.length).toBeGreaterThan(1)
  const original = seed()
  original.context.target = { kind: 'claim', id: claims[0]!.id }
  original.context.anchor.kind = 'link'
  records = [original]
  const { container } = mount()
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*Why is this waiting/ }))
  const lines = [...container.querySelectorAll('.ov-line.flashed')]
  expect(lines).toHaveLength(1)
  expect(lines[0]!.parentElement!.querySelector('.ov-relationship-hit')).toHaveAttribute('data-claim-id', claims[0]!.id)
  expect(screen.queryByText('The original task is no longer on the floor.')).toBeNull()
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
})

it('returns an unverified Detailed relationship answer after reload and filtering', async () => {
  localStorage.setItem(preferencesKey, JSON.stringify({ organizer: { outer: 'none', inner: 'none', order: 'checkIn', direction: 'asc' } }))
  localStorage.setItem('tinstar.overview.density', 'detailed')
  const claim = scene.claims.find(claim => claim.cardId === fixtureId(1))!
  scene.claims = scene.claims.filter(other => other.cardId !== claim.cardId || other.id === claim.id)
  claim.verification = 'unverified'
  const first = mount()
  const line = [...first.container.querySelectorAll<SVGPathElement>('.ov-relationship-hit')].find(line => line.dataset.claimId === claim.id)!
  fireEvent.contextMenu(line)
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }))
  await waitFor(() => expect(records).toHaveLength(1))
  records[0] = { ...records[0]!, status: 'answered', reply: seed().reply }
  first.unmount()
  const { container } = mount()
  fireEvent.click(screen.getByRole('button', { name: /^Cards: Waiting For/ }))
  expect(card(container)).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*How are these two items related/ }))
  expect(card(container)).toBeVisible()
  const returned = [...container.querySelectorAll<SVGPathElement>('.ov-relationship-hit')].find(line => line.dataset.claimId === claim.id)!
  expect(returned.previousElementSibling).toHaveClass('flashed')
  expect(container.querySelectorAll('.ov-line.flashed')).toHaveLength(1)
  expect(screen.queryByText('The original task is no longer on the floor.')).toBeNull()
})

it('reports a missing relationship even when its card remains available', async () => {
  const original = seed()
  original.context.target = { kind: 'claim', id: 'missing-claim' }
  original.context.anchor.kind = 'link'
  records = [original]
  const { container } = mount()
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*Why is this waiting/ }))
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('no longer on the floor')
  expect(container.querySelectorAll('.ov-line.flashed')).toHaveLength(0)
})


it('groups correlated follow-ups into one inline thread and switches independent conversations in one click', async () => {
  const first = seed(), followUp = { ...seed(), conversation_id: first.conversation_id, question: 'What changed next?', created_at: '2099-01-01T00:00:00Z' }
  const neighbor = { ...seed(), question: 'Independent investigation' }
  records = [first, followUp, neighbor]
  mount()
  const desk = screen.getByLabelText('Questions for First Mate')
  await waitFor(() => expect(desk.querySelectorAll('[data-ask-id]')).toHaveLength(2))
  fireEvent.click(within(desk).getByRole('button', { name: /New answer.*Why is this waiting/ }))
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('What changed next?')
  expect(within(desk).getByRole('button', { name: /New answer.*Independent investigation/ })).toBeVisible()
  fireEvent.click(within(desk).getByRole('button', { name: /New answer.*Independent investigation/ }))
  expect(screen.getAllByRole('region', { name: /Answer thread/ })).toHaveLength(1)
  expect(screen.getByRole('region', { name: /Answer thread/ })).toHaveTextContent('Independent investigation')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Follow up' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close question' }))
  expect(screen.getByRole('region', { name: /Answer thread/ })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse answer' }))
  expect(within(desk).getByRole('button', { name: /Independent investigation/ })).toHaveFocus()
})


it.each(['failed', 'sent', 'delivered'] as const)('keeps an earlier %s turn visible and independently retryable after a follow-up answers', async status => {
  const first = { ...seed(), status, reply: null, error: status === 'failed' ? 'Delivery failed' : null, created_at: '2020-01-01T00:00:00Z' }
  const followUp = { ...seed(), conversation_id: first.conversation_id, question: 'Answered follow-up', created_at: '2020-01-02T00:00:00Z' }
  const neighbor = { ...seed(), question: 'Neighbor question' }
  records = [first, followUp, neighbor]
  mount()
  const desk = screen.getByLabelText('Questions for First Mate')
  const preview = await within(desk).findByRole('button', { name: /New answer.*Why is this waiting/ })
  expect(preview).toHaveTextContent(status === 'failed' ? '1 failed' : '1 pending')
  const retryName = `Retry delivery: ${first.question}`
  expect(within(desk).getAllByRole('button', { name: retryName })).toHaveLength(1)
  fireEvent.click(preview)
  const thread = screen.getByRole('region', { name: /Answer thread/ })
  const earlier = within(thread).getByRole('region', { name: `Question: ${first.question}` })
  expect(earlier).toHaveTextContent(status === 'failed' ? 'Delivery failed' : status === 'sent' ? 'Sent' : 'Delivered')
  expect(earlier).toHaveTextContent('taking longer')
  expect(within(desk).getAllByRole('button', { name: retryName })).toHaveLength(1)
  expect(within(thread).queryByRole('button', { name: 'Retry delivery: Answered follow-up' })).toBeNull()
  fireEvent.click(within(earlier).getByRole('button', { name: retryName }))
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/ask/requests/${first.request_id}/retry`, expect.anything()))
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === `/api/ask/requests/${followUp.request_id}/retry`)).toBe(false)
  expect(first.conversation_id).toBe(followUp.conversation_id)
  expect(within(desk).getByRole('button', { name: /Neighbor question/ })).toBeVisible()
})


it('keeps independently pending turns recoverable in one conversation', async () => {
  const first = { ...seed(), status: 'sent' as const, reply: null, question: 'First pending question', created_at: '2020-01-01T00:00:00Z' }
  const second = { ...seed(), conversation_id: first.conversation_id, status: 'delivered' as const, reply: null, question: 'Second pending question', created_at: '2020-01-02T00:00:00Z' }
  records = [first, second]
  mount()
  const preview = await screen.findByRole('button', { name: /2 pending.*First pending question/ })
  fireEvent.click(preview)
  for (const turn of [first, second]) {
    const retry = screen.getByRole('button', { name: `Retry delivery: ${turn.question}` })
    fireEvent.click(retry)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/ask/requests/${turn.request_id}/retry`, expect.anything()))
  }
  fireEvent.click(screen.getByRole('button', { name: 'Collapse answer' }))
  expect(screen.getAllByRole('button', { name: /Retry delivery:/ })).toHaveLength(2)
})

it.each(['swipe', 'right-click', 'icon', 'Desk follow-up'])('supports Enter, Shift+Enter, IME and Escape in the %s composer', async entry => {
  if (entry === 'Desk follow-up') records = [seed()]
  const { container } = mount(), task = card(container)
  if (entry === 'swipe') { touch(task, 'touchStart'); touch(task, 'touchMove', 30, 100); touch(task, 'touchEnd') }
  if (entry === 'right-click') { fireEvent.click(task); fireEvent.contextMenu(task.querySelector('.ov-task-status')!) }
  if (entry === 'icon') fireEvent.click(within(task.parentElement!).getByRole('button', { name: 'Ask about this item' }))
  if (entry === 'Desk follow-up') {
    fireEvent.click(await screen.findByRole('button', { name: /New answer.*Why is this waiting/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' }))
  }
  const question = screen.getByRole('textbox', { name: 'Question' })
  fireEvent.change(question, { target: { value: 'What needs attention?\nInclude the evidence.' } })
  fireEvent.keyDown(question, { key: 'Enter', shiftKey: true })
  fireEvent.keyDown(question, { key: 'Enter', isComposing: true })
  expect(requests).toHaveLength(0)
  fireEvent.keyDown(question, { key: 'Enter' })
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ question: 'What needs attention?\nInclude the evidence.' })
  if (entry === 'Desk follow-up') expect(requests[0]).toHaveProperty('follow_up_to')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(within(task.parentElement!).getByRole('button', { name: 'Ask about this item' }))
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Question' }), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('sends an unedited overdue suggestion with the displayed element and original item linkage', async () => {
  const source = scene.cards.find(card => card.id === fixtureId(1))!
  source.source.properties['Next check-in'] = { id: 'check', type: 'date', value: { start: '2026-11-05T15:00:00Z' }, hasMore: false }
  const { container } = mount(), task = card(container)
  fireEvent.click(task)
  fireEvent.mouseOver(task.querySelector('.ov-check')!)
  fireEvent.click(screen.getByRole('button', { name: /^Ask about Overdue/ }))
  expect(screen.getByLabelText('Element context')).toHaveTextContent('Next check-in Nov 5, 10:00 AM ET')
  expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('Why is this overdue?')
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Question' }), { key: 'Enter' })
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ card_id: fixtureId(1), field_key: 'next_check_in', field_value: '2026-11-05T15:00:00Z', element: { field_name: 'next_check_in', type: 'overdue', value: '2026-11-05T15:00:00Z' } })
  expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('Sent')
  expect(records[0]!.context.anchor.page_id).toBe(fixtureId(1))
})

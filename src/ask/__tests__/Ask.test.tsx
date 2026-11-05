import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Overview } from '../../reconciliation/Overview'
import { fixtureId, fixtureQueue, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
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
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask about a task' })[0]!)
    expect(screen.getByRole('combobox', { name: 'Task context' })).toBeVisible()
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
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss to history' }))
    await waitFor(() => expect(within(screen.getByLabelText('Questions for First Mate')).queryByText('Why is this waiting?')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Question history' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search question history' }), { target: { value: 'dependency' } })
    expect(screen.getByLabelText('Questions for First Mate')).toHaveTextContent('Why is this waiting?')
    expect(requests).toHaveLength(0)
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fixtureId, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { Overview } from '../../../test-fixtures/reconciliation/Overview'
import { apiFetch } from '../../apiClient'
import { overviewDensityKey } from '../overviewDensity'
import type { FloorScene } from '../presentation'

const observed = vi.hoisted(() => ({ scene: null as unknown, refresh: undefined as (() => Promise<void>) | undefined }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now(), refreshAfterMutation: () => observed.refresh?.() ?? Promise.resolve() }) }))
vi.mock('../useDeskQueue', () => ({ useDeskQueue: () => ({ queue: null, error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
vi.mock('../../apiClient', () => ({ apiFetch: vi.fn(() => new Promise(() => {})) }))

let scene: FloorScene
beforeEach(() => {
  localStorage.clear()
  observed.refresh = undefined
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}))
  scene = fixtureScene()
  observed.scene = scene
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { vi.useRealTimers(); cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const mount = (density: 'compact' | 'detailed') => {
  localStorage.setItem(overviewDensityKey, density)
  return render(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
}
const endpoint = (container: HTMLElement, kind: 'worker' | 'task') => {
  const id = kind === 'worker' ? scene.executions.find(worker => worker.identity.task_id === 'linked-worker')!.id : fixtureId(1)
  return [...container.querySelectorAll<HTMLElement>(kind === 'worker' ? '.ov-execution' : '.ov-card')].find(el => el.dataset.entityId === id)!
}
const inspectorButton = (card: HTMLElement) => within(card.parentElement!).getByRole('button', { name: 'Open in Inspector' })
const heading = () => within(screen.getByLabelText('Inspector')).getByRole('heading', { level: 3 })
const activate = (button: HTMLElement, key: 'click' | 'Enter' | ' ') => {
  if (key === 'click') fireEvent.click(button)
  else fireEvent.keyDown(button, { key })
}

describe('Open in Inspector', () => {
  it.each([
    ['compact', 'worker', 'linked worker'],
    ['compact', 'task', 'Build live reconciliation'],
    ['detailed', 'worker', 'linked worker'],
    ['detailed', 'task', 'Build live reconciliation'],
  ] as const)('%s %s click, Enter, and Space open that record and leave expansion unchanged', (density, kind, title) => {
    const { container } = mount(density)
    const card = endpoint(container, kind)
    if (density === 'compact') {
      expect(inspectorButton(card)).toBeTruthy()
      fireEvent.click(card)
    }
    const expanded = card.getAttribute('aria-expanded')
    const hint = card.querySelector('.ov-expansion-hint')?.textContent ?? null
    for (const key of ['click', 'Enter', ' '] as const) {
      activate(inspectorButton(card), key)
      expect(heading()).toHaveTextContent(title)
      expect(card.getAttribute('aria-expanded')).toBe(expanded)
      expect(card.querySelector('.ov-expansion-hint')?.textContent ?? null).toBe(hint)
      fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }))
      expect(screen.queryByLabelText('Inspector')).toBeNull()
    }
  })

  it.each(['worker', 'task'] as const)('reanchors Detailed connections when a %s resizes within an unchanged group', kind => {
    const observers = new Set<{ elements: Set<Element>; notify: () => void }>()
    vi.stubGlobal('ResizeObserver', class {
      record: { elements: Set<Element>; notify: () => void }
      constructor(notify: () => void) {
        this.record = { elements: new Set(), notify }
        observers.add(this.record)
      }
      observe(element: Element) { this.record.elements.add(element) }
      disconnect() { observers.delete(this.record) }
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isEndpoint = this.matches('.ov-execution, .ov-card')
      const left = this.matches('.ov-card') ? 456 : 0
      const height = isEndpoint ? this.getAttribute('aria-expanded') === 'true' ? 133 : 29 : 200
      const top = isEndpoint ? 40 : 0
      return { x: left, y: top, left, top, width: 400, height, right: left + 400, bottom: top + height, toJSON() {} }
    })
    const workerId = scene.executions.find(worker => worker.identity.task_id === 'linked-worker')!.id
    scene.claims = scene.claims.filter(claim => claim.executionId === workerId && claim.cardId === fixtureId(1))
    const { container } = mount('detailed')
    const item = endpoint(container, kind)
    const group = item.closest('.ov-group')!
    const edge = () => group.querySelector('.ov-connections path')!
    const initial = 'M400,106.5 C430.8,106.5 425.2,106.5 456,106.5'
    expect(edge()).toHaveAttribute('d', initial)
    for (const expanded of [false, true]) {
      fireEvent.click(item)
      act(() => observers.forEach(observer => {
        if (observer.elements.has(item)) observer.notify()
      }))
      expect(item).toHaveAttribute('aria-expanded', String(expanded))
      const workerY = !expanded && kind === 'worker' ? 54.5 : 106.5
      const taskY = !expanded && kind === 'task' ? 54.5 : 106.5
      expect(edge()).toHaveAttribute('d', `M400,${workerY} C430.8,${workerY} 425.2,${taskY} 456,${taskY}`)
      expect(screen.queryByLabelText('Inspector')).toBeNull()
    }
  })

  it.each([
    ['compact', 'worker'], ['compact', 'task'],
    ['detailed', 'worker'], ['detailed', 'task'],
  ] as const)('%s body click and keyboard toggle a %s without opening Inspector', (density, kind) => {
    const { container } = mount(density)
    const card = endpoint(container, kind)
    let expanded = density === 'detailed'
    for (const key of ['click', 'Enter', ' '] as const) {
      activate(card, key)
      expanded = !expanded
      expect(card).toHaveAttribute('aria-expanded', String(expanded))
      expect(screen.queryByLabelText('Inspector')).toBeNull()
      expect(inspectorButton(card)).toBeTruthy()
    }
  })

})

describe('Copy Notion link', () => {
  const url = () => `https://www.notion.so/${fixtureId(1)}`
  const installClipboard = (writeText: ReturnType<typeof vi.fn>) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  }
  async function openTask() {
    const { container } = mount('compact')
    const card = endpoint(container, 'task')
    fireEvent.click(card)
    fireEvent.click(inspectorButton(card))
    expect(screen.getByRole('link', { name: 'Open Notion card ↗' })).toHaveAttribute('href', url())
    return card
  }

  it('copies the card URL and shows Copied without collapsing the row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    const card = await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url()))
    expect(screen.getByText('Copied')).toBeTruthy()
    expect(card).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Open Notion card ↗' })).toHaveAttribute('href', url())
  })

  it.each(['Enter', ' '] as const)('copies from the keyboard with %s', async key => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    await openTask()
    const button = screen.getByRole('button', { name: 'Copy link' })
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.keyDown(button, { key })
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url()))
    expect(screen.getByText('Copied')).toBeTruthy()
  })

  it('uses a selection fallback when clipboard write is refused', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    installClipboard(writeText)
    let copied = ''
    Object.defineProperty(document, 'execCommand', { configurable: true, value: (command: string) => {
      if (command === 'copy') copied = document.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value ?? ''
      return true
    } })
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith(url())
    expect(copied).toBe(url())
  })

  it.each(['success', 'refused', 'throws'] as const)('restores focus and removes the fallback textarea when copy %s', async outcome => {
    installClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => {
      document.querySelector<HTMLTextAreaElement>('textarea[readonly]')!.focus()
      if (outcome === 'throws') throw new Error('copy failed')
      return outcome === 'success'
    } })
    await openTask()
    const button = screen.getByRole('button', { name: 'Copy link' })
    button.focus()
    fireEvent.keyDown(button, { key: 'Enter' })
    await waitFor(() => expect(button).toHaveFocus())
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector<HTMLTextAreaElement>('textarea[readonly]')).toBeNull()
    expect(button).toHaveFocus()
    expect(screen.queryByText('Copied') !== null).toBe(outcome === 'success')
  })

  it('clears the Copied feedback', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Copied')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1600) })
    expect(screen.queryByText('Copied')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
  })
})


it('retains the confirmed status and partial-save recovery when completion removes the card from the active view', async () => {
  localStorage.setItem(overviewDensityKey, 'detailed')
  const saved = structuredClone(scene.cards.find(card => card.id === fixtureId(1))!.source)
  saved.properties.Status!.value = 'Done'
  vi.mocked(apiFetch).mockImplementation(async path => {
    if (String(path).endsWith('/workflow')) return new Response(JSON.stringify({ ok: true, data: { outcome: 'partially-saved', message: 'Status saved; note failed', operation_id: 'test', saved_fields: ['Status'], card: saved } }))
    return new Response(JSON.stringify({ ok: true, data: { outcome: 'available', blocks: [] } }))
  })
  const view = <Overview workers={[]} messages={[]} submit={vi.fn()} />
  const mounted = render(view)
  observed.refresh = async () => {
    // Let the result render while the old scene is still on screen, as happens
    // during the real shared refresh. It must not replace confirmed readback.
    await new Promise(resolve => setTimeout(resolve, 0))
    observed.scene = { ...scene, generatedAt: new Date(Date.now() + 1000).toISOString(), cards: scene.cards.filter(card => card.id !== saved.id) }
    mounted.rerender(<Overview workers={[]} messages={[]} submit={vi.fn()} />)
  }
  fireEvent.click(inspectorButton(endpoint(mounted.container, 'task')))
  const inspector = screen.getByLabelText('Inspector')
  fireEvent.change(within(inspector).getByLabelText('Operation'), { target: { value: 'complete' } })
  fireEvent.change(within(inspector).getByLabelText('Supported disposition'), { target: { value: 'Owner accepted the required behavior' } })
  fireEvent.change(within(inspector).getByLabelText('Completion evidence'), { target: { value: 'Acceptance receipt in fixture' } })
  fireEvent.click(within(inspector).getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(within(inspector).getByText(/Outside the current view/)).toBeTruthy())
  expect(within(inspector).getByText('Done')).toBeTruthy()
  expect(within(inspector).getByText(/Partially saved. Status saved; note failed/)).toBeTruthy()
  expect(within(inspector).getByRole('button', { name: 'Save update' })).toBeEnabled()
})

it('keeps Inspector identity when another card save finishes and applies matching readback', async () => {
  const first = scene.cards.find(card => card.id === fixtureId(1))!
  const second = scene.cards.find(card => card.id === fixtureId(4))!
  const requests: Array<{ input: { card_id: string }; resolve: (response: Response) => void }> = []
  vi.mocked(apiFetch).mockImplementation((path, init) => {
    if (String(path).endsWith('/workflow')) return new Promise<Response>(resolve => requests.push({ ...JSON.parse(String(init?.body)), resolve }))
    return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { outcome: 'available', blocks: [] } })))
  })
  observed.refresh = vi.fn(async () => {})
  const { container } = mount('detailed')
  const open = (id: string) => {
    const row = [...container.querySelectorAll<HTMLElement>('.ov-card')].find(element => element.dataset.entityId === id)!
    fireEvent.click(inspectorButton(row))
  }
  const finish = async (index: number, card: typeof first.source) => {
    await act(async () => requests[index]!.resolve(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', message: 'Confirmed', saved_fields: ['Name', 'Status'], card } }))))
    await waitFor(() => expect(observed.refresh).toHaveBeenCalledTimes(index + 1))
  }
  open(first.id)
  fireEvent.click(within(screen.getByLabelText('Inspector')).getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]!.input.card_id).toBe(first.id)
  open(second.id)
  const savedFirst = structuredClone(first.source)
  savedFirst.properties.Name!.value = 'Confirmed first card'
  savedFirst.properties.Status!.value = 'Done'
  savedFirst.url = 'https://www.notion.so/confirmed-first'
  await finish(0, savedFirst)
  const inspector = screen.getByLabelText('Inspector')
  expect(heading()).toHaveTextContent(String(second.source.properties.Name!.value))
  expect(within(inspector).getByText('Waiting For', { exact: true, selector: 'dd' })).toBeTruthy()
  expect(within(inspector).getByRole('link', { name: 'Open Notion card ↗' })).toHaveAttribute('href', second.source.url)
  fireEvent.click(within(inspector).getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]!.input.card_id).toBe(second.id)
  const savedSecond = structuredClone(second.source)
  savedSecond.properties.Name!.value = 'Confirmed second card'
  savedSecond.properties.Status!.value = 'Queued'
  savedSecond.url = 'https://www.notion.so/confirmed-second'
  await finish(1, savedSecond)
  expect(heading()).toHaveTextContent('Confirmed second card')
  expect(within(inspector).getByText('Queued', { exact: true })).toBeTruthy()
  expect(within(inspector).getByRole('link', { name: 'Open Notion card ↗' })).toHaveAttribute('href', savedSecond.url)
  open(first.id)
  expect(heading()).toHaveTextContent(String(first.source.properties.Name!.value))
  expect(screen.getByRole('link', { name: 'Open Notion card ↗' })).toHaveAttribute('href', first.source.url)
})

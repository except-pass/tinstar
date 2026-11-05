import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fixtureId, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { Overview } from '../Overview'
import { overviewDensityKey } from '../overviewDensity'
import type { FloorScene } from '../presentation'

const observed = vi.hoisted(() => ({ scene: null as unknown }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now() }) }))
vi.mock('../useDeskQueue', () => ({ useDeskQueue: () => ({ queue: null, error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
vi.mock('../../apiClient', () => ({ apiFetch: () => new Promise(() => {}) }))

let scene: FloorScene
beforeEach(() => {
  localStorage.clear()
  scene = fixtureScene()
  observed.scene = scene
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

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
      expect(card.parentElement?.querySelector('.ov-open-inspector')).toBeNull()
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

  it.each(['worker', 'task'] as const)('compact body click still toggles a %s', kind => {
    const { container } = mount('compact')
    const card = endpoint(container, kind)
    fireEvent.click(card)
    expect(card).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByLabelText('Inspector')).toBeNull()
    fireEvent.click(card)
    expect(card).toHaveAttribute('aria-expanded', 'false')
  })

  it('detailed body click still opens the Inspector', () => {
    const { container } = mount('detailed')
    const card = endpoint(container, 'task')
    expect(card.hasAttribute('aria-expanded')).toBe(false)
    fireEvent.click(card)
    expect(heading()).toHaveTextContent('Build live reconciliation')
    expect(card.hasAttribute('aria-expanded')).toBe(false)
    expect(card.classList.contains('ov-collapsed')).toBe(false)
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
      if (command === 'copy') copied = document.querySelector('textarea')?.value ?? ''
      return true
    } })
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith(url())
    expect(copied).toBe(url())
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

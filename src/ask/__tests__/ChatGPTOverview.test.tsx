import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { Overview } from '../../../test-fixtures/reconciliation/Overview'

const state = vi.hoisted(() => ({ scene: null as unknown }))
vi.mock('../../reconciliation/useFloorScene', () => ({ useFloorScene: () => ({ scene: state.scene, error: null, now: Date.now() }) }))
vi.mock('../../reconciliation/useDeskQueue', () => ({ useDeskQueue: () => ({ queue: null, error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
beforeEach(() => {
  localStorage.clear(); state.scene = fixtureScene()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('adds a work-only sibling action while retaining Ask, inspector and card expansion', async () => {
  const opened = vi.fn(), submit = vi.fn()
  vi.stubGlobal('open', opened)
  const { container } = render(<Overview workers={[]} messages={[]} submit={submit} />)
  const card = container.querySelector('.ov-card')!, frame = card.parentElement as HTMLElement
  const expanded = card.getAttribute('aria-expanded')
  const action = within(frame).getByRole('button', { name: 'Open in ChatGPT' })
  expect(action.closest('.ov-card')).toBeNull()
  expect(within(frame).getByRole('button', { name: 'Open in Inspector' })).toBeTruthy()
  expect(within(frame).getByRole('button', { name: 'Ask about this item' })).toBeTruthy()
  fireEvent.click(action)
  expect(card.getAttribute('aria-expanded')).toBe(expanded)
  expect(opened).toHaveBeenCalledTimes(1)
  expect(new URL(opened.mock.calls[0]![0]).searchParams.get('prompt')).toContain(`Work ID: ${card.getAttribute('data-entity-id')}`)
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  fireEvent.click(card)
  expect(card.getAttribute('aria-expanded')).not.toBe(expanded)
  for (const worker of container.querySelectorAll('.ov-execution')) expect(worker.parentElement?.querySelector('.chatgpt-action')).toBeNull()
  await act(async () => {})
})

import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fixtureSources, fixtureId, fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { Overview } from '../Overview'

const observed = vi.hoisted(() => ({ scene: null as unknown, error: null as string | null }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: observed.error, now: Date.now() }) }))
vi.mock('../useDeskQueue', () => ({ useDeskQueue: () => ({ queue: fixtureQueue(), error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); observed.error = null })

it.each(['queued', 'held'])('retains independently visible %s cards and keeps wait evidence in details', state => {
  const sources = fixtureSources()
  Object.assign(sources.fleet[1]!.observation.data!.backlog![0]!, { state, hold_reason: 'Awaiting review capacity', blocked_by: 'review-task', hold_until: '2026-11-05T12:00:00Z' })
  const scene = new SceneReconciler().reconcile(sources)
  observed.scene = scene
  const { container } = render(<Overview workers={[]} />)
  const card = container.querySelector(`.ov-card[data-entity-id="${fixtureId(2)}"]`)!
  expect(card.getAttribute('data-tone')).toBe('quiet')
  expect(container.querySelectorAll('.ov-worker-stack .ov-execution')).toHaveLength(5)
  expect(container.querySelectorAll('.ov-card-stack .ov-card')).toHaveLength(7)
  fireEvent.click(card)
  expect(screen.getByLabelText('Inspector').textContent).toContain('Awaiting review capacity')
  expect(screen.getByLabelText('Inspector').textContent).toContain('review-task')
  fireEvent.click(screen.getByRole('button', { name: 'Machine' }))
  expect(screen.getByLabelText('Inspector').textContent).toContain('Awaiting review capacity')
})
it('keeps both source lists useful with connectors hidden and exposes both gaps', () => {
  observed.scene = fixtureScene()
  const { container } = render(<Overview workers={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Links' }))
  expect(container.querySelectorAll('.ov-connections')).toHaveLength(0)
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(5)
  expect(container.querySelectorAll('.ov-card')).toHaveLength(7)
  fireEvent.click(screen.getByRole('button', { name: /Gaps only/ }))
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(1)
  expect(container.querySelectorAll('.ov-card')).toHaveLength(1)
  expect(container.querySelector('.ov-card')?.getAttribute('data-tone')).toBe('gap')
  expect(container.querySelector('.ov-execution')?.getAttribute('data-tone')).toBe('orphan')
})
it('retains last known lists while suspending expired gap conclusions', () => {
  observed.scene = fixtureScene()
  observed.error = 'Read failed'
  const { container } = render(<Overview workers={[]} />)
  expect(screen.getByRole('button', { name: 'Notion unavailable · Details' })).toBeVisible()
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(5)
  expect(container.querySelectorAll('.ov-card')).toHaveLength(7)
  expect(container.querySelectorAll('[data-tone="gap"], [data-tone="orphan"]')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /Gaps only/ }))
  expect(container.textContent).toContain('Gap checks suspended')
})
it('places finished and absent records in history rather than the current worker stack', () => {
  const sources = fixtureSources()
  const tasks = sources.fleet[1]!.observation.data!.tasks
  tasks[0]!.lastEventText = 'paused [at=1]: waiting on CI'
  tasks[1]!.lastEventText = 'done [at=1]: finished but window open'
  tasks[2]!.endpoint.exists = false
  observed.scene = new SceneReconciler().reconcile(sources)
  const { container } = render(<Overview workers={[]} />)
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(3)
  expect(container.querySelector('.ov-history')?.textContent).toContain('Worker history · 2')
  expect(container.querySelector('.ov-history')?.textContent).toContain('Finished')
})

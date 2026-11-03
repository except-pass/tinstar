import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fixtureSources, fixtureId } from '../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { ReconciliationFloor } from '../ReconciliationFloor'
import { applyPresentationAction, initialPresentation } from '../presentation'

const observed = vi.hoisted(() => ({ scene: null as unknown }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: null, now: Date.now() }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
afterEach(cleanup)

it.each(['queued', 'held'])('presents an expected-now card with an explicit %s backlog wait consistently', state => {
  const sources = fixtureSources()
  const entry = sources.fleet[1]!.observation.data!.backlog[0]!
  entry.state = state
  entry.hold_reason = 'Awaiting review capacity'
  entry.blocked_by = 'review-task'
  entry.hold_until = '2026-11-05T12:00:00Z'
  const scene = new SceneReconciler().reconcile(sources)
  const card = scene.cards.find(c => c.id === fixtureId(2))!
  expect(card.expectation).toBe('expected-now')
  expect(scene.findings.some(f => f.kind === 'legitimate-wait-planned' && f.cardIds.includes(card.id))).toBe(true)
  observed.scene = scene
  const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  const { container } = render(<ReconciliationFloor workers={[]} />)
  expect(container.querySelector(`[data-card-id="${card.id}"]`)).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: /Roadmap \/ waits/ })[0]!)
  const row = container.querySelector(`[data-card-id="${card.id}"]`)!
  expect(row.classList.contains('floor-planned')).toBe(true)
  expect(row.querySelector('.floor-socket')!.textContent).toContain('◷No worker required now')
  for (const detail of ['Awaiting review capacity', 'review-task', '2026-11-05T12:00:00Z']) {
    expect(row.querySelector('.floor-socket')!.textContent).toContain(detail)
  }
  fireEvent.click(row.querySelector('.floor-task')!)
  const inspector = screen.getByLabelText('Scene inspector')
  expect(inspector.textContent).not.toContain(card.expectationReason)
  for (const detail of ['Awaiting review capacity', 'review-task', '2026-11-05T12:00:00Z']) expect(inspector.textContent).toContain(detail)
  for (const arrangement of ['secondMate', 'machine', 'initiative'] as const) {
    const focused = applyPresentationAction({ ...initialPresentation(), arrangement }, { type: 'focus', target: { kind: 'card', id: card.id } }, scene)
    expect(focused.state.roadmapExpanded).toBe(true)
  }
  if (scrollDescriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor)
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

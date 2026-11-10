import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fixtureSources, fixtureId, fixtureScene, fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { Overview } from '../../../test-fixtures/reconciliation/Overview'

const observed = vi.hoisted(() => ({ scene: null as unknown, error: null as string | null }))
vi.mock('../useFloorScene', () => ({ useFloorScene: () => ({ scene: observed.scene, error: observed.error, now: Date.now() }) }))
vi.mock('../useDeskQueue', () => ({ useDeskQueue: () => ({ queue: fixtureQueue(), error: null }) }))
vi.mock('../../components/agentIcon', () => ({ AgentIcon: () => null }))
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
// Inspector regressions exercise the preserved Detailed presentation. Compact
// interaction and its default are covered by ultraCompact.test.tsx.
beforeEach(() => {
  localStorage.setItem('tinstar.overview.density', 'detailed')
  localStorage.setItem('tinstar.floor.preferences', JSON.stringify({ organizer: { outer: 'initiative', inner: 'status', order: 'checkIn', direction: 'asc' } }))
})
const mount = () => {
  const view = render(<Overview messages={[]} submit={vi.fn()} workers={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
  return view
}
afterEach(() => { cleanup(); localStorage.clear(); observed.error = null })

it.each(['queued', 'held'])('retains independently visible %s cards and keeps wait evidence in details', state => {
  const sources = fixtureSources()
  Object.assign(sources.fleet[1]!.observation.data!.backlog![0]!, { state, hold_reason: 'Awaiting review capacity', blocked_by: 'review-task', hold_until: '2026-11-05T12:00:00Z' })
  const scene = new SceneReconciler().reconcile(sources)
  observed.scene = scene
  const { container } = mount()
  const card = container.querySelector(`.ov-card[data-entity-id="${fixtureId(2)}"]`)!
  expect(card.getAttribute('data-tone')).toBe('quiet')
  expect(container.querySelectorAll('.ov-worker-stack .ov-execution')).toHaveLength(5)
  expect(container.querySelectorAll('.ov-card-stack .ov-card')).toHaveLength(5)
  fireEvent.click(within(card.parentElement!).getByRole('button', { name: 'Open in Inspector' }))
  expect(screen.getByLabelText('Inspector').textContent).toContain('Awaiting review capacity')
  expect(screen.getByLabelText('Inspector').textContent).toContain('review-task')
  fireEvent.change(screen.getByLabelText('Outer grouping'), { target: { value: 'machine' } })
  expect(screen.getByLabelText('Inspector').textContent).toContain('Awaiting review capacity')
})
it('keeps both source lists useful with connectors hidden and exposes both gaps', () => {
  observed.scene = fixtureScene()
  const { container } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  fireEvent.click(screen.getByRole('button', { name: 'Links' }))
  expect(container.querySelectorAll('.ov-connections')).toHaveLength(0)
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(5)
  expect(container.querySelectorAll('.ov-card')).toHaveLength(5)
  fireEvent.click(screen.getByRole('button', { name: /Gaps only/ }))
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(1)
  expect(container.querySelectorAll('.ov-card')).toHaveLength(1)
  expect(container.querySelector('.ov-card')?.getAttribute('data-tone')).toBe('gap')
  expect(container.querySelector('.ov-execution')?.getAttribute('data-tone')).toBe('orphan')
})
it('retains last known lists while suspending expired gap conclusions', () => {
  observed.scene = fixtureScene()
  observed.error = 'Read failed'
  const { container } = mount()
  expect(screen.getByRole('button', { name: 'Notion unavailable · Details' })).toBeVisible()
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(5)
  expect(container.querySelectorAll('.ov-card')).toHaveLength(5)
  expect(container.querySelectorAll('[data-tone="gap"], [data-tone="orphan"]')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  fireEvent.click(screen.getByRole('button', { name: /Gaps only/ }))
  expect(container.textContent).toContain('Gap checks suspended')
})
it('places finished and absent records in history rather than the current worker stack', () => {
  const sources = fixtureSources()
  const tasks = sources.fleet[1]!.observation.data!.tasks
  tasks[0]!.lastEventText = 'paused [at=1]: waiting on CI'
  tasks[1]!.lastEventText = 'done [at=1]: finished but window open'
  tasks[1]!.current_state.state = 'done'
  tasks[2]!.endpoint.exists = false
  observed.scene = new SceneReconciler().reconcile(sources)
  const { container } = mount()
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(3)
  expect(container.querySelector('.ov-history')?.textContent).toContain('Worker history · 2')
  expect(container.querySelector('.ov-history')?.textContent).toContain('Finished')
})

const groupings = [
  ['all', 'none', 'none'],
  ['manager', 'manager', 'none'],
  ['initiative', 'initiative', 'status'],
] as const
function degradeHomes(mode: 'partial' | 'stale' | 'down' | 'ready', index = 0) {
  const now = Date.now(), sources = fixtureSources({ now })
  const mark = (home: typeof sources.fleet[number]) => {
    if (mode === 'down') home.observation = { ...home.observation, data: null, status: 'unknown', coverage: 'unknown' }
    else if (mode === 'stale') home.observation = { ...home.observation, status: 'stale', coverage: 'unknown' }
    else if (mode === 'partial') home.observation = { ...home.observation, status: 'fresh', coverage: 'partial' }
  }
  if (mode === 'down') for (const home of sources.fleet) mark(home)
  else if (mode !== 'ready') mark(sources.fleet[index]!)
  return new SceneReconciler().reconcile(sources, now)
}
function arrange(outer: string, inner: string) {
  fireEvent.change(screen.getByLabelText('Outer grouping'), { target: { value: outer } })
  fireEvent.change(screen.getByLabelText('Inner grouping'), { target: { value: inner } })
}
function headerText(container: HTMLElement, label: RegExp) {
  return [...container.querySelectorAll('.ov-group-head')].find(header => label.test(header.textContent ?? ''))?.textContent ?? ''
}

it.each(groupings)('shows known workers and a partial warning for one partial home under %s grouping', (grouping, outer, inner) => {
  observed.scene = degradeHomes('partial')
  const { container } = mount()
  arrange(outer, inner)
  expect(container.querySelectorAll('.ov-execution').length).toBeGreaterThan(0)
  expect(container.textContent).toMatch(/(?:\d+ workers|WORKERS · \d+)/)
  expect(container.textContent).not.toContain('Workers unavailable')
  expect(container.textContent).not.toMatch(/(^|\s)0 workers/)
  expect(container.textContent).not.toMatch(/(^|\s)0 W/)
  expect(container.textContent).toMatch(/unknown worker/i)
  expect(container.textContent).not.toContain('No linked worker')
  expect(container.querySelectorAll('[data-tone="gap"], [data-tone="orphan"]')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /Coverage incomplete · Details/ }))
  expect(container.textContent).toContain('Partial worker coverage. Known workers remain visible.')
  expect(container.textContent).toContain('mac · fresh/partial · just now')
  if (grouping === 'manager') {
    expect(headerText(container, /hulk/i)).toMatch(/\d+ W/)
    expect(headerText(container, /bandit/i)).toMatch(/\d+ W/)
    expect(headerText(container, /Unassigned/)).toContain('Unknown workers')
  }
})

it.each(groupings)('shows known workers when one home is stale under %s grouping', (_grouping, outer, inner) => {
  observed.scene = degradeHomes('stale')
  const { container } = mount()
  arrange(outer, inner)
  expect(container.querySelectorAll('.ov-execution').length).toBeGreaterThan(0)
  expect(container.textContent).not.toContain('Workers unavailable')
  expect(container.textContent).toMatch(/unknown worker/i)
  fireEvent.click(screen.getByRole('button', { name: /Coverage incomplete · Details/ }))
  expect(container.textContent).toContain('mac · stale/unknown · just now')
})

it.each(groupings)('shows global unavailability only when every home is unreadable under %s grouping', (_grouping, outer, inner) => {
  observed.scene = degradeHomes('down')
  const { container } = mount()
  arrange(outer, inner)
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(0)
  expect(container.textContent).toContain('Workers unavailable')
  expect(container.textContent).not.toMatch(/(^|\s)0 workers/)
  expect(container.textContent).not.toMatch(/(^|\s)0 W/)
  expect(container.textContent).not.toContain('No workers')
  for (const header of container.querySelectorAll('.ov-group-head')) expect(header.textContent).toContain('Workers unavailable')
  expect(container.querySelectorAll('[data-tone="gap"], [data-tone="orphan"]')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /Workers need a refresh · Details/ }))
  expect(container.textContent).toContain('Worker sources are unavailable. Last known workers remain visible.')
  expect(container.textContent).toContain('mac · unknown/unknown · just now')
  expect(container.textContent).toContain('hulk · unknown/unknown · just now')
  expect(container.textContent).toContain('bandit · unknown/unknown · just now')
})

it.each(groupings)('shows ordinary worker counts when every home is readable under %s grouping', (grouping, outer, inner) => {
  observed.scene = degradeHomes('ready')
  const { container } = mount()
  arrange(outer, inner)
  expect(screen.getByRole('button', { name: /Sources connected · Details/ })).toBeTruthy()
  expect(container.textContent).toMatch(/(?:\d+ workers|WORKERS · \d+)/)
  expect(container.textContent).toContain('No linked worker')
  expect(container.textContent).not.toContain('Workers unavailable')
  expect(container.textContent).not.toMatch(/unknown worker/i)
  expect(container.querySelectorAll('.ov-execution').length).toBeGreaterThan(0)
  expect(container.querySelectorAll('[data-tone="gap"], [data-tone="orphan"]').length).toBeGreaterThan(0)
  if (grouping === 'manager') expect(headerText(container, /hulk/i)).toMatch(/\d+ W/)
})

it.each(groupings)('restores ordinary worker counts under %s grouping after a refresh', (_grouping, outer, inner) => {
  observed.scene = degradeHomes('partial')
  const view = mount()
  arrange(outer, inner)
  expect(view.container.textContent).toMatch(/unknown worker/i)
  expect(screen.getByRole('button', { name: /Coverage incomplete · Details/ })).toBeTruthy()
  observed.scene = degradeHomes('ready')
  view.rerender(<Overview messages={[]} submit={vi.fn()} workers={[]} />)
  expect(screen.getByRole('button', { name: /Sources connected · Details/ })).toBeTruthy()
  expect(view.container.textContent).toContain('No linked worker')
  expect(view.container.textContent).not.toContain('Workers unavailable')
  expect(view.container.textContent).not.toMatch(/unknown worker/i)
  expect(view.container.textContent).toMatch(/(?:\d+ workers|WORKERS · \d+)/)
  expect(view.container.querySelectorAll('.ov-execution').length).toBeGreaterThan(0)
})

it('keeps a partial home\'s workers visible beside fresh homes', () => {
  observed.scene = degradeHomes('partial', 1)
  const { container } = mount()
  arrange('manager', 'none')
  expect(container.querySelectorAll('.ov-execution').length).toBeGreaterThan(0)
  expect(headerText(container, /hulk/i)).toContain('last known workers')
  expect(headerText(container, /bandit/i)).toMatch(/\d+ W/)
  expect(headerText(container, /bandit/i)).not.toContain('Workers unavailable')
  expect(screen.getByRole('button', { name: /Coverage incomplete · Details/ })).toBeTruthy()
})

it('reports unavailable workers with a readable Notion feed', () => {
  const sources = fixtureSources()
  for (const home of sources.fleet) home.observation = { ...home.observation, data: null, status: 'unknown', coverage: 'unknown' }
  observed.scene = new SceneReconciler().reconcile(sources)
  const { container } = mount()
  expect(container.querySelectorAll('.ov-card').length).toBeGreaterThan(0)
  expect(container.textContent).toContain('Workers unavailable')
  for (const header of container.querySelectorAll('.ov-group-head')) {
    expect(header.textContent).toContain('Workers unavailable')
    expect(header.textContent).not.toContain('0 W')
  }
  expect(container.textContent).not.toContain('0 workers')
  expect(container.textContent).not.toContain('No workers')
})
it('collapses shared groups without changing deduplicated headline counts', () => {
  observed.scene = fixtureScene()
  const { container } = mount()
  fireEvent.change(screen.getByLabelText('Outer grouping'), { target: { value: 'manager' } })
  expect(container.querySelector('.ov-headings')!.textContent).toContain('NOTION TASKS · 5')
  fireEvent.click(screen.getByRole('button', { name: /Collapse Hulk/i }))
  expect(container.querySelector('.ov-headings')!.textContent).toContain('NOTION TASKS · 5')
  expect(container.querySelectorAll('.ov-execution')).toHaveLength(1)
})
it('clears mobile source diagnostics on close and subsequent worker selection', () => {
  observed.scene = fixtureScene()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const { container } = mount()
  fireEvent.click(screen.getByRole('button', { name: /Sources connected.*Details/ }))
  expect(screen.getByText('Source health')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close source health' }))
  fireEvent.click(within(container.querySelector('.ov-execution')!.parentElement!).getByRole('button', { name: 'Open in Inspector' }))
  expect(screen.queryByText('Source health')).toBeNull()
  expect(screen.getByLabelText('Inspector')).toBeTruthy()
})

it.each(['focus', 'open-queue'] as const)('renders MCP %s over diagnostics before acknowledging applied', async type => {
  const scene = fixtureScene()
  observed.scene = scene
  let command: unknown = null
  const acknowledgments: Array<{ outcome: string }> = []
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (body.type === 'register') return new Response(JSON.stringify({ ok: true, data: { scene_id: 'test-ui', key: 'test-key' } }))
    for (const ack of body.acknowledgments ?? []) {
      expect(screen.queryByText('Source health')).toBeNull()
      if (type === 'focus') expect(screen.getByLabelText('Inspector')).toBeTruthy()
      else expect(screen.getByLabelText('Desk queue')).toBeVisible()
      acknowledgments.push(ack)
    }
    const commands = command ? [command] : []
    command = null
    return new Response(JSON.stringify({ ok: true, data: { commands } }))
  })
  try {
    render(<Overview messages={[]} submit={vi.fn()} workers={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Sources connected.*Details/ }))
    expect(screen.getByText('Source health')).toBeTruthy()
    command = { scene_id: 'test-ui', command_id: type, expires_at: Date.now() + 10_000,
      action: type === 'focus' ? { type, target: { kind: 'execution', id: scene.executions[0]!.id }, origin: 'assistant' } : { type, origin: 'assistant' } }
    await waitFor(() => expect(acknowledgments).toContainEqual(expect.objectContaining({ outcome: 'applied' })), { timeout: 4000 })
  } finally {
    cleanup()
    fetchMock.mockRestore()
  }
})

it('keeps operational requests before Ask inbox records in the shared Desk', () => {
  observed.scene = fixtureScene()
  render(<Overview messages={[]} submit={vi.fn()} workers={[]} />)
  const desk = screen.getByLabelText('Your desk')
  const questions = within(desk).getByLabelText('Questions for First Mate')
  const operational = within(desk).getByRole('region', { name: 'Desk queue', hidden: true })
  expect(operational.compareDocumentPosition(questions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Open Your desk/ }))
  expect(desk).toBeVisible()
  expect(screen.getByRole('button', { name: /Open Your desk/, hidden: true })).toHaveAttribute('aria-expanded', 'true')
  expect(operational.compareDocumentPosition(questions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it.each(['done', 'landed'])('shows a worker resumed after a recorded %s outcome', (report) => {
  const sources = fixtureSources(), task = sources.fleet[1]!.observation.data!.tasks[0]!
  const now = Date.now()
  // Keep the home fresh independently of the quiet log's mtime.
  Object.assign(sources.fleet[1]!.observation, { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() })
  task.harness = 'codex'; task.current_state.state = 'unknown'
  task.lastEventText = `${report}: historical report`
  task.last_event.state = report
  task.last_event.age_seconds = 86400
  task.codex = { turn_open: true, observed_at: new Date(now).toISOString(), last_activity_at: new Date(now - 12 * 60_000).toISOString(), session_file: 'rollout-test.jsonl' }
  const scene = new SceneReconciler().reconcile(sources)
  observed.scene = scene
  const { container } = mount()
  const worker = scene.executions.find(value => value.identity.task_id === task.id)!
  const element = [...container.querySelectorAll('.ov-execution')].find(value => value.getAttribute('data-entity-id') === worker.id)
  expect(element).toBeDefined()
  expect(element).toHaveTextContent(/running/i)
})

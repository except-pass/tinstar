import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { StartWork } from '../StartWork'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { apiFetch } from '../../apiClient'
vi.mock('../../apiClient', () => ({ apiFetch: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('shows shared policy errors and preserves an attempt for a retry, then refreshes after confirmed save', async () => {
  const scene = fixtureScene(), worker = scene.executions[0]!, cardId = scene.cards[0]!.id, saved = vi.fn(async () => {})
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { outcome: 'not-saved', code: 'worker-unknown', saved_fields: [], message: 'Worker source is stale; current execution is unknown' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', code: 'saved', saved_fields: ['Status', 'First Mate tasks'], message: 'Start work saved and confirmed' } })))
  render(<StartWork scene={scene} cardId={cardId} onSaved={saved} />)
  fireEvent.click(screen.getByText('Start work', { selector: 'summary' }))
  fireEvent.change(screen.getByLabelText('Tracked worker'), { target: { value: worker.id } })
  fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Not saved. Worker source is stale'))
  expect(saved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
  const attempts = vi.mocked(apiFetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).input)
  expect(attempts[0]).toEqual(attempts[1]); expect(attempts[0].worker).toEqual({ kind: 'firstmate', fm_home: worker.home, task_id: worker.identity.task_id, first_observed_spawn_gen: worker.identity.spawn_gen })
  expect(screen.getByRole('status')).toHaveTextContent('Saved. Start work saved and confirmed')
})

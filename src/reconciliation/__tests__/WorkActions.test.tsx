import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkActions, CreateWork } from '../WorkActions'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { apiFetch } from '../../apiClient'
vi.mock('../../apiClient', () => ({ apiFetch: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
it('records a decision answer and declared handoff, preserves an identical retry after partial save, and refreshes shared state', async () => {
  const saved = vi.fn(async () => {}), card = fixtureScene().cards[0]!
  const fetcher = vi.mocked(apiFetch)
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { outcome: 'partially-saved', message: 'Properties saved; note failed', saved_fields: ['Owner', 'Status'] } })))
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', message: 'History repaired', saved_fields: ['note'] } })))
  render(<WorkActions card={card} onSaved={saved} />)
  fill('Operation', 'answer_decision'); fill('Decision request ID', 'ask-one'); fill('Answer', 'Proceed with the selected tariff'); fill('Next owner', 'Firstmate')
  fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Partially saved.'))
  const request = JSON.parse(String(fetcher.mock.calls[0]![1]!.body))
  expect(request).toMatchObject({ operation: 'update', input: { kind: 'answer_decision', request_id: 'ask-one', answer: 'Proceed with the selected tariff', next: { owner: 'Firstmate', status: 'Queued' } } })
  expect(saved).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved. History repaired'))
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual(request)
  expect(saved).toHaveBeenCalledTimes(2)
})
it('collects complete checkpoint intent with explicit confirmation and shows the server policy error', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { outcome: 'not-saved', message: 'Next check-in exceeds the board ceiling', saved_fields: [] } })))
  render(<WorkActions card={fixtureScene().cards[0]!} onSaved={vi.fn()} />)
  fill('Operation', 'checkpoint'); fill('Assessment', 'Build complete; acceptance remains'); fill('Evidence', 'Successful fixture build'); fill('Next action', 'Review required output'); fill('Next check-in (date or timestamp with timezone)', '2026-11-12'); fill('Appointment', 'owner-confirmed')
  fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Not saved. Next check-in exceeds'))
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]![1]!.body)).input).toMatchObject({ kind: 'checkpoint', checkpoint: { next_check_in: '2026-11-12', confirmation: 'owner-confirmed', assessment: 'Build complete; acceptance remains', next_action: 'Review required output' } })
})
it('creates a queued card from declared owner/area and brief without an open Notion UI', async () => {
  const saved = vi.fn(async () => {})
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', message: 'Card created', saved_fields: ['card'] } })))
  render(<CreateWork onSaved={saved} />)
  fill('Card name', 'New work'); fill('Owner', 'Firstmate'); fill('Area', 'Engineering'); fill('Brief', 'Implement the supported behavior'); fill('Acceptance criteria', 'Readback matches both interfaces')
  fireEvent.click(screen.getByRole('button', { name: 'Create queued card' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved. Card created'))
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]![1]!.body))).toMatchObject({ operation: 'create', input: { name: 'New work', owner: 'Firstmate', area: 'Engineering', status: 'Queued', content: { brief: 'Implement the supported behavior', acceptance_criteria: 'Readback matches both interfaces' } } })
  expect(saved).toHaveBeenCalledTimes(1)
})

it('retains edit preconditions and identity across refreshed props until intent changes', async () => {
  const card = structuredClone(fixtureScene().cards[0]!)
  card.source.properties.Priority = { type: 'select', value: 'Low' } as any
  const fetcher = vi.mocked(apiFetch)
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ok: true, data: { outcome: 'partially-saved', message: 'Note unconfirmed', saved_fields: ['Priority'] } })))
  const saved = vi.fn(async () => {})
  const view = render(<WorkActions card={card} onSaved={saved} />)
  fireEvent.click(screen.getByLabelText('Change an ordinary property'))
  fill('Property', 'Priority'); fill('New value (relation IDs separated by commas)', 'High'); fill('Note', 'Raise priority')
  const submit = async (count: number) => {
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(count))
  }
  await submit(1)
  const original = JSON.parse(String(fetcher.mock.calls[0]![1]!.body))
  card.source.properties.Priority!.value = 'High'
  view.rerender(<WorkActions card={card} onSaved={saved} />)
  await submit(2)
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual(original)
  fill('Note', 'Raise priority with new intent'); await submit(3)
  const changed = JSON.parse(String(fetcher.mock.calls[2]![1]!.body))
  expect(changed.input.operation_id).not.toBe(original.input.operation_id)
  expect(changed.input.expected).toEqual({ Priority: 'High' })
})

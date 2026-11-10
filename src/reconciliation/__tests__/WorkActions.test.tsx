import { useState } from 'react'
import { updateWorkSchema } from '../../shared/workflow'
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
  expect(screen.queryByRole('button', { name: 'Re-issue with refreshed card' })).not.toBeInTheDocument()
  card.source.properties.Priority!.value = 'High'
  view.rerender(<WorkActions card={card} onSaved={saved} />)
  await submit(2)
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual(original)
  fill('Note', 'Raise priority with new intent'); await submit(3)
  const changed = JSON.parse(String(fetcher.mock.calls[2]![1]!.body))
  expect(changed.input.operation_id).not.toBe(original.input.operation_id)
  expect(changed.input.expected).toEqual({ Priority: 'High' })
})

it.each(['Waiting For', 'In Progress', 'external', 'Done', 'Archived'])('answers directly into %s with the same state-specific evidence contract as MCP', async state => {
  const card = fixtureScene().cards[0]!
  const fetcher = vi.mocked(apiFetch)
  fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', message: 'Answer saved', saved_fields: ['note'] } })))
  render(<WorkActions card={card} onSaved={vi.fn(async () => {})} />)
  fill('Operation', 'answer_decision'); fill('Decision request ID', 'request-one'); fill('Answer', 'Proceed with this supported disposition')
  const status = state === 'external' ? 'In Progress' : state
  fill('Next status', status)
  if (state === 'Waiting For') {
    fill('Named dependency', 'Security approval'); fill('What unblocks it', 'Owner accepts evidence'); fill('Who follows up', 'Owner')
  } else if (state === 'In Progress') {
    fill('First Mate home', '/fixture/home'); fill('Task ID', 'native-task'); fill('Spawn generation', 'exact-generation')
  } else if (state === 'external') {
    fill('Worker system', 'external'); fill('Execution system', 'Build runner'); fill('Run ID', 'run-one'); fill('Run reference', 'https://runner.example/run-one')
    fill('Observed at (ISO timestamp with timezone)', '2026-11-10T12:00:00Z'); fill('Execution evidence', 'Runner reports compiling this card')
    fireEvent.click(screen.getByLabelText('This tracked run is currently executing this card'))
  } else {
    fill('Supported disposition', 'Owner accepted the supported outcome'); fill('Disposition evidence', 'Owner acceptance receipt')
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  const input = updateWorkSchema.parse(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).input)
  expect(input).toMatchObject({ kind: 'answer_decision', next: { status } })
  if (input.kind !== 'answer_decision') throw new Error('Expected decision answer')
  if (state === 'Waiting For') expect(input.next.wait).toEqual({ dependency: 'Security approval', unblocks_when: 'Owner accepts evidence', follow_up_by: 'Owner' })
  else if (state === 'In Progress') expect(input.next.worker).toEqual({ kind: 'firstmate', fm_home: '/fixture/home', task_id: 'native-task', first_observed_spawn_gen: 'exact-generation' })
  else if (state === 'external') expect(input.next.worker).toMatchObject({ kind: 'external', card_id: card.id, run_id: 'run-one', state: 'running' })
  else expect(input.next).toMatchObject({ disposition: 'Owner accepted the supported outcome', evidence: 'Owner acceptance receipt' })
})

it.each([
  { outcome: 'not-saved', code: 'conflict', requires_new_operation_id: true },
  { outcome: 'partially-saved', code: 'card-changed', requires_new_operation_id: true },
  { outcome: 'partially-saved', code: 'readback-mismatch', requires_new_operation_id: true },
  { outcome: 'not-saved', code: 'future-definite-case', requires_new_operation_id: true },
  { outcome: 'partially-saved', code: 'save-unconfirmed', requires_new_operation_id: false },
  { outcome: 'partially-saved', code: 'response-unavailable', requires_new_operation_id: undefined },
])('uses the server re-issue flag for $code and preserves uncertain identity', async serverResult => {
  const original = structuredClone(fixtureScene().cards[0]!)
  original.source.properties.Priority = { type: 'select', value: 'Low' } as any
  const refreshed = structuredClone(original)
  refreshed.source.properties.Priority!.value = 'Medium'
  const refresh = vi.fn(async () => {})
  function Editor() {
    const [card, setCard] = useState(original)
    return <><p>Current priority: {String(card.source.properties.Priority!.value)}</p><WorkActions card={card} onSaved={async result => {
      if (!result) { await refresh(); setCard(refreshed) }
    }} /></>
  }
  const fetcher = vi.mocked(apiFetch)
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { ...serverResult, message: 'Review current state', saved_fields: [] } })))
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', code: 'saved', message: 'Priority saved', saved_fields: ['Priority'] } })))
  render(<Editor />)
  fireEvent.click(screen.getByLabelText('Change an ordinary property'))
  fill('Property', 'Priority'); fill('New value (relation IDs separated by commas)', 'High')
  fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Review current state'))
  const first = JSON.parse(String(fetcher.mock.calls[0]![1]!.body))
  expect(first.input.expected).toEqual({ Priority: 'Low' })
  if (serverResult.requires_new_operation_id) {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh card' }))
    await waitFor(() => expect(screen.getByText('Current priority: Medium')).toBeInTheDocument())
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Re-issue with refreshed card' }))
  } else {
    expect(screen.queryByRole('button', { name: 'Re-issue with refreshed card' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  }
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved. Priority saved'))
  const second = JSON.parse(String(fetcher.mock.calls[1]![1]!.body))
  if (serverResult.requires_new_operation_id) {
    expect(second.input.operation_id).not.toBe(first.input.operation_id)
    expect(second.input.expected).toEqual({ Priority: 'Medium' })
    expect(second.input.properties).toEqual({ Priority: 'High' })
  } else expect(second).toEqual(first)
  expect(screen.queryByRole('button', { name: 'Re-issue with refreshed card' })).not.toBeInTheDocument()
})

it('explicitly re-issues a partial save after a direct edit, card-changed response and refresh', async () => {
  const original = structuredClone(fixtureScene().cards[0]!)
  original.source.properties.Priority = { type: 'select', value: 'Low' } as any
  let remotePriority = 'Low'
  const refresh = vi.fn(async () => {})
  function Editor() {
    const [card, setCard] = useState(original)
    return <><p>Current priority: {String(card.source.properties.Priority!.value)}</p>
      <button onClick={() => { remotePriority = 'Medium' }}>Edit card directly</button>
      <WorkActions card={card} onSaved={async result => {
        if (!result) { await refresh(); const updated = structuredClone(card); updated.source.properties.Priority!.value = remotePriority; setCard(updated) }
      }} /></>
  }
  const fetcher = vi.mocked(apiFetch)
  fetcher.mockImplementationOnce(async () => {
    remotePriority = 'High'
    return new Response(JSON.stringify({ ok: true, data: { outcome: 'partially-saved', code: 'save-unconfirmed', message: 'Priority saved; note failed', saved_fields: ['Priority'] } }))
  })
  fetcher.mockImplementationOnce(async () => {
    expect(remotePriority).toBe('Medium')
    return new Response(JSON.stringify({ ok: true, data: { outcome: 'partially-saved', code: 'card-changed', requires_new_operation_id: true, message: 'Card changed; review and re-issue', saved_fields: ['Priority'] } }))
  })
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', code: 'saved', message: 'Priority and note saved', saved_fields: ['Priority', 'note'] } })))
  render(<Editor />)
  fireEvent.click(screen.getByLabelText('Change an ordinary property'))
  fill('Property', 'Priority'); fill('New value (relation IDs separated by commas)', 'High'); fill('Note', 'Raise priority')
  fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Partially saved. Priority saved; note failed'))
  expect(screen.queryByRole('button', { name: 'Re-issue with refreshed card' })).not.toBeInTheDocument()
  const first = JSON.parse(String(fetcher.mock.calls[0]![1]!.body))
  fireEvent.click(screen.getByRole('button', { name: 'Edit card directly' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Partially saved. Card changed'))
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual(first)
  expect(screen.getByRole('status')).toHaveTextContent('Confirmed: Priority.')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh card' }))
  await waitFor(() => expect(screen.getByText('Current priority: Medium')).toBeInTheDocument())
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Re-issue with refreshed card' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved. Priority and note saved'))
  const reissued = JSON.parse(String(fetcher.mock.calls[2]![1]!.body))
  expect(reissued.input.operation_id).not.toBe(first.input.operation_id)
  expect(reissued.input.expected).toEqual({ Priority: 'Medium' })
  expect(reissued.input.properties).toEqual({ Priority: 'High' })
  expect(reissued.input.note).toBe('Raise priority')
})

it('keeps the original watchdog request and blocker in a human checkpoint', async () => {
  const card = fixtureScene().cards[0]!
  card.checkInRequest = { requestId: 'a9567a39-65c8-4ee1-968d-164570640373', originalCheckpoint: '2026-11-10T12:00:00Z', state: 'requested', requestedAt: '2026-11-10T12:01:00Z', answered: false }
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', saved_fields: ['Next check-in'], message: 'Checkpoint saved' } })))
  render(<WorkActions card={card} onSaved={vi.fn(async () => {})} />)
  fill('Operation', 'checkpoint'); fill('Assessment', 'Tests pass; owner acceptance remains'); fill('Evidence', 'Fixture evidence is available'); fill('Next action', 'Inspect the result'); fill('Next check-in (date or timestamp with timezone)', '2026-11-10T15:00:00-05:00'); fill('Blocker / owner (optional)', 'Waiting for owner approval')
  fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1))
  const input = updateWorkSchema.parse(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]![1]!.body)).input)
  expect(input).toMatchObject({ checkpoint: { request_id: card.checkInRequest.requestId, blocker: 'Waiting for owner approval' } })
})

it('offers open requests while retaining legacy source selection and excluding answered history', () => {
  render(<WorkActions card={fixtureScene().cards[0]!} onSaved={vi.fn()} sources={[
    { id: 'open', text: 'Question: Choose deployment time\nTin Star request: {"id":"open-one","action":"Decision","preserve_action":false}' },
    { id: 'closed', text: 'Question: Old answered question\nTin Star request: {"id":"closed-one","action":"Decision","preserve_action":false}' },
    { id: 'answer', text: 'Tin Star answer: "closed-one"' },
    { id: 'legacy', text: 'Legacy merge request' },
  ]} />)
  fill('Operation', 'answer_decision')
  expect(screen.getByRole('option', { name: 'Question: Choose deployment time' })).toHaveValue('open-one')
  expect(screen.getByRole('option', { name: 'Legacy merge request' })).toHaveValue('legacy')
  expect(screen.queryByRole('option', { name: 'Question: Old answered question' })).not.toBeInTheDocument()
})

it.each([
  { initial: undefined, current: 'request-one', edit: undefined },
  { initial: 'request-one', current: 'request-two', edit: undefined },
  { initial: 'request-one', current: undefined, edit: undefined },
  { initial: undefined, current: 'request-two', edit: 'human-request' },
  { initial: 'request-one', current: 'request-two', edit: '' },
])('keeps checkpoint display, submission and retry intent aligned across $initial to $current with edit $edit', async ({ initial, current, edit }) => {
  const original = structuredClone(fixtureScene().cards[0]!)
  const indicator = (requestId: string | undefined) => requestId === undefined ? undefined : {
    requestId, originalCheckpoint: '2026-11-10T12:00:00Z', state: 'requested' as const, requestedAt: '2026-11-10T12:01:00Z', answered: false,
  }
  original.checkInRequest = indicator(initial)
  const refreshed = { ...original, checkInRequest: indicator(current) }
  const fetcher = vi.mocked(apiFetch)
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ok: true, data: { outcome: 'partially-saved', message: 'Save unconfirmed', saved_fields: [] } })))
  const onSaved = vi.fn(async () => {})
  const view = render(<WorkActions card={original} onSaved={onSaved} />)
  fill('Operation', 'checkpoint')
  fill('Assessment', 'Current assessment'); fill('Evidence', 'Fixture evidence'); fill('Next action', 'Review result')
  fill('Next check-in (date or timestamp with timezone)', '2026-11-10T15:00:00-05:00')
  expect(screen.getByLabelText('Check-in request ID (optional)')).toHaveValue(initial ?? '')
  if (edit !== undefined) fill('Check-in request ID (optional)', edit)
  const submit = async (count: number) => {
    fireEvent.click(screen.getByRole('button', { name: 'Save update' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(count))
  }
  const input = (index: number) => JSON.parse(String(fetcher.mock.calls[index]![1]!.body)).input
  await submit(1)
  const first = input(0)
  view.rerender(<WorkActions card={refreshed} onSaved={onSaved} />)
  const expected = edit ?? current ?? ''
  expect(screen.getByLabelText('Check-in request ID (optional)')).toHaveValue(expected)
  await submit(2)
  const second = input(1)
  expect(second.checkpoint.request_id).toBe(expected || undefined)
  if ((edit ?? initial ?? '') === expected) expect(second).toEqual(first)
  else expect(second.operation_id).not.toBe(first.operation_id)
  view.rerender(<WorkActions card={{ ...refreshed }} onSaved={onSaved} />)
  await submit(3)
  expect(input(2)).toEqual(second)
})

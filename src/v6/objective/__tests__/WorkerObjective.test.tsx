import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { T01_PROCESS_UNCLAIMED, type WorkerObjectiveRecord } from '../model'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../../../apiClient'
import { WorkerObjective, workerObjectiveSlot } from '../index'

const fetchMock = vi.mocked(apiFetch)

const record: WorkerObjectiveRecord = {
  workerId: 'attached',
  current: {
    revision: '2',
    text: 'fix the objective panel only',
    setAt: '2026-09-24T07:21:00.000Z',
    requestId: 'set-narrow-1',
    disposition: 'queued',
    pending: true,
    detail: 'Queued. Not applied.',
    noteId: 'note-1',
    narrower: true,
    parentTaskId: 'task-parent',
    parentTaskCompletedAt: null,
    planProgress: null,
    planTaskLabel: 'Objective panel',
    planTaskSource: 'plan-task',
    fixture: true,
  },
  history: [{
    revision: '1',
    text: 'first draft',
    setAt: '2026-09-24T07:20:00.000Z',
    requestId: 'set-narrow-0',
  }],
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('WorkerObjective', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (path, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET') return json({ ok: true, data: record })
      if (String(path).endsWith('/achieve')) {
        return json({
          ok: true,
          data: {
            achievement: {
              pending: true,
              detail: 'Queued. Not applied.',
              text: record.current?.text,
              workerId: record.workerId,
              requestId: JSON.parse(String(init?.body)).requestId as string,
            },
            objective: record,
          },
        })
      }
      if (String(path) === '/api/v6/launches') {
        const sent = JSON.parse(String(init?.body)) as {
          requestId: string
          project: string
          objective: string
          sessionName: string | null
          fixture: boolean
        }
        return json({
          ok: true,
          data: {
            requestId: sent.requestId,
            project: sent.project,
            objective: sent.objective,
            sessionName: sent.sessionName,
            status: 'pending',
            processCreated: false,
            disposition: 'queued',
            pending: true,
            detail: 'Queued. Not applied.',
            noteId: 'note-launch',
            createdAt: '2026-09-24T07:22:00.000Z',
            fixture: sent.fixture,
            processClaim: T01_PROCESS_UNCLAIMED,
          },
        })
      }
      return json({ ok: true, data: record })
    })
  })

  it('shows the current text, the revision, the previous revision, and the fixture label', async () => {
    expect(workerObjectiveSlot).toBe(WorkerObjective)
    render(<WorkerObjective workerId="attached" initialRecord={record} />)
    expect(await screen.findByTestId('objective-text')).toHaveTextContent('fix the objective panel only')
    expect(screen.getByTestId('objective-revision')).toHaveTextContent('Revision 2')
    expect(screen.getByTestId('objective-previous')).toHaveTextContent('Previous revision 1: first draft')
    expect(screen.getByTestId('objective-pending')).toHaveTextContent('Pending')
    expect(screen.getByTestId('objective-fixture')).toHaveTextContent('fixture')
    expect(screen.getByTestId('objective-plan-task')).toHaveTextContent('Source plan-task')
    expect(screen.getByTestId('objective-plan-task')).toHaveTextContent('Not acceptance criteria')
    expect(screen.getByTestId('objective-narrower')).toHaveTextContent('The parent task stays open')
    expect(screen.queryByRole('button', { name: /mark task done/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /plan progress/i })).toBeNull()
  })

  it('asks the server to achieve the current objective and reuses the request id', async () => {
    render(<WorkerObjective workerId="attached" initialRecord={record} />)
    const button = await screen.findByRole('button', { name: 'Achieve your objective' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => {
      const achieve = fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/achieve'))
      expect(achieve).toHaveLength(2)
    })
    const bodies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/achieve'))
      .map(call => JSON.parse(String(call[1]?.body)) as { requestId: string; revision: string })
    expect(bodies[0]?.revision).toBe('2')
    expect(bodies[1]?.requestId).toBe(bodies[0]?.requestId)
    expect(bodies[0]?.requestId).toMatch(/^[A-Za-z0-9._:-]+$/)
  })

  it('keeps a launch pending and does not claim a worker process', async () => {
    render(<WorkerObjective workerId="attached" fixture initialRecord={record} />)
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'tinstar' } })
    fireEvent.blur(screen.getByLabelText('Project'))
    expect(screen.getByLabelText('Session name')).toHaveValue('tinstar-worker')
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'ship the objective panel' } })
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    expect(await screen.findByTestId('launch-pending')).toHaveTextContent('Pending')
    expect(screen.getByTestId('launch-objective-text')).toHaveTextContent('ship the objective panel')
    expect(screen.getAllByText(T01_PROCESS_UNCLAIMED).length).toBeGreaterThan(0)
    await waitFor(() => {
      const launches = fetchMock.mock.calls.filter(call => call[0] === '/api/v6/launches')
      expect(launches).toHaveLength(2)
    })
    const bodies = fetchMock.mock.calls
      .filter(call => call[0] === '/api/v6/launches')
      .map(call => JSON.parse(String(call[1]?.body)) as { requestId: string; project: string; objective: string; initiativeId?: string })
    expect(bodies[0]?.project).toBe('tinstar')
    expect(bodies[0]?.objective).toBe('ship the objective panel')
    expect(bodies[1]?.requestId).toBe(bodies[0]?.requestId)
    expect(bodies[0]).not.toHaveProperty('initiativeId')
  })

  it('disables achieve when the worker has no objective', async () => {
    fetchMock.mockImplementation(async () => json({
      ok: true,
      data: { workerId: 'solo', current: null, history: [] },
    }))
    render(<WorkerObjective workerId="solo" />)
    expect(await screen.findByTestId('objective-empty')).toHaveTextContent('No current objective')
    expect(screen.getByRole('button', { name: 'Achieve your objective' })).toBeDisabled()
    expect(screen.queryByTestId('objective-fixture')).toBeNull()
  })
})

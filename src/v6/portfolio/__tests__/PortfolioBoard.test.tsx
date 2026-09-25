import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { IntentEnvelope } from '../../contract/intent'
import { PortfolioBoard } from '../PortfolioBoard'
import {
  emptyPortfolio,
  proposalFromIntent,
  reconcileReceipt,
  recordSubmission,
  type SubmissionInput,
} from '../model'
import type { Epic, PlanView, PortfolioDoc, TaskRecord } from '../types'

function epic(partial: Partial<Epic> & Pick<Epic, 'id'>): Epic {
  return {
    title: partial.id,
    columnId: 'col-inbox',
    initiativeId: null,
    planSlug: null,
    completedAt: null,
    order: 0,
    revision: '1',
    ...partial,
  }
}

function task(partial: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'project'>): TaskRecord {
  return { epicId: null, planId: null, initiativeId: null, revision: '1', ...partial }
}

function board(partial: Partial<PortfolioDoc> = {}): PortfolioDoc {
  return { ...emptyPortfolio(), fixture: true, ...partial }
}

function queued(requestId: string, extra: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    noteId: 'note-1',
    disposition: 'queued',
    applied: true,
    detail: 'queued',
    exitCode: 0,
    canReceive: true,
    noteOutcome: 'created',
    ...extra,
    requestId,
  }
}

function driver(initial: PortfolioDoc) {
  let current = initial
  const envelopes: IntentEnvelope[] = []
  const submitIntent = vi.fn(async (envelope: IntentEnvelope) => {
    envelopes.push(envelope)
    const proposal = proposalFromIntent(current, envelope)
    if (!proposal.ok) throw new Error(proposal.diagnostic)
    current = recordSubmission(current, envelope, proposal.value, queued(envelope.requestId))
    const pending = current.pending.find(item => item.requestId === envelope.requestId)
    if (!pending) throw new Error('missing pending')
    return {
      submission: {
        requestId: pending.requestId,
        noteId: pending.noteId,
        disposition: pending.disposition,
        applied: pending.applied,
        detail: pending.detail,
        exitCode: pending.exitCode,
        canReceive: pending.canReceive,
      },
      board: current,
    }
  })
  return {
    envelopes,
    submitIntent,
    reconcile: async (requestId: string) => {
      current = reconcileReceipt(current, requestId, {
        requestId,
        outcome: 'applied',
        detail: 'ok',
      }).doc
      return current
    },
  }
}

describe('PortfolioBoard', () => {
  it('shows a fixture label, no initiative, and no dependency for a shared initiative', () => {
    render(
      <PortfolioBoard
        board={board({
          epics: [
            epic({ id: 'epic-a', title: 'Alpha', initiativeId: 'init-1' }),
            epic({ id: 'epic-b', title: 'Beta', initiativeId: null }),
          ],
          initiatives: [{ id: 'init-1', name: 'Rivers', epicIds: ['epic-a'], projectIds: ['proj-a', 'proj-b'], revision: '1' }],
          tasks: [task({ id: 'task-a', project: 'proj-a' }), task({ id: 'task-b', project: 'proj-b' })],
        })}
        submitIntent={async () => { throw new Error('unused') }}
      />,
    )
    expect(screen.getByTestId('fixture-board')).toHaveTextContent('Fixture')
    expect(screen.getByTestId('initiative-epic-b')).toHaveTextContent('No initiative')
    expect(screen.getByTestId('initiative-epic-a')).toHaveTextContent('Rivers')
    expect(screen.getByTestId('task-task-a')).toHaveTextContent('Project proj-a')
    expect(screen.queryByText(/Depends on/)).toBeNull()
  })

  it('shows an explicit dependency once it exists', () => {
    render(
      <PortfolioBoard
        board={board({
          dependencies: [{ id: 'dep-1', fromId: 'epic-a', toId: 'epic-b' }],
        })}
        submitIntent={async () => { throw new Error('unused') }}
      />,
    )
    expect(screen.getByTestId('dependency-dep-1')).toHaveTextContent('Depends on epic-a')
  })

  it('moves through portfolio.mutate and shows pending until the receipt', async () => {
    const initial = board({ epics: [epic({ id: 'epic-1', title: 'Alpha' })] })
    const harness = driver(initial)
    render(
      <PortfolioBoard
        board={initial}
        submitIntent={harness.submitIntent}
        onReconcile={harness.reconcile}
        createRequestId={() => 'req-move'}
      />,
    )
    fireEvent.pointerDown(screen.getByTestId('epic-epic-1'))
    fireEvent.pointerUp(screen.getByTestId('drop-col-building'))
    expect(await screen.findAllByText('Pending')).not.toHaveLength(0)
    const card = screen.getByTestId('epic-epic-1')
    expect(card).toHaveAttribute('data-authoritative-column', 'col-inbox')
    expect(card).toHaveAttribute('data-pending', 'true')
    expect(card.closest('[data-testid="column-col-building"]')).toBeTruthy()
    expect(harness.envelopes[0]).toMatchObject({
      kind: 'portfolio.mutate',
      requestId: 'req-move',
      body: { op: 'move', epicId: 'epic-1', toColumnId: 'col-building' },
    })
    expect(screen.queryByText('Applied')).toBeNull()
    fireEvent.pointerUp(screen.getByText('Check receipt'))
    expect(await screen.findByTestId('epic-epic-1')).toHaveAttribute('data-authoritative-column', 'col-building')
    expect(screen.getByTestId('epic-epic-1')).toHaveAttribute('data-pending', 'false')
    expect(screen.queryByText('Pending')).toBeNull()
    expect(screen.queryByText('Applied')).toBeNull()
  })

  it('explains a failed intake and does not show it as applied', () => {
    const initial = board({ epics: [epic({ id: 'epic-1', title: 'Alpha' })] })
    const envelope = {
      schema: 'tinstar.v6.intent/1' as const,
      kind: 'portfolio.mutate' as const,
      requestId: 'req-exit-1',
      revision: '1',
      anchor: { type: 'epic' as const, ids: ['epic-1'] },
      body: { op: 'move', epicId: 'epic-1', toColumnId: 'col-building' },
    }
    const proposal = proposalFromIntent(initial, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const failed = recordSubmission(initial, envelope, proposal.value, queued('req-exit-1', {
      noteId: null, disposition: 'failed', exitCode: 1, canReceive: null,
    }))
    const closed = recordSubmission(failed, { ...envelope, requestId: 'req-ready' }, proposal.value, queued('req-ready', {
      canReceive: false,
    }))
    const quiet = recordSubmission(closed, { ...envelope, requestId: 'req-exit-3' }, proposal.value, queued('req-exit-3', {
      exitCode: 3, disposition: 'saved-unannounced', canReceive: true,
    }))
    render(<PortfolioBoard board={quiet} submitIntent={async () => { throw new Error('unused') }} />)
    expect(screen.getByText('Nothing saved')).toBeTruthy()
    expect(screen.getByText('Not receivable')).toBeTruthy()
    expect(screen.getByText('Saved, not announced')).toBeTruthy()
    expect(screen.queryByText('Applied')).toBeNull()
    expect(screen.getByTestId('epic-epic-1')).toHaveAttribute('data-authoritative-column', 'col-inbox')
    expect(screen.getByTestId('status-req-exit-1')).toHaveAttribute('data-applied', 'false')
    expect(screen.getByTestId('status-req-exit-3')).toHaveAttribute('data-exit', '3')
  })

  it('renames a column to Done without completing the epic or launching', async () => {
    const initial = board({ epics: [epic({ id: 'epic-1', title: 'Alpha', columnId: 'col-review' })] })
    const harness = driver(initial)
    render(
      <PortfolioBoard
        board={initial}
        submitIntent={harness.submitIntent}
        createRequestId={() => 'req-rename'}
        clock={() => '2026-09-24T12:00:00.000Z'}
      />,
    )
    const column = screen.getByTestId('column-col-review')
    fireEvent.change(within(column).getByLabelText('Name Review'), { target: { value: 'Done' } })
    fireEvent.pointerUp(within(column).getByText('Rename'))
    expect(await screen.findByText('Pending')).toBeTruthy()
    expect(harness.envelopes).toHaveLength(1)
    expect(harness.envelopes[0]).toMatchObject({
      kind: 'column.mutate',
      body: { op: 'rename', columnId: 'col-review', name: 'Done' },
    })
    expect(screen.queryByTestId('completed-epic-1')).toBeNull()
    expect(screen.getByTestId('column-name-col-review')).toHaveTextContent('Review')
  })

  it('launches from a task without copying the epic initiative', async () => {
    const initial = board({
      epics: [epic({ id: 'epic-1', title: 'Alpha', initiativeId: 'init-1' })],
      initiatives: [{ id: 'init-1', name: 'Rivers', epicIds: ['epic-1'], projectIds: ['proj-a'], revision: '1' }],
      tasks: [task({ id: 'task-1', project: 'proj-a', epicId: 'epic-1', initiativeId: 'init-1' })],
    })
    const harness = driver(initial)
    render(
      <PortfolioBoard
        board={initial}
        submitIntent={harness.submitIntent}
        createRequestId={() => 'req-launch'}
      />,
    )
    fireEvent.pointerUp(screen.getByTestId('launch-task-1'))
    expect(await screen.findByText('Pending')).toBeTruthy()
    expect(harness.envelopes[0]).toMatchObject({
      kind: 'launch.request',
      anchor: { type: 'task', ids: ['task-1'] },
      body: { taskId: 'task-1', project: 'proj-a' },
    })
    expect(harness.envelopes[0]?.body).not.toHaveProperty('initiativeId')
  })

  it('links a labeled fixture plan and renders a down plan as unavailable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'))
    const plan: PlanView = {
      available: true,
      fixture: true,
      slug: 'pm-demo',
      href: 'http://127.0.0.1:9/p/pm-demo',
      tasks: [
        { id: 'alpha', label: 'Alpha', bucket: 'build', start: 0, end: 1, source: 'tasks', progress: 25, note: null, removed: false },
        { id: 'beta', label: 'Beta', bucket: 'build', start: 1, end: 2, source: 'added', progress: null, note: null, removed: false },
      ],
      detail: '',
    }
    const onOpenPlan = vi.fn(async () => plan)
    const { rerender } = render(
      <PortfolioBoard
        board={board({ epics: [epic({ id: 'epic-1', title: 'Alpha', planSlug: 'pm-demo' })] })}
        onOpenPlan={onOpenPlan}
        submitIntent={async () => { throw new Error('unused') }}
      />,
    )
    fireEvent.pointerUp(screen.getByTestId('open-plan-epic-1'))
    expect(await screen.findByTestId('fixture-plan')).toHaveTextContent('Fixture')
    expect(screen.getByTestId('plan-task-alpha')).toHaveTextContent('Alpha')
    expect(screen.getByTestId('plan-task-beta')).toHaveTextContent('Beta')
    expect(screen.getByTestId('plan-link')).toHaveAttribute('href', 'http://127.0.0.1:9/p/pm-demo')
    expect(document.querySelector('form')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()

    rerender(
      <PortfolioBoard
        board={board({ epics: [epic({ id: 'epic-1', title: 'Alpha', planSlug: 'pm-demo' })] })}
        plan={{ available: false, fixture: false, slug: 'pm-demo', href: null, tasks: [], detail: 'Stretch Plan unavailable' }}
        submitIntent={async () => { throw new Error('unused') }}
      />,
    )
    expect(screen.getByTestId('plan-unavailable')).toHaveTextContent('Stretch Plan unavailable')
    expect(screen.queryByTestId('plan-link')).toBeNull()
    fetchSpy.mockRestore()
  })
})

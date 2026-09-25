import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECEIPT_SCHEMA, type AppliedReceipt } from '../../contract/intent'
import {
  applyProposal,
  blockedStreamIds,
  emptyPortfolio,
  initiativeEnvelope,
  isStale,
  launchEnvelope,
  moveEnvelope,
  pendingLabel,
  proposalFromIntent,
  reconcileReceipt,
  recordSubmission,
  renameEnvelope,
  seedColumns,
  taskEnvelope,
  type SubmissionInput,
} from '../model'
import type { Epic, Initiative, PortfolioDoc, TaskRecord } from '../types'

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
  return {
    epicId: null,
    planId: null,
    initiativeId: null,
    revision: '1',
    ...partial,
  }
}

function initiative(partial: Partial<Initiative> & Pick<Initiative, 'id'>): Initiative {
  return {
    name: partial.id,
    epicIds: [],
    projectIds: [],
    revision: '1',
    ...partial,
  }
}

function board(partial: Partial<PortfolioDoc> = {}): PortfolioDoc {
  return { ...emptyPortfolio(), fixture: true, ...partial }
}

function queued(requestId: string, extra: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    noteId: 'note-1',
    disposition: 'queued',
    applied: false,
    detail: 'queued',
    exitCode: 0,
    canReceive: true,
    noteOutcome: 'created',
    ...extra,
    requestId,
  }
}

function receipt(requestId: string, outcome: 'applied' | 'rejected', detail: string): AppliedReceipt {
  return { schema: RECEIPT_SCHEMA, requestId, outcome, detail }
}

describe('T04 configurable columns', () => {
  it('seeds stable editable columns and does not treat a renamed label as completion', () => {
    const portfolioDir = join(process.cwd(), 'src/v6/portfolio')
    const source = [
      readFileSync(join(portfolioDir, 'model.ts'), 'utf8'),
      readFileSync(join(portfolioDir, 'PortfolioBoard.tsx'), 'utf8'),
      readFileSync(join(process.cwd(), 'src/server/v6/portfolio/routes.ts'), 'utf8'),
    ].join('\n')
    expect(source).not.toMatch(/['"]Done['"]/)
    expect(source).not.toMatch(/fm-spawn|fm-send|fm-control|fm-teardown|child_process/)

    const doc = board({
      epics: [epic({ id: 'epic-1', completedAt: '2026-09-01T00:00:00.000Z', columnId: 'col-review' })],
    })
    const column = seedColumns().find(item => item.id === 'col-review')
    expect(column).toBeTruthy()
    const envelope = renameEnvelope(column!, 'Done', 'Finished for now', 'req-rename')
    const proposal = proposalFromIntent(doc, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const applied = applyProposal(doc, proposal.value)
    expect(applied.ok).toBe(true)
    expect(applied.doc.columns.find(item => item.id === 'col-review')).toMatchObject({
      id: 'col-review',
      name: 'Done',
      description: 'Finished for now',
    })
    expect(applied.doc.epics[0]).toMatchObject({ completedAt: '2026-09-01T00:00:00.000Z', columnId: 'col-review' })
    expect(applied.doc.launches).toEqual([])
    expect(doc.epics[0]?.completedAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('sets completedAt only from an explicit intent and clears it on reopen', () => {
    const doc = board({ epics: [epic({ id: 'epic-1' })] })
    const stamp = '2026-09-24T12:00:00.000Z'
    const envelope = {
      schema: 'tinstar.v6.intent/1' as const,
      kind: 'portfolio.mutate' as const,
      requestId: 'req-done',
      revision: '1',
      anchor: { type: 'epic' as const, ids: ['epic-1'] },
      body: { op: 'set-completed', epicId: 'epic-1', completedAt: stamp },
    }
    const proposal = proposalFromIntent(doc, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const completed = applyProposal(doc, proposal.value).doc
    expect(completed.epics[0]?.completedAt).toBe(stamp)
    const reopen = proposalFromIntent(completed, { ...envelope, requestId: 'req-open', body: { op: 'set-completed', epicId: 'epic-1', completedAt: null } })
    expect(reopen.ok).toBe(true)
    if (!reopen.ok) return
    expect(applyProposal(completed, reopen.value).doc.epics[0]?.completedAt).toBeNull()
  })
})

describe('T03 cross-project organization', () => {
  it('keeps a shared initiative from becoming a dependency', () => {
    const doc = board({
      epics: [epic({ id: 'epic-a' }), epic({ id: 'epic-b' })],
      tasks: [task({ id: 'task-a', project: 'proj-a', epicId: 'epic-a' }), task({ id: 'task-b', project: 'proj-b', epicId: 'epic-b' })],
    })
    const envelope = initiativeEnvelope({
      id: 'init-1',
      name: 'Rivers',
      epicIds: ['epic-a', 'epic-b'],
      projectIds: ['proj-a', 'proj-b'],
    }, 'req-init', null)
    const proposal = proposalFromIntent(doc, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const next = applyProposal(doc, proposal.value).doc
    expect(next.dependencies).toEqual([])
    expect(next.epics.map(item => item.initiativeId)).toEqual(['init-1', 'init-1'])
    expect(next.initiatives[0]).toMatchObject({ epicIds: ['epic-a', 'epic-b'], projectIds: ['proj-a', 'proj-b'] })
    expect(next.tasks.map(item => item.project)).toEqual(['proj-a', 'proj-b'])
  })

  it('does not treat a cross-project dependency as a blocker for every related stream', () => {
    const doc = board({
      epics: [epic({ id: 'epic-a' }), epic({ id: 'epic-b' }), epic({ id: 'epic-c' })],
      tasks: [
        task({ id: 'task-a', project: 'proj-a', epicId: 'epic-a' }),
        task({ id: 'task-b', project: 'proj-b', epicId: 'epic-b' }),
        task({ id: 'task-c', project: 'proj-c', epicId: 'epic-c' }),
      ],
    })
    const initiative = initiativeEnvelope({
      id: 'init-1',
      name: 'Rivers',
      epicIds: ['epic-a', 'epic-b', 'epic-c'],
      projectIds: ['proj-a', 'proj-b', 'proj-c'],
    }, 'req-init', null)
    const proposed = proposalFromIntent(doc, initiative)
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    const coordinated = applyProposal(doc, proposed.value).doc
    expect(coordinated.dependencies).toEqual([])
    expect(coordinated.initiatives[0]).toMatchObject({
      epicIds: ['epic-a', 'epic-b', 'epic-c'],
      projectIds: ['proj-a', 'proj-b', 'proj-c'],
    })
    const dep = proposalFromIntent(coordinated, {
      schema: 'tinstar.v6.intent/1',
      kind: 'portfolio.mutate',
      requestId: 'req-dep',
      revision: null,
      anchor: { type: 'selection', ids: ['dep-1'] },
      body: { op: 'add-dependency', id: 'dep-1', fromId: 'epic-a', toId: 'epic-b' },
    })
    expect(dep.ok).toBe(true)
    if (!dep.ok) return
    const next = applyProposal(coordinated, dep.value).doc
    expect(next.tasks.map(item => item.project)).toEqual(['proj-a', 'proj-b', 'proj-c'])
    expect(next.dependencies).toEqual([{ id: 'dep-1', fromId: 'epic-a', toId: 'epic-b' }])
    const related = next.epics.map(item => item.id)
    expect(related).toEqual(['epic-a', 'epic-b', 'epic-c'])
    const blocked = blockedStreamIds(next, 'dep-1')
    expect(blocked).toEqual(['epic-a'])
    expect(blocked).not.toEqual(related)
  })

  it('records an explicit dependency id and rejects a task with more than one project', () => {
    const doc = board({ epics: [epic({ id: 'epic-a', initiativeId: 'init-1' })] })
    const many = taskEnvelope({ id: 'task-a', project: 'proj-a', requestId: 'req-task', revision: null })
    const bad = proposalFromIntent(doc, { ...many, body: { ...many.body, projects: ['proj-a', 'proj-b'] } })
    expect(bad.ok).toBe(false)
    const saved = proposalFromIntent(doc, many)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const withTask = applyProposal(doc, saved.value).doc
    expect(withTask.tasks[0]?.project).toBe('proj-a')
    expect(withTask.dependencies).toEqual([])
    const dep = proposalFromIntent(withTask, {
      schema: 'tinstar.v6.intent/1',
      kind: 'portfolio.mutate',
      requestId: 'req-dep',
      revision: null,
      anchor: { type: 'selection', ids: ['dep-1'] },
      body: { op: 'add-dependency', id: 'dep-1', fromId: 'epic-a', toId: 'epic-b' },
    })
    expect(dep.ok).toBe(true)
    if (!dep.ok) return
    const next = applyProposal(withTask, dep.value).doc
    expect(next.dependencies).toEqual([{ id: 'dep-1', fromId: 'epic-a', toId: 'epic-b' }])
  })

  it('allows an epic with no initiative', () => {
    const doc = board({ epics: [epic({ id: 'epic-1', initiativeId: null })] })
    expect(doc.epics[0]?.initiativeId).toBeNull()
    const cleared = proposalFromIntent(board({
      epics: [epic({ id: 'epic-1', initiativeId: 'init-1' })],
      initiatives: [initiative({ id: 'init-1', epicIds: ['epic-1'] })],
    }), {
      schema: 'tinstar.v6.intent/1',
      kind: 'portfolio.mutate',
      requestId: 'req-clear',
      revision: '1',
      anchor: { type: 'epic', ids: ['epic-1'] },
      body: { op: 'set-epic-initiative', epicId: 'epic-1', initiativeId: null },
    })
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    const next = applyProposal(board({
      epics: [epic({ id: 'epic-1', initiativeId: 'init-1' })],
      initiatives: [initiative({ id: 'init-1', epicIds: ['epic-1'] })],
    }), cleared.value).doc
    expect(next.epics[0]?.initiativeId).toBeNull()
    expect(next.dependencies).toEqual([])
  })
})

describe('T02 attached launch', () => {
  it('stores only supplied ancestors and the task project', () => {
    const doc = board({
      epics: [epic({ id: 'epic-1', initiativeId: 'init-1', planSlug: 'pm-demo' })],
      initiatives: [initiative({ id: 'init-1', epicIds: ['epic-1'], projectIds: ['proj-a'] })],
      tasks: [task({ id: 'task-1', project: 'proj-a', epicId: 'epic-1', planId: 'pm-demo', initiativeId: 'init-1' })],
    })
    const envelope = launchEnvelope({
      taskId: 'task-1',
      project: 'proj-a',
      requestId: 'req-launch',
      revision: '1',
      epicId: 'epic-1',
      planId: 'pm-demo',
    })
    expect(envelope.body).toEqual({ taskId: 'task-1', project: 'proj-a', epicId: 'epic-1', planId: 'pm-demo' })
    expect(envelope.kind).toBe('launch.request')
    const proposal = proposalFromIntent(doc, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok || proposal.value.op !== 'launch') return
    expect(proposal.value.launch).toEqual({
      requestId: 'req-launch',
      taskId: 'task-1',
      project: 'proj-a',
      planId: 'pm-demo',
      epicId: 'epic-1',
      initiativeId: null,
    })
    const applied = applyProposal(doc, proposal.value).doc
    expect(applied.launches).toEqual([proposal.value.launch])
    expect(applied.epics[0]?.initiativeId).toBe('init-1')
    expect(applied.dependencies).toEqual([])
  })

  it('rejects a launch project that disagrees with the task', () => {
    const doc = board({ tasks: [task({ id: 'task-1', project: 'proj-a' })] })
    const envelope = launchEnvelope({ taskId: 'task-1', project: 'proj-b', requestId: 'req-launch', revision: '1' })
    expect(proposalFromIntent(doc, envelope).ok).toBe(false)
  })

  it('keeps a missing initiative null when the task is new', () => {
    const doc = emptyPortfolio()
    const envelope = launchEnvelope({ taskId: 'task-9', project: 'proj-z', requestId: 'req-new', revision: null })
    const proposal = proposalFromIntent(doc, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok || proposal.value.op !== 'launch') return
    expect(proposal.value.launch.initiativeId).toBeNull()
    expect(proposal.value.launch.epicId).toBeNull()
    expect(proposal.value.launch.planId).toBeNull()
    expect(proposal.value.launch.project).toBe('proj-z')
  })
})

describe('T05 intent and receipt', () => {
  it('stays pending until an applied receipt and ignores a submit that claims applied', () => {
    const doc = board({ epics: [epic({ id: 'epic-1' })] })
    const envelope = moveEnvelope(doc.epics[0]!, 'col-building', 'req-move', 0)
    const proposal = proposalFromIntent(doc, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const pending = recordSubmission(doc, envelope, proposal.value, queued('req-move', { applied: true }))
    expect(pending.epics[0]?.columnId).toBe('col-inbox')
    expect(pending.pending).toHaveLength(1)
    expect(pending.pending[0]).toMatchObject({ applied: false, disposition: 'queued' })
    expect(pendingLabel(pending.pending[0]!)).toBe('Pending')
    const applied = reconcileReceipt(pending, 'req-move', receipt('req-move', 'applied', 'moved'))
    expect(applied.status).toBe('applied')
    expect(applied.doc.epics[0]?.columnId).toBe('col-building')
    expect(applied.doc.epics[0]?.completedAt).toBeNull()
    const again = reconcileReceipt(applied.doc, 'req-move', receipt('req-move', 'applied', 'moved'))
    expect(again.doc).toBe(applied.doc)
  })

  it('explains rejection, exit 1, exit 3, and a closed intake without applying', () => {
    const doc = board({ epics: [epic({ id: 'epic-1' })] })
    const envelope = moveEnvelope(doc.epics[0]!, 'col-building', 'req-move', 0)
    const proposal = proposalFromIntent(doc, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const rejected = recordSubmission(doc, envelope, proposal.value, queued('req-move'))
    const afterReject = reconcileReceipt(rejected, 'req-move', receipt('req-move', 'rejected', 'column is full'))
    expect(afterReject.status).toBe('rejected')
    expect(afterReject.doc.epics[0]?.columnId).toBe('col-inbox')
    expect(pendingLabel(afterReject.doc.pending[0]!)).toBe('column is full')

    const failed = recordSubmission(doc, { ...envelope, requestId: 'req-exit-1' }, proposal.value, queued('req-exit-1', {
      noteId: null, disposition: 'failed', exitCode: 1, canReceive: null, noteOutcome: null,
    }))
    expect(failed.pending[0]).toMatchObject({ applied: false, disposition: 'failed', detail: 'Nothing saved' })

    const saved = recordSubmission(doc, { ...envelope, requestId: 'req-exit-3' }, proposal.value, queued('req-exit-3', {
      disposition: 'saved-unannounced', exitCode: 3, canReceive: true,
    }))
    expect(saved.pending[0]).toMatchObject({ applied: false, disposition: 'saved-unannounced', detail: 'Saved, not announced' })

    const closed = recordSubmission(doc, { ...envelope, requestId: 'req-ready' }, proposal.value, queued('req-ready', {
      canReceive: false,
    }))
    expect(closed.pending[0]).toMatchObject({ applied: false, disposition: 'not-receivable', detail: 'Not receivable' })
    expect(closed.epics[0]?.columnId).toBe('col-inbox')
  })

  it('retries one request id onto the original note', () => {
    const doc = board({ epics: [epic({ id: 'epic-1' })] })
    const first = moveEnvelope(doc.epics[0]!, 'col-building', 'req-move', 0)
    const proposal = proposalFromIntent(doc, first)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const once = recordSubmission(doc, first, proposal.value, queued('req-move', { noteId: 'note-original' }))
    const second = moveEnvelope(doc.epics[0]!, 'col-review', 'req-move', 1)
    const again = recordSubmission(once, second, proposal.value, queued('req-move', { noteId: 'note-original', noteOutcome: 'replay' }))
    expect(again.pending).toHaveLength(1)
    expect(again.pending[0]).toMatchObject({ noteId: 'note-original', noteOutcome: 'replay', applied: false })
    expect(again.pending[0]?.proposal).toMatchObject({ op: 'move', toColumnId: 'col-building' })
  })

  it('does not apply a stale revision or a prose reply', () => {
    const doc = board({ epics: [epic({ id: 'epic-1', revision: '2' })] })
    const envelope = moveEnvelope({ ...doc.epics[0]!, revision: '1' }, 'col-building', 'req-stale', 0)
    const proposal = proposalFromIntent(doc, envelope)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    expect(isStale(doc, envelope.revision, proposal.value)).toBe(true)
    const pending = recordSubmission(doc, envelope, proposal.value, queued('req-stale'))
    const stale = reconcileReceipt(pending, 'req-stale', receipt('req-stale', 'applied', 'moved'))
    expect(stale.status).toBe('stale')
    expect(stale.doc.epics[0]?.columnId).toBe('col-inbox')
    expect(pendingLabel(stale.doc.pending[0]!)).toBe('Stale edit')

    const fresh = recordSubmission(board({ epics: [epic({ id: 'epic-1' })] }), moveEnvelope(epic({ id: 'epic-1' }), 'col-building', 'req-prose', 0), proposal.value, queued('req-prose'))
    const prose = reconcileReceipt(fresh, 'req-prose', null)
    expect(prose.status).toBe('pending')
    expect(prose.doc.epics[0]?.columnId).toBe('col-inbox')
  })
})

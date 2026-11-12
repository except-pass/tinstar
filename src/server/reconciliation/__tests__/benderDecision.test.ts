import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildQueue } from '../queue'
import { reconcileScene } from '../scene'
import { needsWill } from '../needsWill'
import { requestAnchor } from '../../../shared/deskSource'
import { fixtureProposal } from '../../../../test-fixtures/reconciliation/decisionProposal'
import { benderCardId, benderDecisionSources, benderQuestion, benderTaskId } from '../../../../test-fixtures/reconciliation/benderDecision'
const now = Date.parse('2026-11-12T01:27:00Z')
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now) })
afterEach(() => vi.useRealTimers())
const source = { home: '/fixture/hulk', taskId: benderTaskId, id: benderTaskId, kind: 'hold' as const }
const existingHoldKey = JSON.stringify(['hold', '/fixture/hulk', benderTaskId])
it('merges the explicit Decision card, keyed question and task hold as one owner decision', () => {
  const queue = buildQueue(benderDecisionSources(now), new Map(), now)
  expect(queue.items).toHaveLength(1)
  expect(queue.items[0]).toMatchObject({ id: existingHoldKey, readiness: 'ready-now', kind: 'decision', action: benderQuestion,
    cardIds: [benderCardId], decisionKeys: expect.arrayContaining(['pilot-go']), oneTouch: true })
  expect(queue.items[0]!.sources.filter(source => source.request)).toHaveLength(3)
  expect(queue.items[0]!.sources.find(entry => entry.request?.kind === 'hold')).toMatchObject({ responseAnchor: requestAnchor(source), readiness: 'ready-now' })
  expect(queue.items[0]!.sources.find(entry => entry.request?.kind === 'decision')?.responseAnchor).toBeUndefined()
})
it('keeps an already-published typed recommendation on the pre-merge hold key', () => {
  const snapshot = benderDecisionSources(now), queue = buildQueue(snapshot, new Map(), now)
  const proposal = { ...fixtureProposal(existingHoldKey, benderCardId), source: { kind: 'firstmate-request' as const, id: source.id, revision: '1' } }
  const blocks = [{ id: 'typed-note', type: 'comment', text: `Requested from: Will\nQuestion: ${benderQuestion}\nTin Star request: ${JSON.stringify({
    id: 'pilot-recommendation', action: 'Decision', source_request: source, source_question: benderQuestion, source_spawn_gen: 'attempt-1', proposal,
  })}` }]
  const rows = needsWill(queue, { ...reconcileScene(snapshot, now), claimHistory: [], historyScope: 'fixture' }, new Map([[benderCardId, { outcome: 'available', blocks }]]), null, new Map())
  expect(rows).toHaveLength(1)
  expect(queue.items[0]!.sources.filter(entry => entry.request)).toHaveLength(3)
  expect(rows[0]).toMatchObject({ readiness: 'ready-now', proposal: { value: proposal }, proposalHistoryComplete: true })
})
it.each(['future start', 'structured wait', 'task blocker', 'conditional question', 'stale fleet', 'incomplete history'])('retains verification/prerequisites for %s', condition => {
  const snapshot = benderDecisionSources(now), card = snapshot.intentions.data!.cards[0]!, home = snapshot.fleet[0]!
  if (condition === 'future start') card.properties['Start Date'] = { id: 'start', type: 'date', value: { start: '2026-12-01' }, hasMore: false }
  if (condition === 'structured wait') card.properties['Waiting For ID'] = { id: 'wait', type: 'rich_text', value: 'dependency-1', hasMore: false }
  if (condition === 'task blocker') home.observation.data!.tasks[0]!.backlog.blocked_by = 'dependency-1'
  if (condition === 'conditional question') home.observation.data!.tasks[0]!.queue!.decisions[0]!.summary = 'Choose the pilot after verification'
  if (condition === 'stale fleet') home.observation.status = 'stale'
  const queue = buildQueue(snapshot, new Map(), now)
  const rows = needsWill(queue, { ...reconcileScene(snapshot, now), claimHistory: [], historyScope: 'fixture' }, new Map([[benderCardId, { outcome: condition === 'incomplete history' ? 'unavailable' : 'available', blocks: [] }]]), null, new Map())
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every(row => row.readiness !== 'ready-now' && !row.oneTouch)).toBe(true)
})
it('does not merge distinct keyed questions on the same card or promote a tag without a keyed decision', () => {
  const snapshot = benderDecisionSources(now), task = snapshot.fleet[0]!.observation.data!.tasks[0]!
  task.queue!.decisions.push({ key: 'second', verb: 'needs-decision', summary: 'Choose a separate pilot scope' })
  const queue = buildQueue(snapshot, new Map(), now)
  expect(queue.items.filter(item => item.sources.some(entry => entry.request?.kind === 'decision'))).toHaveLength(2)
  task.queue!.decisions = []
  expect(buildQueue(snapshot, new Map(), now).items.every(item => item.readiness !== 'ready-now')).toBe(true)
})

it('preserves an existing exact-hold queue key and recommendation binding', () => {
  const snapshot = benderDecisionSources(now), hold = snapshot.fleet[0]!.observation.data!.backlog![0]!
  hold.id = 'pilot-go'; hold.queue!.originTaskId = null
  const key = JSON.stringify(['hold', source.home, 'pilot-go'])
  const queue = buildQueue(snapshot, new Map(), now)
  expect(queue.items).toHaveLength(1)
  expect(queue.items[0]).toMatchObject({ id: key, readiness: 'ready-now' })
  expect(queue.items[0]!.sources.some(entry => entry.request?.kind === 'hold')).toBe(true)
})
it('keeps an unrelated same-task hold separate even with identical question text', () => {
  const snapshot = benderDecisionSources(now)
  snapshot.fleet[0]!.observation.data!.backlog![0]!.id = 'other-approval'
  const queue = buildQueue(snapshot, new Map(), now)
  expect(queue.items).toHaveLength(2)
  expect(queue.items.find(item => item.decisionKeys.includes('pilot-go'))).toMatchObject({ readiness: 'ready-now' })
  expect(queue.items.find(item => item.decisionKeys.includes('other-approval'))?.readiness).not.toBe('ready-now')
})

it('classifies an explicit owner decision without inventing a fleet answer route', () => {
  const snapshot = benderDecisionSources(now)
  snapshot.fleet[0]!.observation.data!.backlog![0]!.captain_actionable = false
  const queue = buildQueue(snapshot, new Map(), now)
  expect(queue.items).toHaveLength(1)
  expect(queue.items[0]).toMatchObject({ readiness: 'ready-now', id: requestAnchor({ ...source, id: 'pilot-go', kind: 'decision' }) })
  expect(queue.items[0]!.sources.every(entry => !entry.responseAnchor)).toBe(true)
})

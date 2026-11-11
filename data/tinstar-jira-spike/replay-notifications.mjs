// Synthetic, in-memory proof only. No network, shell, inbox, or production imports.
// This tests notification handling assumptions, not Jira's validators or delivery.
import assert from 'node:assert/strict'

const scope = 'synthetic:project'
const task = {
  id: 'synthetic:primary-task', project: scope, type: 'Task', status: 'Queued',
  assignment: { kind: 'coordinator', id: 'synthetic:firstmate' },
  executionBindings: [], executionObservation: 'unknown',
}
const decision = id => ({
  id, project: scope, type: 'Decision', status: 'Open', action: 'Decision',
  question: 'Which synthetic artifact should the mock consumer use?',
  requestedFrom: 'synthetic:owner', options: [
    { id: 'a', label: 'Artifact A' }, { id: 'b', label: 'Artifact B' },
  ], recommendation: { optionId: 'a', rationale: 'Smaller synthetic fixture' },
  answer: null, delivery: 'not-attempted',
})
const workWait = { id: 'synthetic:blocker-work', project: scope, type: 'WorkBlocker',
  target: 'synthetic:prerequisite-task', status: 'Open' }
const actorWait = { id: 'synthetic:blocker-actor', project: scope, type: 'Wait',
  target: 'synthetic:owner', unblocksWhen: 'Synthetic acknowledgment exists',
  followUpBy: 'synthetic:firstmate', status: 'Open' }
const records = new Map([task, decision('synthetic:decision-1'), decision('synthetic:decision-2'),
  workWait, actorWait].map(record => [record.id, record]))
const links = [
  { source: workWait.id, target: task.id, type: 'blocks' },
  { source: actorWait.id, target: task.id, type: 'blocks' },
]
const receipt = { mode: 'local-simulation', observed_at: new Date().toISOString(),
  jira_requests: 0, real_dispatches: 0, checks: [], effects: [] }
let sourceAvailable = true
let failAfterNotification = false
const seen = new Set()
const pickups = new Set()
const answers = new Set()
let lastProjection
function project() {
  if (!sourceAvailable) return { availability: 'unknown', lastKnown: lastProjection }
  const current = records.get(task.id)
  if (!current || current.project !== scope) return { availability: 'unknown', lastKnown: lastProjection }
  lastProjection = { availability: 'known', status: current.status,
    execution: current.executionObservation,
    openDecisions: [...records.values()].filter(r => r.type === 'Decision' && r.status === 'Open').map(r => r.id),
    openBlockers: links.filter(link => link.target === task.id && records.get(link.source)?.status === 'Open').map(link => link.source),
  }
  return lastProjection
}
function refresh(event) {
  // A real receiver must verify authentication before reaching this function.
  // Here the boolean deliberately stands in for that independent missing test.
  if (!event.verified || event.project !== scope) return { outcome: 'ignored' }
  if (seen.has(event.id)) return { outcome: 'duplicate', projection: project() }
  // Event bodies are refresh hints. Never apply their status, answer, or command.
  const current = records.get(event.itemId)
  if (!sourceAvailable || !current || current.project !== scope) return { outcome: 'unknown', projection: project() }
  // Commit deduplication only after a successful read; a failed read is retryable.
  if (failAfterNotification) return { outcome: 'unknown', projection: project() }
  seen.add(event.id)
  if (current.id === task.id && current.status === 'Queued' && !pickups.has(current.id)) {
    pickups.add(current.id)
    receipt.effects.push({ kind: 'mock-pickup-notice', itemId: current.id })
  }
  if (current.type === 'Decision' && current.status === 'Answered' && current.answer && !answers.has(current.id)) {
    answers.add(current.id)
    receipt.effects.push({ kind: 'mock-answer-context', decisionId: current.id, delivery: 'recorded-only' })
  }
  return { outcome: 'refreshed', projection: project() }
}
function event(id, itemId = task.id, extra = {}) {
  return { id: `synthetic:event:${id}`, itemId, project: scope, verified: true, ...extra }
}
function check(name, run) { run(); receipt.checks.push({ name, result: 'pass' }) }

check('one mock pickup for native/automation/duplicate hints', () => {
  refresh(event('native-created'))
  refresh(event('native-created'))
  refresh(event('automation-created'))
  assert.equal(receipt.effects.length, 1)
  assert.equal(task.status, 'Queued')
  assert.equal(task.executionBindings.length, 0)
  assert.equal(project().execution, 'unknown')
})
check('two separately identified blockers coexist', () => {
  assert.deepEqual(project().openBlockers, [workWait.id, actorWait.id])
  workWait.status = 'Resolved'
  refresh(event('work-resolved', workWait.id))
  assert.deepEqual(project().openBlockers, [actorWait.id])
  assert.equal(task.status, 'Queued')
})
check('one answer does not clear a second Decision or actor wait', () => {
  const first = records.get('synthetic:decision-1')
  first.answer = { text: 'Use Artifact A', optionId: 'a', actor: 'synthetic:owner' }
  first.status = 'Answered'
  assert.equal(first.answer.optionId, first.recommendation.optionId)
  assert.ok(first.options.some(option => option.id === first.answer.optionId))
  assert.equal(first.answer.actor, first.requestedFrom)
  refresh(event('answer-1', first.id))
  refresh(event('answer-1-duplicate-path', first.id))
  assert.deepEqual(project().openDecisions, ['synthetic:decision-2'])
  assert.deepEqual(project().openBlockers, [actorWait.id])
  assert.equal(first.delivery, 'not-attempted')
  assert.equal(receipt.effects.filter(r => r.kind === 'mock-answer-context').length, 1)
  assert.equal(task.executionBindings.length, 0)
})
check('leaving Queued stays observable; old event body cannot roll back current state', () => {
  task.status = 'Waiting For'
  refresh(event('old-created', task.id, { status: 'Queued', command: 'dispatch-real-work' }))
  assert.equal(project().status, 'Waiting For')
  assert.equal(receipt.effects.filter(r => r.kind === 'mock-pickup-notice').length, 1)
})
check('source failure stays unknown with last-known context and permits read retry', () => {
  sourceAvailable = false
  assert.equal(refresh(event('retry-read')).outcome, 'unknown')
  assert.equal(project().availability, 'unknown')
  assert.equal(project().lastKnown.status, 'Waiting For')
  sourceAvailable = true
  assert.equal(refresh(event('retry-read')).outcome, 'refreshed')
  failAfterNotification = true
  assert.equal(refresh(event('retry-processing')).outcome, 'unknown')
  failAfterNotification = false
  assert.equal(refresh(event('retry-processing')).outcome, 'refreshed')
})
check('unverified/out-of-scope/missing-item hints produce no effect', () => {
  const before = receipt.effects.length
  assert.equal(refresh(event('unverified', task.id, { verified: false })).outcome, 'ignored')
  assert.equal(refresh(event('wrong-project', task.id, { project: 'synthetic:other' })).outcome, 'ignored')
  assert.equal(refresh(event('missing', 'synthetic:missing')).outcome, 'unknown')
  assert.equal(receipt.effects.length, before)
})
check('own-write/duplicate refreshes produce no repeat logical effects', () => {
  for (let i = 0; i < 4; i++) refresh(event(`own-${i}`))
  assert.equal(receipt.effects.length, 2)
})
check('last blocker resolution does not complete dependent work', () => {
  actorWait.status = 'Resolved'
  refresh(event('actor-resolved', actorWait.id))
  assert.deepEqual(project().openBlockers, [])
  assert.equal(task.status, 'Waiting For')
  assert.deepEqual(project().openDecisions, ['synthetic:decision-2'])
})
console.log(JSON.stringify({ ...receipt, final_projection: project(),
  limits: 'No Jira API/UI, signatures, persistent deduplication, restart recovery, live latency or delivery proven. The mock pickup latch covers one synthetic assignment only; requeue/new handoff epochs need a later explicit policy test.' }, null, 2))

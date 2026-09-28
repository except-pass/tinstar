import { describe, expect, it } from 'vitest'
import { buildAttentionCards, type AttentionWorker } from './attention'

const worker = (over: Partial<AttentionWorker> = {}): AttentionWorker => ({
  key: 'cockpit-0-alpha', id: 'alpha', objective: 'Ship the editor', state: 'parked',
  detail: 'Waiting for direction', prUrl: null, ...over,
})

describe('First Mate attention projection', () => {
  it('coalesces a keyed captain decision with its backlog hold and removes it when resolved', () => {
    const hold = { id: 'alpha-editor-call', title: 'Editor rollout', state: 'in_flight', hold_kind: 'captain', hold_reason: 'Choose rollout timing', hold_age_days: 3 }
    const tasks = [{ id: 'alpha', hints: { open_decisions: [{ key: 'captain-hold-alpha-editor-call-1', verb: 'needs-decision', summary: 'Choose rollout timing' }] } }]
    const open = buildAttentionCards(0, tasks, [hold], [worker()], new Map())
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ type: 'decision', workerId: 'alpha', ageDays: 3 })
    expect(buildAttentionCards(0, [{ id: 'alpha', hints: { open_decisions: [] } }], [{ ...hold, state: 'done' }], [worker()], new Map())).toEqual([])
  })

  it('shows independent blocked calls once alongside failure and only open PRs', () => {
    const url = 'https://github.com/acme/editor/pull/42'
    const tasks = [{ id: 'alpha', hints: { open_decisions: [{ key: 'access', verb: 'blocked', summary: 'Need repository access' }] } }, { id: 'bravo' }]
    const workers = [worker({ state: 'blocked', detail: 'Need repository access', prUrl: url }), worker({ id: 'bravo', key: 'cockpit-0-bravo', state: 'failed', detail: 'Build failed' })]
    const cards = buildAttentionCards(0, tasks, [], workers, new Map([[url, 'open']]))
    expect(cards.map(card => card.type)).toEqual(['blocked', 'failure', 'review'])
    expect(cards[0]?.detail).toBe('Need repository access')
    expect(cards[1]?.headline).toBe('Build failed')
    expect(cards[2]).toMatchObject({ repository: 'acme/editor', prNumber: 42, prUrl: url, ci: 'unknown' })
    expect(buildAttentionCards(0, tasks, [], workers, new Map([[url, 'merged']])).map(card => card.type)).toEqual(['blocked', 'failure'])
  })

  it('retains standalone captain holds and distinguishes an unknown PR status', () => {
    const url = 'https://github.com/acme/editor/pull/43'
    const cards = buildAttentionCards(1, [], [{ id: 'queued-call', title: 'Pick an approach', state: 'queued', hold_kind: 'captain', hold_reason: 'Choose an approach' }], [worker({ prUrl: url })], new Map())
    expect(cards).toMatchObject([
      { key: 'attention-1:hold:queued-call', type: 'decision', workerKey: null, ageDays: null },
      { type: 'review', reviewStatus: 'unknown', detail: 'Pull request status unavailable' },
    ])
  })

  it('matches a legacy default-key call to the same worker hold when the request text agrees', () => {
    const cards = buildAttentionCards(0,
      [{ id: 'alpha', hints: { open_decisions: [{ key: 'default', verb: 'needs-decision', summary: 'Choose the release channel' }] } }],
      [{ id: 'alpha-release', state: 'queued', hold_kind: 'captain', hold_reason: 'Choose the release channel' }],
      [worker()], new Map())
    expect(cards).toHaveLength(1)
  })
})

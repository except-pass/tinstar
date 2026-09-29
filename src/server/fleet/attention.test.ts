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
    expect(open[0]).toMatchObject({
      type: 'decision', workerId: 'alpha', ageDays: 3, dismissal: 'resolve-key',
      decisionKey: 'captain-hold-alpha-editor-call-1', holdId: 'alpha-editor-call',
    })
    expect(buildAttentionCards(0, [{ id: 'alpha', hints: { open_decisions: [] } }], [{ ...hold, state: 'done' }], [worker()], new Map())).toEqual([])
  })

  it('shows independent blocked calls once alongside failure and only open PRs', () => {
    const url = 'https://github.com/acme/editor/pull/42'
    const tasks = [{ id: 'alpha', hints: { open_decisions: [{ key: 'access', verb: 'blocked', summary: 'Need repository access' }] } }, { id: 'bravo' }]
    const workers = [worker({ state: 'blocked', detail: 'Need repository access', prUrl: url }), worker({ id: 'bravo', key: 'cockpit-0-bravo', state: 'failed', detail: 'Build failed' })]
    const cards = buildAttentionCards(0, tasks, [], workers, new Map([[url, 'open']]))
    expect(cards.map(card => card.type)).toEqual(['blocked', 'failure', 'review'])
    expect(cards[0]).toMatchObject({ headline: 'Need repository access', detail: '', dismissal: null, decisionKey: null })
    expect(cards[1]).toMatchObject({ headline: 'Build failed', detail: '' })
    expect(cards[2]).toMatchObject({ repository: 'acme/editor', prNumber: 42, prUrl: url, ci: 'unknown' })
    expect(buildAttentionCards(0, tasks, [], workers, new Map([[url, 'merged']])).map(card => card.type)).toEqual(['blocked', 'failure'])
  })

  it('retains standalone captain holds and distinguishes an unknown PR status', () => {
    const url = 'https://github.com/acme/editor/pull/43'
    const cards = buildAttentionCards(1, [], [{ id: 'queued-call', title: 'Pick an approach', state: 'queued', hold_kind: 'captain', hold_reason: 'Choose an approach' }], [worker({ prUrl: url })], new Map())
    expect(cards).toMatchObject([
      { key: 'attention-1:hold:queued-call', type: 'decision', dismissal: 'captain-hold', holdId: 'queued-call', workerKey: null, ageDays: null },
      { type: 'review', reviewStatus: 'unknown', detail: 'Pull request status unavailable' },
    ])
  })

  it('matches a legacy default-key call to the same worker hold when the request text agrees', () => {
    const cards = buildAttentionCards(0,
      [{ id: 'alpha', hints: { open_decisions: [{ key: 'default', verb: 'needs-decision', summary: 'Choose the release channel' }] } }],
      [{ id: 'alpha-release', state: 'queued', hold_kind: 'captain', hold_reason: 'Choose the release channel', body_lines: ['Origin: alpha'] }],
      [worker()], new Map())
    expect(cards).toMatchObject([{ dismissal: 'resolve-key', decisionKey: 'default', holdId: 'alpha-release' }])
  })

  it('answers a hold directly when the status line has no key, and leaves a keyless decision on the inbox path', () => {
    const held = buildAttentionCards(0,
      [{ id: 'alpha', hints: { open_decisions: [{ verb: 'needs-decision', summary: 'Choose the release channel' }] } }],
      [{ id: 'alpha-release', state: 'queued', hold_kind: 'captain', hold_reason: 'Choose the release channel', body_lines: ['Origin: alpha'] }],
      [worker()], new Map())
    expect(held).toMatchObject([{ dismissal: 'captain-hold', holdId: 'alpha-release', decisionKey: 'default' }])
    const open = buildAttentionCards(0,
      [{ id: 'alpha', hints: { open_decisions: [{ verb: 'needs-decision', summary: 'Choose the release channel' }] } }],
      [], [worker()], new Map())
    expect(open).toMatchObject([{ type: 'decision', dismissal: null, decisionKey: 'default', holdId: null }])
  })

  it('names the live worker on a hold of that worker\'s own task, so its dismiss releases the work', () => {
    const cards = buildAttentionCards(0, [{ id: 'alpha', hints: { open_decisions: [] } }],
      [{ id: 'alpha', title: 'Ship the editor', state: 'in_flight', hold_kind: 'captain', hold_reason: 'Hold until the captain says go' }],
      [worker()], new Map())
    expect(cards).toMatchObject([{ type: 'decision', dismissal: 'captain-hold', holdId: 'alpha', workerId: 'alpha' }])
  })

  it('resolves a call to its legacy decision hold even when the texts differ', () => {
    const cards = buildAttentionCards(0,
      [{ id: 'alpha', hints: { open_decisions: [{ key: 'api-shape', verb: 'needs-decision', summary: 'Pick API shape' }] } }],
      [{ id: 'alpha-decision-api-shape', title: 'API shape', state: 'in_flight', hold_kind: 'captain', hold_reason: 'Choose REST or GraphQL', hold_age_days: 2 }],
      [worker()], new Map())
    expect(cards).toMatchObject([{ type: 'decision', headline: 'Pick API shape', detail: 'API shape', ageDays: 2 }])
  })

  it('keeps holds with a shared id prefix apart', () => {
    const holds = ['alpha', 'alpha-editor-call'].map(id => ({ id, title: id, state: 'in_flight', hold_kind: 'captain', hold_reason: `Decide ${id}` }))
    const cards = buildAttentionCards(0,
      [{ id: 'alpha', hints: { open_decisions: [{ key: 'captain-hold-alpha-editor-call-1', verb: 'needs-decision', summary: 'Decide editor call' }] } }],
      holds, [worker()], new Map())
    expect(cards.map(card => card.key)).toEqual(['attention-0:alpha:decision:captain-hold-alpha-editor-call-1', 'attention-0:hold:alpha'])
  })

  it('keeps a similarly named hold from another origin as its own card', () => {
    const tasks = [{ id: 'alpha', hints: { open_decisions: [{ key: 'review', verb: 'blocked', summary: 'Need reviewer' }] } }]
    const hold = { id: 'ui-review', state: 'in_flight', hold_kind: 'captain', hold_reason: 'Approve UI review', hold_age_days: 4, body_lines: ['Origin: beta'] }
    expect(buildAttentionCards(0, tasks, [hold], [worker()], new Map())).toMatchObject([
      { key: 'attention-0:alpha:blocked:review', ageDays: null },
      { key: 'attention-0:hold:ui-review', ageDays: 4 },
    ])
  })

  it('attributes a standalone hold only by exact id or its recorded origin', () => {
    const workers = [worker({ id: 'api', key: 'cockpit-0-api' })]
    const hold = { id: 'api-v2-cutover', state: 'queued', hold_kind: 'captain', hold_reason: 'Approve cutover' }
    expect(buildAttentionCards(0, [], [hold], workers, new Map())[0]).toMatchObject({ workerKey: null, workerId: null })
    expect(buildAttentionCards(0, [], [{ ...hold, body_lines: ['Captain hold set: 2026-09-27', 'Origin: api'] }], workers, new Map())[0])
      .toMatchObject({ workerKey: 'cockpit-0-api', workerId: 'api' })
  })
})

import { describe, expect, it } from 'vitest'
import { displayedWorkerState, secondmateActivityById, type MateHomeActivity, type MateSnapshot } from './workerState'

const childDone = (over: MateSnapshot = {}): MateSnapshot => ({
  kind: 'secondmate',
  current_state: {
    state: 'done', source: 'status-log',
    detail: 'child kd-widget done: report and visual review complete',
  },
  hints: { last_event_text: 'done [key=child-outcome-kd-widget-done-05b032a1] [at=1790000000]: child kd-widget done: report and visual review complete' },
  endpoint: { exists: true, agent_alive: 'alive', status: 'alive' },
  ...over,
})

const waiting: MateHomeActivity = { state: 'no_active_work', activeChildren: 0 }
const busy: MateHomeActivity = { state: 'active_child_work', activeChildren: 1 }

describe('displayed worker state', () => {
  it('keeps a ship or scout done when its own status line says done', () => {
    for (const kind of ['ship', 'scout', 'worker']) {
      expect(displayedWorkerState({ kind, current_state: { state: 'done', source: 'status-log', detail: 'checks green' } })).toEqual({ state: 'done', detail: 'checks green' })
    }
    expect(displayedWorkerState({
      kind: 'ship',
      current_state: { state: 'done', source: 'status-log', detail: 'child kd-widget done: report complete' },
    }, busy)).toEqual({ state: 'done', detail: 'child kd-widget done: report complete' })
  })

  it('leaves a second mate blocked, working, or genuinely done unchanged', () => {
    expect(displayedWorkerState({ kind: 'secondmate', current_state: { state: 'blocked', source: 'status-log', detail: 'need release access' } }, waiting))
      .toEqual({ state: 'blocked', detail: 'need release access' })
    expect(displayedWorkerState({ kind: 'secondmate', current_state: { state: 'working', source: 'status-log', detail: 'reconciling routed items' } }, waiting))
      .toEqual({ state: 'working', detail: 'reconciling routed items' })
    expect(displayedWorkerState(childDone({
      current_state: { state: 'done', source: 'status-log', detail: 'charter complete' },
      hints: { last_event_text: 'done [at=1790000000]: charter complete' },
    }), waiting)).toEqual({ state: 'done', detail: 'charter complete' })
  })

  it('shows a second mate idle when its last line is a child done and it is waiting', () => {
    const detail = 'child kd-widget done: report and visual review complete'
    expect(displayedWorkerState(childDone(), waiting)).toEqual({ state: 'idle', detail })
    expect(displayedWorkerState(childDone(), { state: 'externally_held', activeChildren: 0 })).toEqual({ state: 'idle', detail })
    expect(displayedWorkerState(childDone(), { state: 'captain_decision', activeChildren: 0 })).toEqual({ state: 'idle', detail })
    expect(displayedWorkerState(childDone(), null)).toEqual({ state: 'idle', detail })
  })

  it('shows a second mate working when a child done is latest but child work is still active', () => {
    const detail = 'child kd-widget done: report and visual review complete'
    expect(displayedWorkerState(childDone(), busy)).toEqual({ state: 'working', detail })
    expect(displayedWorkerState(childDone(), { state: 'no_active_work', activeChildren: 2 })).toEqual({ state: 'working', detail })
  })

  it('leaves a non-status done unchanged, and a child done with no live endpoint unknown', () => {
    expect(displayedWorkerState(childDone({
      current_state: { state: 'done', source: 'run-step', detail: 'child kd-widget done: report complete' },
    }), waiting)).toEqual({ state: 'done', detail: 'child kd-widget done: report complete' })
    expect(displayedWorkerState(childDone({
      endpoint: { exists: false, agent_alive: 'dead', status: 'dead' },
    }), null)).toEqual({ state: 'unknown', detail: 'child kd-widget done: report and visual review complete' })
  })

  it('never shows a second mate with a dead endpoint idle, even when its home is waiting', () => {
    const detail = 'child kd-widget done: report and visual review complete'
    expect(displayedWorkerState(childDone({ endpoint: { exists: true, agent_alive: 'dead', status: 'alive' } }), waiting)).toEqual({ state: 'unknown', detail })
    expect(displayedWorkerState(childDone({ endpoint: { exists: false } }), waiting)).toEqual({ state: 'unknown', detail })
    expect(displayedWorkerState(childDone({ endpoint: { exists: false, agent_alive: 'dead' } }), busy)).toEqual({ state: 'unknown', detail })
  })

  it('shows a second mate working or idle when its last line is a child failed, keeping the child failure as detail', () => {
    const detail = 'child kd-widget failed: build broke on main'
    const failed = childDone({
      current_state: { state: 'failed', source: 'status-log', detail },
      hints: { last_event_text: 'failed [key=child-outcome-kd-widget-failed-0a1b2c3d] [at=1790000000]: child kd-widget failed: build broke on main' },
    })
    expect(displayedWorkerState(failed, waiting)).toEqual({ state: 'idle', detail })
    expect(displayedWorkerState(failed, busy)).toEqual({ state: 'working', detail })
  })

  it('shows a second mate working or idle when its last line is the inactive-outcome fallback for a child', () => {
    const detail = 'inactive terminal child=kd-widget fingerprint=0a1b2c3d4e5f'
    const fallback = (state: string) => childDone({
      current_state: { state, source: 'status-log', detail },
      hints: { last_event_text: `${state} [key=inactive-outcome-kd-kd-widget-${state}] [at=1790000000]: ${detail}` },
    })
    expect(displayedWorkerState(fallback('done'), waiting)).toEqual({ state: 'idle', detail })
    expect(displayedWorkerState(fallback('failed'), busy)).toEqual({ state: 'working', detail })
  })

  it('reads only the latest status line in the publisher shape', () => {
    expect(displayedWorkerState(childDone({
      hints: { last_event_text: 'done [key=child-outcome-widget-done-abcdef12] [at=1790000000]: report complete' },
    }), waiting)).toEqual({ state: 'done', detail: 'child kd-widget done: report and visual review complete' })
    expect(displayedWorkerState(childDone({
      hints: { last_event_text: 'done [at=1790000000]: child kd-widget done: report and visual review complete' },
    }), waiting)).toEqual({ state: 'done', detail: 'child kd-widget done: report and visual review complete' })
    expect(displayedWorkerState(childDone({
      current_state: { state: 'failed', source: 'status-log', detail: 'own charter failed' },
    }), waiting)).toEqual({ state: 'failed', detail: 'own charter failed' })
  })

  it('reads active child counts from the snapshot summary', () => {
    const mates = secondmateActivityById({
      secondmate_current: {
        records: [
          { id: 'kd', current: { state: 'no_active_work' }, active_children: [], counts: { active_children: 0 } },
          { id: 'busy-mate', current: { state: 'active_child_work' }, active_children: [{ id: 'one' }], counts: { active_children: 3 } },
          { id: 'uncounted', current: { state: 'active_child_work' }, active_children: [{ id: 'one' }] },
          { id: '', current: { state: 'active_child_work' } },
          { current: { state: 'no_active_work' } },
        ],
      },
    })
    expect(mates.get('kd')).toEqual({ state: 'no_active_work', activeChildren: 0 })
    expect(mates.get('busy-mate')).toEqual({ state: 'active_child_work', activeChildren: 3 })
    expect(mates.get('uncounted')).toEqual({ state: 'active_child_work', activeChildren: 0 })
    expect(mates.size).toBe(3)
    expect(secondmateActivityById({}).size).toBe(0)
  })
})

describe('unknown snapshot state', () => {
  const at = 1_790_000_000
  const now = (at + 4 * 60) * 1000
  const unavailable = (line: string, endpoint: MateSnapshot['endpoint'] = { exists: true, agent_alive: 'alive', status: 'alive' }): MateSnapshot => ({
    kind: 'ship',
    current_state: { state: 'unknown', source: 'pane', detail: 'harness state unavailable' },
    endpoint,
    hints: { last_event_text: line },
  })

  it('reads each status prefix and marks the report age', () => {
    for (const state of ['working', 'paused', 'blocked', 'needs-decision', 'done', 'failed']) {
      expect(displayedWorkerState(unavailable(`${state} [at=${at}]: still on the change`), null, now))
        .toEqual({ state, detail: `${state} · last report 4m ago` })
    }
    expect(displayedWorkerState(unavailable(`needs-decision [at=${at}] [key=gate]: choose a layout`, { exists: true, agent_alive: 'alive' }), null, now))
      .toEqual({ state: 'needs-decision', detail: 'needs-decision · last report 4m ago' })
    expect(displayedWorkerState({ ...unavailable(`working [at=${at}]`), kind: 'scout' }, null, now))
      .toEqual({ state: 'working', detail: 'working · last report 4m ago' })
    expect(displayedWorkerState({ ...unavailable(`paused [at=${at}]: waiting on review`), kind: 'secondmate' }, null, now))
      .toEqual({ state: 'paused', detail: 'paused · last report 4m ago' })
  })

  it('formats a report age as just now, hours, or days', () => {
    const task = unavailable(`working [at=${at}]`)
    expect(displayedWorkerState(task, null, at * 1000 + 20_000).detail).toBe('working · last report just now')
    expect(displayedWorkerState(task, null, (at + 2 * 60 * 60) * 1000).detail).toBe('working · last report 2h ago')
    expect(displayedWorkerState(task, null, (at + 3 * 24 * 60 * 60) * 1000).detail).toBe('working · last report 3d ago')
    expect(displayedWorkerState(task, null, (at - 60) * 1000).detail).toBe('working · last report just now')
  })

  it('keeps a live pane state and leaves an unrecognized line unknown', () => {
    expect(displayedWorkerState({
      current_state: { state: 'working', source: 'pane', detail: 'harness busy' },
      endpoint: { exists: true, agent_alive: 'alive' },
      hints: { last_event_text: `failed [at=${at}]: build broke` },
    }, null, now)).toEqual({ state: 'working', detail: 'harness busy' })
    expect(displayedWorkerState({
      current_state: { state: 'idle', source: 'pane', detail: 'harness idle' },
      hints: { last_event_text: `blocked [at=${at}]: need access` },
    }, null, now)).toEqual({ state: 'idle', detail: 'harness idle' })
    expect(displayedWorkerState(unavailable(`resolved [at=${at}]: cleared`), null, now))
      .toEqual({ state: 'unknown', detail: 'harness state unavailable' })
    expect(displayedWorkerState(unavailable('working: still on the change'), null, now))
      .toEqual({ state: 'working', detail: 'working · last report' })
    expect(displayedWorkerState(unavailable('working [at=12:30]: still on the change'), null, now))
      .toEqual({ state: 'working', detail: 'working · last report' })
  })

  it('keeps unknown when the endpoint is dead', () => {
    const line = `working [at=${at}]: still on the change`
    const detail = 'harness state unavailable'
    expect(displayedWorkerState(unavailable(line, { exists: false, agent_alive: 'dead', status: 'dead' }), null, now))
      .toEqual({ state: 'unknown', detail })
    expect(displayedWorkerState(unavailable(line, { exists: true, agent_alive: 'dead', status: 'alive' }), null, now))
      .toEqual({ state: 'unknown', detail })
    expect(displayedWorkerState(unavailable(line, { exists: false }), null, now))
      .toEqual({ state: 'unknown', detail })
    expect(displayedWorkerState(unavailable(line, { exists: true, agent_alive: 'alive' }), { state: 'no_active_work', activeChildren: 0 }, now))
      .toEqual({ state: 'working', detail: 'working · last report 4m ago' })
  })
})

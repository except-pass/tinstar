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

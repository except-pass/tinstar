import { describe, expect, it } from 'vitest'
import { displayedWorkerState, secondmateActivityById, type MateHomeActivity, type MateSnapshot } from './workerState'

const childDone = (over: MateSnapshot = {}): MateSnapshot => ({
  kind: 'secondmate',
  current_state: {
    state: 'done', source: 'status-log',
    detail: 'child kd-widget done: report and visual review complete',
  },
  paths: { status_log: { last_event: { raw: 'done [key=child-outcome-kd-widget-done-05b032a1] [at=1790000000]: child kd-widget done: report and visual review complete' } } },
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
      paths: { status_log: { last_event: { raw: 'done [at=1790000000]: charter complete' } } },
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
      paths: { status_log: { last_event: { raw: 'failed [key=child-outcome-kd-widget-failed-0a1b2c3d] [at=1790000000]: child kd-widget failed: build broke on main' } } },
    })
    expect(displayedWorkerState(failed, waiting)).toEqual({ state: 'idle', detail })
    expect(displayedWorkerState(failed, busy)).toEqual({ state: 'working', detail })
  })

  it('shows a second mate working or idle when its last line is the inactive-outcome fallback for a child', () => {
    const detail = 'inactive terminal child=kd-widget fingerprint=0a1b2c3d4e5f'
    const fallback = (state: string) => childDone({
      current_state: { state, source: 'status-log', detail },
      paths: { status_log: { last_event: { raw: `${state} [key=inactive-outcome-kd-kd-widget-${state}] [at=1790000000]: ${detail}` } } },
    })
    expect(displayedWorkerState(fallback('done'), waiting)).toEqual({ state: 'idle', detail })
    expect(displayedWorkerState(fallback('failed'), busy)).toEqual({ state: 'working', detail })
  })

  it('reads only the latest status line in the publisher shape', () => {
    expect(displayedWorkerState(childDone({
      paths: { status_log: { last_event: { raw: 'done [key=child-outcome-widget-done-abcdef12] [at=1790000000]: report complete' } } },
    }), waiting)).toEqual({ state: 'done', detail: 'child kd-widget done: report and visual review complete' })
    expect(displayedWorkerState(childDone({
      paths: { status_log: { last_event: { raw: 'done [at=1790000000]: child kd-widget done: report and visual review complete' } } },
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
  const alive = { exists: true, agent_alive: 'alive', status: 'alive' }
  const unavailable = (event: Record<string, unknown>, over: MateSnapshot = {}): MateSnapshot => ({
    kind: 'ship',
    current_state: { state: 'unknown', source: 'pane', detail: 'harness state unavailable' },
    endpoint: alive,
    paths: { status_log: { last_event: event } },
    ...over,
  })
  const report = (state: string, note = 'still on the change', age_seconds: unknown = 240) =>
    ({ state, note, raw: `${state} [at=1790000000]: ${note}`, age_seconds })

  it('reads each status verb and shows the note with the report age', () => {
    for (const state of ['working', 'paused', 'blocked', 'done', 'failed']) {
      expect(displayedWorkerState(unavailable(report(state)))).toEqual({ state, detail: 'still on the change · last report 4m ago' })
    }
    expect(displayedWorkerState(unavailable(report('failed', 'build broke'), { kind: 'scout' })))
      .toEqual({ state: 'failed', detail: 'build broke · last report 4m ago' })
  })

  it('shows needs-decision as parked', () => {
    expect(displayedWorkerState(unavailable(report('needs-decision', 'choose a layout'))))
      .toEqual({ state: 'parked', detail: 'choose a layout · last report 4m ago' })
  })

  it('formats the report age as just now, minutes, hours, or days', () => {
    const detail = (age: unknown) => displayedWorkerState(unavailable(report('working', '', age))).detail
    expect(detail(0)).toBe('last report just now')
    expect(detail(59)).toBe('last report just now')
    expect(detail(60)).toBe('last report 1m ago')
    expect(detail(2 * 60 * 60 + 30 * 60)).toBe('last report 2h ago')
    expect(detail(3 * 24 * 60 * 60)).toBe('last report 3d ago')
  })

  it('invents no age when First Mate has none', () => {
    for (const age of [null, -60, '240', Number.NaN]) {
      expect(displayedWorkerState(unavailable(report('working', 'still on the change', age))).detail).toBe('still on the change · last report')
    }
    expect(displayedWorkerState(unavailable({ state: 'working', note: 'still on the change' })).detail).toBe('still on the change · last report')
    expect(displayedWorkerState(unavailable(report('working', '', null))).detail).toBe('last report')
  })

  it('keeps a long or multi-line note on one short line', () => {
    expect(displayedWorkerState(unavailable(report('failed', 'x'.repeat(200)))).detail).toBe(`${'x'.repeat(79)}… · last report 4m ago`)
    expect(displayedWorkerState(unavailable(report('blocked', '  need\n  access  '))).detail).toBe('need access · last report 4m ago')
  })

  it('stays unknown when First Mate read no known verb', () => {
    const unknown = { state: 'unknown', detail: 'harness state unavailable' }
    expect(displayedWorkerState(unavailable({ raw: 'failed to push, retrying later', note: '', age_seconds: 240 }))).toEqual(unknown)
    expect(displayedWorkerState(unavailable(report('resolved')))).toEqual(unknown)
    expect(displayedWorkerState(unavailable(report('')))).toEqual(unknown)
    expect(displayedWorkerState({ ...unavailable(report('working')), paths: {} })).toEqual(unknown)
  })

  it('keeps a live pane state as read', () => {
    expect(displayedWorkerState(unavailable(report('failed', 'build broke'), { current_state: { state: 'working', source: 'pane', detail: 'harness busy' } })))
      .toEqual({ state: 'working', detail: 'harness busy' })
    expect(displayedWorkerState(unavailable(report('blocked', 'need access'), { current_state: { state: 'idle', source: 'pane', detail: 'harness idle' } })))
      .toEqual({ state: 'idle', detail: 'harness idle' })
  })

  it('keeps unknown when the endpoint is dead or the state was not read from a pane', () => {
    const event = report('working')
    for (const endpoint of [{ exists: false, agent_alive: 'dead', status: 'dead' }, { exists: true, agent_alive: 'dead', status: 'alive' }, { exists: false }]) {
      expect(displayedWorkerState(unavailable(event, { endpoint }))).toEqual({ state: 'unknown', detail: 'harness state unavailable' })
    }
    const gone = { state: 'unknown', source: 'none', detail: 'backend target gone: fm:1 (agent gone, pane shell remains)' }
    expect(displayedWorkerState(unavailable(event, { current_state: gone, endpoint: { exists: true, agent_alive: 'not_checked', status: 'not_checked' } })))
      .toEqual({ state: 'unknown', detail: gone.detail })
    expect(displayedWorkerState(unavailable(event, { current_state: { state: 'unknown', detail: 'no source' } })))
      .toEqual({ state: 'unknown', detail: 'no source' })
  })

  it('never shows a second mate with an unknown state as its child outcome', () => {
    const child = (state: string) => ({
      state, note: `child kd-widget ${state}: build broke`, age_seconds: 240,
      raw: `${state} [key=child-outcome-kd-widget-${state}-0a1b2c3d] [at=1790000000]: child kd-widget ${state}: build broke`,
    })
    const mate = (event: Record<string, unknown>, over: MateSnapshot = {}) => unavailable(event, { kind: 'secondmate', ...over })
    expect(displayedWorkerState(mate(child('failed')), waiting)).toEqual({ state: 'idle', detail: 'child kd-widget failed: build broke · last report 4m ago' })
    expect(displayedWorkerState(mate(child('done')), busy)).toEqual({ state: 'working', detail: 'child kd-widget done: build broke · last report 4m ago' })
    expect(displayedWorkerState(mate(child('failed'), { endpoint: { exists: true } }), null).state).toBe('unknown')
    const fallback = { state: 'failed', note: 'inactive terminal child=kd-widget fingerprint=0a1b', age_seconds: 240, raw: 'failed [key=inactive-outcome-kd-kd-widget-failed] [at=1790000000]: inactive terminal child=kd-widget fingerprint=0a1b' }
    expect(displayedWorkerState(mate(fallback), waiting).state).toBe('idle')
    expect(displayedWorkerState(unavailable(child('failed')), null).state).toBe('failed')
  })
})

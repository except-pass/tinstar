import { describe, it, expect } from 'vitest'
import {
  isSafeTaskId, parseLedgerLine, reduceLines, reduceRecord, runStatusFor,
  MAX_STATUS_TEXT, type FleetState,
} from './reducer'

const j = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o })
const dispatched = (task: string, ts: number, extra: Record<string, unknown> = {}) =>
  j({ ts, event: 'task.dispatched', task, kind: 'ship', project: 'webapp', harness: 'claude', model: null, ...extra })
const status = (task: string, ts: number, state: string | null, text: string, key: string | null = null) =>
  j({ ts, event: 'task.status', task, state, key, text })

function fold(lines: string[]): FleetState {
  const s: FleetState = new Map()
  reduceLines(s, lines)
  return s
}

describe('fleet ledger reducer', () => {
  it('folds the contract example into one worker', () => {
    const s = fold([
      dispatched('fix-login', 10),
      status('fix-login', 20, 'working', ' bug reproduced'),
      status('fix-login', 30, 'done', ' PR https://github.com/acme/webapp/pull/7 checks green'),
      j({ ts: 31, event: 'task.pr_ready', task: 'fix-login', pr: 'https://github.com/acme/webapp/pull/7' }),
      j({ ts: 40, event: 'task.merged', task: 'fix-login', via: 'pr', pr: 'https://github.com/acme/webapp/pull/7' }),
    ])
    const w = s.get('fix-login')!
    expect(w).toMatchObject({ kind: 'ship', project: 'webapp', harness: 'claude', model: null, dispatchedAt: 10 })
    expect(w.lastStatus).toMatchObject({ state: 'done', text: 'PR https://github.com/acme/webapp/pull/7 checks green' })
    expect(w.pr).toBe('https://github.com/acme/webapp/pull/7')
    expect(w.merged).toMatchObject({ via: 'pr' })
    expect(w.cleanedUpAt).toBeNull()
    expect(runStatusFor(w)).toBe('idle')
  })

  it('ignores unknown events, unknown members, malformed lines and unsafe task ids', () => {
    const s = fold([
      'not json', '', '[1,2]', '42',
      j({ ts: 1, event: 'task.teleported', task: 'a' }),
      j({ ts: 1, event: 'task.status', task: '../etc/passwd', state: 'working', key: null, text: 'x' }),
      j({ ts: 1, event: 'task.status', task: 'a/b', state: 'working', key: null, text: 'x' }),
      j({ event: 'task.status', task: 'nots', state: 'working' }),
      j({ ts: 2, event: 'task.status', task: 'ok', state: 'working', key: null, text: 't', futureMember: { a: 1 } }),
    ])
    expect([...s.keys()]).toEqual(['ok'])
  })

  it('validates task ids', () => {
    expect(isSafeTaskId('fix-login')).toBe(true)
    expect(isSafeTaskId('a.b_c-1')).toBe(true)
    for (const bad of ['', '.hidden', '..', 'a..b', 'a/b', 'a b', 5, null, 'x'.repeat(200)]) {
      expect(isSafeTaskId(bad)).toBe(false)
    }
  })

  it('is idempotent for duplicated records', () => {
    const lines = [dispatched('t', 10), status('t', 20, 'needs-decision', ' pick one', 'k1')]
    const once = fold(lines)
    const twice = fold([...lines, ...lines])
    expect(twice).toEqual(once)
  })

  it('creates a worker from a status that arrives before its dispatched record', () => {
    const s = fold([status('t', 5, 'working', ' hi'), dispatched('t', 6)])
    const w = s.get('t')!
    expect(w.lastStatus?.text).toBe('hi')
    expect(w.kind).toBe('ship')
  })

  it('builds a card from status alone when the dispatched record never existed', () => {
    const w = fold([status('t', 5, 'working', ' hi')]).get('t')!
    expect(w.dispatchedAt).toBeNull()
    expect(w.kind).toBeNull()
    expect(runStatusFor(w)).toBe('running')
  })

  it('opens decisions on needs-decision/blocked and closes them on resolved/captain-held by key', () => {
    const s = fold([
      dispatched('t', 1),
      status('t', 2, 'needs-decision', ' a?', 'ka'),
      status('t', 3, 'blocked', ' stuck'),
      status('t', 4, 'needs-decision', ' b?', 'kb'),
    ])
    expect(Object.keys(s.get('t')!.openDecisions).sort()).toEqual(['default', 'ka', 'kb'])
    reduceLines(s, [status('t', 5, 'resolved', ' ok', 'ka'), status('t', 6, 'captain-held', ' held', 'kb'), status('t', 7, 'resolved', ' ok')])
    expect(s.get('t')!.openDecisions).toEqual({})
  })

  it('maps ledger status onto run status', () => {
    const st = (state: string | null) => runStatusFor(fold([dispatched('t', 1), status('t', 2, state, ' x')]).get('t')!)
    expect(st('working')).toBe('running')
    expect(st('needs-decision')).toBe('needs_attention')
    expect(st('blocked')).toBe('needs_attention')
    expect(st('failed')).toBe('needs_attention')
    expect(st('paused')).toBe('idle')
    expect(st('done')).toBe('idle')
    expect(st(null)).toBe('running')
    expect(st('some-future-state')).toBe('running')
  })

  it('caps status text and keeps it verbatim (no markup interpretation)', () => {
    const w = fold([status('t', 1, 'working', ' ' + '<b>x</b>'.repeat(1000))]).get('t')!
    expect(w.lastStatus!.text.length).toBe(MAX_STATUS_TEXT)
    expect(w.lastStatus!.text.startsWith('<b>x</b>')).toBe(true)
  })

  it('keeps the newer status when an older one is replayed', () => {
    const w = fold([status('t', 10, 'done', ' new'), status('t', 5, 'working', ' old')]).get('t')!
    expect(w.lastStatus?.text).toBe('new')
  })

  it('marks cleaned_up, and a newer dispatch of the same id starts a fresh worker', () => {
    const s = fold([
      dispatched('t', 1), status('t', 2, 'blocked', ' x'),
      j({ ts: 3, event: 'task.pr_ready', task: 't', pr: 'https://x/pr/1' }),
      j({ ts: 4, event: 'task.cleaned_up', task: 't' }),
    ])
    expect(s.get('t')!.cleanedUpAt).toBe(4)
    reduceRecord(s, JSON.parse(dispatched('t', 100, { kind: 'scout' })))
    const w = s.get('t')!
    expect(w).toMatchObject({ kind: 'scout', cleanedUpAt: null, pr: null, dispatchedAt: 100 })
    expect(w.openDecisions).toEqual({})
    expect(w.lastStatus).toBeNull()
  })

  it('a replayed dispatch at or before a cleanup does not revive the finished worker', () => {
    const s = fold([dispatched('t', 1), j({ ts: 5, event: 'task.cleaned_up', task: 't' }), dispatched('t', 1), dispatched('t', 5)])
    expect(s.get('t')).toMatchObject({ cleanedUpAt: 5, dispatchedAt: 1 })
  })

  it('parseLedgerLine returns null for non-objects', () => {
    expect(parseLedgerLine('{"a":1}')).toEqual({ a: 1 })
    expect(parseLedgerLine('null')).toBeNull()
  })
})

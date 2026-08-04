/**
 * Characterization: the OTLP-derived telemetry surface Claude Code gives us.
 *
 * Claude Code exports cost/token/active-time counters over OTLP; Alloy relabels
 * them and remote-writes to Prometheus; TelemetryQuery reads them back as
 * PromQL. Every one of those three hops bakes in `claude_code_*` metric names
 * and Claude-shaped labels, so this file freezes:
 *
 *   - the exact PromQL emitted for a fixed clock and a fixed session,
 *   - the snapshot derived from a canned Prometheus response set,
 *   - what happens when Prometheus returns nothing (nulls, never zeros),
 *   - the Alloy attribute→label mapping the pipeline depends on,
 *   - the Tinstar-side turn-length metric, whose label names are also
 *     Claude-specific (`cc_conversation_id`).
 *
 * Providers with different OTel event names are normalized before this query surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { TelemetryQuery } from '../../observability/query'
import { turnLengthHist, getMetricsText, _resetForTests } from '../../observability/turn-length'
import { loadClaudeTelemetryFixture } from '../index'

const fx = loadClaudeTelemetryFixture()

/** Serve `promResponses` by first-matching rule; anything unmatched is empty. */
function stubProm(rules = fx.promResponses): { queries: string[] } {
  const queries: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    const q = new URL(url, 'http://prom').searchParams.get('query') ?? ''
    queries.push(q)
    const rule = rules.find(r => r.match.every(m => q.includes(m)))
    const isRange = url.includes('/query_range')
    const result = (rule?.result ?? []).map(r =>
      isRange ? { metric: r.metric, values: [r.value] } : r,
    )
    return {
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: isRange ? 'matrix' : 'vector', result } }),
    }
  })
  return { queries }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse(fx.clock.systemTimeIso))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the PromQL Claude telemetry is read through', () => {
  it('issues the frozen global today-window queries, in order', async () => {
    const { queries } = stubProm()
    await new TelemetryQuery('http://prom').todayHud({
      userEmail: fx.opts.userEmail,
      tzOffsetMinutes: fx.clock.tzOffsetMinutes,
    })
    expect(queries).toEqual(fx.expectedQueries.todayHudGlobal)
  })

  it('swaps increase()-over-window for the raw counter when scoped to one session', async () => {
    const { queries } = stubProm()
    await new TelemetryQuery('http://prom').todayHud({
      userEmail: fx.opts.userEmail,
      tzOffsetMinutes: fx.clock.tzOffsetMinutes,
      sessionId: fx.opts.sessionId,
    })
    expect(queries).toEqual(fx.expectedQueries.todayHudSession)
    // Cost still uses increase() (total + by-model); the token queries drop it
    // entirely, because a per-session counter is already a stable cumulative.
    expect(queries.filter(q => q.includes('increase('))).toHaveLength(2)
    expect(queries.filter(q => q.includes('increase(claude_code_token_usage'))).toHaveLength(0)
  })

  it('detects burning sessions with a single 30s rate aggregation by session_id', async () => {
    const { queries } = stubProm()
    await new TelemetryQuery('http://prom').burningSessions({ userEmail: fx.opts.userEmail })
    expect(queries).toEqual(fx.expectedQueries.burningSessions)
  })

  it('issues the frozen per-session sparkline range queries', async () => {
    const { queries } = stubProm()
    await new TelemetryQuery('http://prom').sessionSeries({
      sessionId: fx.opts.sessionId,
      userEmail: fx.opts.userEmail,
      endSec: 1785434400,
      windowSec: 300,
      stepSec: 5,
    })
    expect(queries).toEqual(fx.expectedQueries.sessionSeries)
  })

  it('only ever names three metrics and four label dimensions', () => {
    const all = [
      ...fx.expectedQueries.todayHudGlobal,
      ...fx.expectedQueries.todayHudSession,
      ...fx.expectedQueries.burningSessions,
      ...fx.expectedQueries.sessionSeries,
    ].join('\n')
    const metrics = new Set(all.match(/claude_code_[a-z_A-Z]+/g) ?? [])
    expect([...metrics].sort()).toEqual([...fx.metricInventory.metrics].sort())
    for (const label of fx.metricInventory.labels) expect(all).toContain(label)
    for (const sel of fx.metricInventory.typeSelectors) expect(all).toContain(sel)
  })
})

describe('the snapshot derived from a populated Prometheus', () => {
  it('matches the frozen expectation field for field', async () => {
    stubProm()
    const snap = await new TelemetryQuery('http://prom').todayHud({
      userEmail: fx.opts.userEmail,
      tzOffsetMinutes: fx.clock.tzOffsetMinutes,
    })
    expect(snap).toEqual(fx.expectedSnapshot)
  })

  it('floors the token total but leaves cost and ratios unrounded', async () => {
    stubProm()
    const snap = await new TelemetryQuery('http://prom').todayHud({
      userEmail: fx.opts.userEmail,
      tzOffsetMinutes: fx.clock.tzOffsetMinutes,
    })
    // The canned windowed token value is 1250000.7.
    expect(snap.tokens.total).toBe(1250000)
    expect(snap.cost.total).toBe(12.5)
    expect(snap.cacheHitPct).toBe(0.86)
  })

  it('clamps an over-extrapolated window value to the current cumulative counter', async () => {
    // increase() over a churning counter can report more than has ever been
    // spent; the current total is the ceiling. Here: window 999 vs ceiling 40.
    stubProm([
      { match: ['increase(claude_code_cost_usage_USD_total'], result: [{ metric: {}, value: [0, '999'] }] },
      { match: ['claude_code_cost_usage_USD_total'], result: [{ metric: {}, value: [0, '40'] }] },
    ])
    const snap = await new TelemetryQuery('http://prom').todayHud({
      userEmail: fx.opts.userEmail,
      tzOffsetMinutes: fx.clock.tzOffsetMinutes,
    })
    expect(snap.cost.total).toBe(40)
  })
})

describe('the snapshot when Prometheus has nothing', () => {
  it('reports null everywhere rather than zero', async () => {
    stubProm([])
    const snap = await new TelemetryQuery('http://prom').todayHud({
      userEmail: fx.opts.userEmail,
      tzOffsetMinutes: fx.clock.tzOffsetMinutes,
    })
    expect(snap).toEqual({
      window: 'today',
      state: 'ready',
      cost: { total: null, byModel: {} },
      tokens: { total: null },
      rate: { perMin: null, perHour: null },
      cacheHitPct: null,
      dutyCycle: { value: null, windowMinutes: 5 },
    })
  })

  it('returns no burning sessions rather than throwing', async () => {
    stubProm([])
    await expect(
      new TelemetryQuery('http://prom').burningSessions({ userEmail: fx.opts.userEmail }),
    ).resolves.toEqual([])
  })

  it('serves the last good snapshot with a staleness marker when the query fails', async () => {
    stubProm()
    const q = new TelemetryQuery('http://prom')
    const good = await q.todayHud({ userEmail: fx.opts.userEmail, tzOffsetMinutes: fx.clock.tzOffsetMinutes })

    vi.stubGlobal('fetch', async () => { throw new Error('prom down') })
    vi.setSystemTime(Date.parse(fx.clock.systemTimeIso) + 42_000)
    const stale = await q.todayHud({ userEmail: fx.opts.userEmail, tzOffsetMinutes: fx.clock.tzOffsetMinutes })
    expect(stale).toEqual({ ...good, staleSeconds: 42 })
  })

  it('throws when the very first query fails — there is no snapshot to fall back to', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('prom down') })
    await expect(
      new TelemetryQuery('http://prom').todayHud({ userEmail: fx.opts.userEmail, tzOffsetMinutes: 0 }),
    ).rejects.toThrow()
  })
})

describe('the collector pipeline the metrics arrive through', () => {
  const alloy = readFileSync(new URL('../../observability/templates/alloy-config.alloy.tmpl', import.meta.url), 'utf-8')

  it('receives OTLP over HTTP and remote-writes to Prometheus', () => {
    expect(alloy).toContain('otelcol.receiver.otlp')
    expect(alloy).toContain('prometheus.remote_write')
  })

  it('promotes the `tinstar.session` resource attribute to a `tinstar_session` label', () => {
    // This is the one Tinstar-owned join key on an otherwise vendor-shaped
    // metric — a second provider needs the same attribute for its series to be
    // addressable by session.
    expect(alloy).toContain('key = "tinstar_session"')
    expect(alloy).toContain('from_attribute = "tinstar.session"')
  })
})

describe('the Tinstar-side turn-length metric', () => {
  afterEach(() => { _resetForTests() })

  it('is named and labelled for Claude specifically', async () => {
    turnLengthHist.labels('demo-session', 'conv-1').observe(12)
    const text = await getMetricsText()
    expect(text).toContain('tinstar_turn_length_seconds')
    // `cc_conversation_id` is Claude vocabulary on a Tinstar-owned metric — a
    // rename target once a second provider records turns.
    expect(text).toContain('cc_conversation_id="conv-1"')
    expect(text).toContain('tinstar_session="demo-session"')
  })
})

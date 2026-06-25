import { describe, it, expect, beforeEach } from 'vitest'
import { OTelStore } from '../otel-store'
import type { Span, Metric, SpanEvent } from '../../types'

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'test-span',
    kind: 'server',
    startTime: '2026-01-01T00:00:00Z',
    status: 'unset',
    attributes: {},
    events: [],
    ...overrides,
  }
}

function makeMetric(overrides: Partial<Metric> = {}): Metric {
  return {
    name: 'test_metric',
    type: 'gauge',
    value: 42,
    labels: {},
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('OTelStore', () => {
  let store: OTelStore

  beforeEach(() => {
    store = new OTelStore()
  })

  describe('spans', () => {
    it('addSpan stores a span retrievable via getAllSpans', () => {
      const span = makeSpan()
      store.addSpan(span)
      expect(store.getAllSpans()).toEqual([span])
    })

    it('endSpan sets endTime and status on matching span', () => {
      store.addSpan(makeSpan({ traceId: 't1', spanId: 's1' }))
      store.endSpan('s1', 't1', '2026-01-01T01:00:00Z', 'ok')
      const spans = store.getAllSpans()
      expect(spans[0]!.endTime).toBe('2026-01-01T01:00:00Z')
      expect(spans[0]!.status).toBe('ok')
    })

    it('endSpan is a no-op when span not found', () => {
      store.addSpan(makeSpan({ traceId: 't1', spanId: 's1' }))
      store.endSpan('s999', 't1', '2026-01-01T01:00:00Z', 'ok')
      expect(store.getAllSpans()[0]!.status).toBe('unset')
    })

    it('addSpanEvent appends event to matching span', () => {
      store.addSpan(makeSpan({ spanId: 's1' }))
      const event: SpanEvent = {
        name: 'file_touched',
        timestamp: '2026-01-01T00:30:00Z',
        attributes: { 'file.name': 'foo.ts' },
      }
      store.addSpanEvent('s1', event)
      expect(store.getAllSpans()[0]!.events).toEqual([event])
    })

    it('addSpanEvent is a no-op when span not found', () => {
      store.addSpan(makeSpan({ spanId: 's1' }))
      store.addSpanEvent('s999', { name: 'x', timestamp: '', attributes: {} })
      expect(store.getAllSpans()[0]!.events).toEqual([])
    })

    it('getSpansByTrace filters by traceId', () => {
      store.addSpan(makeSpan({ traceId: 't1', spanId: 's1' }))
      store.addSpan(makeSpan({ traceId: 't2', spanId: 's2' }))
      store.addSpan(makeSpan({ traceId: 't1', spanId: 's3' }))
      expect(store.getSpansByTrace('t1')).toHaveLength(2)
      expect(store.getSpansByTrace('t2')).toHaveLength(1)
      expect(store.getSpansByTrace('t-none')).toHaveLength(0)
    })
  })

  describe('metrics', () => {
    it('recordMetric stores a metric retrievable via getAllMetrics', () => {
      const m = makeMetric()
      store.recordMetric(m)
      expect(store.getAllMetrics()).toEqual([m])
    })

    it('getMetricsByName filters by name', () => {
      store.recordMetric(makeMetric({ name: 'active_runs', value: 1 }))
      store.recordMetric(makeMetric({ name: 'files_touched', value: 3 }))
      store.recordMetric(makeMetric({ name: 'active_runs', value: 2 }))
      expect(store.getMetricsByName('active_runs')).toHaveLength(2)
      expect(store.getMetricsByName('files_touched')).toHaveLength(1)
      expect(store.getMetricsByName('nope')).toHaveLength(0)
    })
  })

  describe('clear', () => {
    it('removes all spans and metrics', () => {
      store.addSpan(makeSpan())
      store.recordMetric(makeMetric())
      store.clear()
      expect(store.getAllSpans()).toEqual([])
      expect(store.getAllMetrics()).toEqual([])
    })
  })
})

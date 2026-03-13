import type { Span, Metric, SpanEvent } from '../types'

export class OTelStore {
  private spans: Span[] = []
  private metrics: Metric[] = []

  addSpan(span: Span): void {
    this.spans.push(span)
  }

  endSpan(spanId: string, traceId: string, endTime: string, status: Span['status']): void {
    const span = this.spans.find(s => s.spanId === spanId && s.traceId === traceId)
    if (span) {
      span.endTime = endTime
      span.status = status
    }
  }

  addSpanEvent(spanId: string, event: SpanEvent): void {
    const span = this.spans.find(s => s.spanId === spanId)
    if (span) {
      span.events.push(event)
    }
  }

  recordMetric(metric: Metric): void {
    this.metrics.push(metric)
  }

  getSpansByTrace(traceId: string): Span[] {
    return this.spans.filter(s => s.traceId === traceId)
  }

  getMetricsByName(name: string): Metric[] {
    return this.metrics.filter(m => m.name === name)
  }

  getAllSpans(): Span[] {
    return this.spans
  }

  getAllMetrics(): Metric[] {
    return this.metrics
  }

  clear(): void {
    this.spans = []
    this.metrics = []
  }
}

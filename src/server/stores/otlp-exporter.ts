import type { Span, Metric, SpanEvent } from '../types'

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'
const FLUSH_INTERVAL_MS = 5_000

// --- OTLP JSON wire format helpers ---

function spanKindToOtlp(kind: Span['kind']): number {
  return kind === 'server' ? 2 : kind === 'client' ? 3 : 1 // INTERNAL=1, SERVER=2, CLIENT=3
}

function statusToOtlp(status: Span['status']): { code: number } {
  return status === 'ok' ? { code: 1 } : status === 'error' ? { code: 2 } : { code: 0 }
}

function toNanos(iso: string): string {
  return String(new Date(iso).getTime() * 1_000_000)
}

function attrsToOtlp(attrs: Record<string, string | number | boolean>): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attrs).map(([key, val]) => ({
    key,
    value: typeof val === 'string' ? { stringValue: val }
      : typeof val === 'number' ? (Number.isInteger(val) ? { intValue: val } : { doubleValue: val })
      : { boolValue: val },
  }))
}

function eventsToOtlp(events: SpanEvent[]): Array<Record<string, unknown>> {
  return events.map(e => ({
    timeUnixNano: toNanos(e.timestamp),
    name: e.name,
    attributes: attrsToOtlp(e.attributes),
  }))
}

function spansToOtlpPayload(spans: Span[]): unknown {
  return {
    resourceSpans: [{
      resource: {
        attributes: attrsToOtlp({ 'service.name': 'tinstar' }),
      },
      scopeSpans: [{
        scope: { name: 'tinstar', version: '3.1.0' },
        spans: spans.map(s => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId ?? '',
          name: s.name,
          kind: spanKindToOtlp(s.kind),
          startTimeUnixNano: toNanos(s.startTime),
          endTimeUnixNano: s.endTime ? toNanos(s.endTime) : toNanos(s.startTime),
          status: statusToOtlp(s.status),
          attributes: attrsToOtlp(s.attributes),
          events: eventsToOtlp(s.events),
        })),
      }],
    }],
  }
}

function metricsToOtlpPayload(metrics: Metric[]): unknown {
  // Group metrics by name
  const byName = new Map<string, Metric[]>()
  for (const m of metrics) {
    const arr = byName.get(m.name) ?? []
    arr.push(m)
    byName.set(m.name, arr)
  }

  const otlpMetrics = []
  for (const [name, items] of byName) {
    const first = items[0]
    const dataPoints = items.map(m => ({
      timeUnixNano: toNanos(m.timestamp),
      asInt: m.type === 'counter' ? m.value : undefined,
      asDouble: m.type === 'gauge' ? m.value : undefined,
      attributes: attrsToOtlp(m.labels),
    }))

    if (first.type === 'gauge') {
      otlpMetrics.push({ name, gauge: { dataPoints } })
    } else {
      otlpMetrics.push({ name, sum: { dataPoints, isMonotonic: true, aggregationTemporality: 2 } })
    }
  }

  return {
    resourceMetrics: [{
      resource: {
        attributes: attrsToOtlp({ 'service.name': 'tinstar' }),
      },
      scopeMetrics: [{
        scope: { name: 'tinstar', version: '3.1.0' },
        metrics: otlpMetrics,
      }],
    }],
  }
}

// --- Exporter class ---

export class OtlpExporter {
  private pendingSpans: Span[] = []
  private pendingMetrics: Metric[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.flush()
  }

  pushSpan(span: Span): void {
    this.pendingSpans.push(structuredClone(span))
  }

  pushMetric(metric: Metric): void {
    this.pendingMetrics.push(structuredClone(metric))
  }

  private async flush(): Promise<void> {
    if (this.pendingSpans.length > 0) {
      const spans = this.pendingSpans.splice(0)
      try {
        await fetch(`${OTLP_ENDPOINT}/v1/traces`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(spansToOtlpPayload(spans)),
        })
      } catch {
        // Alloy not reachable — drop silently
      }
    }

    if (this.pendingMetrics.length > 0) {
      const metrics = this.pendingMetrics.splice(0)
      try {
        await fetch(`${OTLP_ENDPOINT}/v1/metrics`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(metricsToOtlpPayload(metrics)),
        })
      } catch {
        // Alloy not reachable — drop silently
      }
    }
  }
}

// --- OTel Types (plain interfaces, not SDK) ---

export interface SpanEvent {
  name: string
  timestamp: string
  attributes: Record<string, string | number | boolean>
}

export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'internal' | 'server' | 'client'
  startTime: string
  endTime?: string
  status: 'unset' | 'ok' | 'error'
  attributes: Record<string, string | number | boolean>
  events: SpanEvent[]
}

export interface Metric {
  name: string
  type: 'gauge' | 'counter'
  value: number
  labels: Record<string, string>
  timestamp: string
}

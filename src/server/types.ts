import type {
  RunStatus,
  TouchedFile,
  Procedure,
  RecapEntry,
} from '../types'

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

// --- Event Taxonomy (discriminated union) ---

export interface SessionCreatedPayload {
  sessionId: string
  initiativeId: string
  epicId: string
  taskId: string
  worktreeId: string
}

export interface SessionStateChangedPayload {
  sessionId: string
  state: 'active' | 'idle' | 'disconnected'
}

export interface SessionDeletedPayload {
  sessionId: string
}

export interface TaxonomySyncPayload {
  initiatives: Array<{ id: string; name: string; color: string; status: 'active' | 'paused' | 'archived'; summary: string }>
  epics: Array<{ id: string; name: string; initiativeId: string; status: string; summary: string }>
  tasks: Array<{ id: string; name: string; epicId: string; initiativeId: string; status: string; summary: string }>
  worktrees: Array<{ id: string; name: string; branch: string; repo: string; worktreePath: string }>
}

export interface RunCreatedPayload {
  id: string
  status: RunStatus
  sessionId: string
  initiative: string
  epic: string
  task: string
  repo: string
  worktree: string
  taskId: string
  worktreeId: string
  createdAt: string
}

export interface RunUpdatedPayload {
  id: string
  status: RunStatus
}

export interface RunCompletedPayload {
  id: string
  status: 'complete' | 'failed'
}

export interface RunFileTouchedPayload {
  runId: string
  file: TouchedFile
}

export interface RunProcedureUpdatedPayload {
  runId: string
  procedure: Procedure
}

export interface RunRecapAddedPayload {
  runId: string
  entry: RecapEntry
}

export interface OtelSpanStartedPayload {
  span: Omit<Span, 'endTime'>
}

export interface OtelSpanEndedPayload {
  spanId: string
  traceId: string
  endTime: string
  status: Span['status']
}

export interface OtelMetricRecordedPayload {
  metric: Metric
}

// --- Discriminated union ---

export type BusEvent =
  | { type: 'session.created'; timestamp: string; payload: SessionCreatedPayload }
  | { type: 'session.state_changed'; timestamp: string; payload: SessionStateChangedPayload }
  | { type: 'session.deleted'; timestamp: string; payload: SessionDeletedPayload }
  | { type: 'taxonomy.sync'; timestamp: string; payload: TaxonomySyncPayload }
  | { type: 'run.created'; timestamp: string; payload: RunCreatedPayload }
  | { type: 'run.updated'; timestamp: string; payload: RunUpdatedPayload }
  | { type: 'run.completed'; timestamp: string; payload: RunCompletedPayload }
  | { type: 'run.file_touched'; timestamp: string; payload: RunFileTouchedPayload }
  | { type: 'run.procedure_updated'; timestamp: string; payload: RunProcedureUpdatedPayload }
  | { type: 'run.recap_added'; timestamp: string; payload: RunRecapAddedPayload }
  | { type: 'otel.span_started'; timestamp: string; payload: OtelSpanStartedPayload }
  | { type: 'otel.span_ended'; timestamp: string; payload: OtelSpanEndedPayload }
  | { type: 'otel.metric_recorded'; timestamp: string; payload: OtelMetricRecordedPayload }

export type BusEventType = BusEvent['type']

// Extract payload type for a given event type
export type PayloadFor<T extends BusEventType> = Extract<BusEvent, { type: T }>['payload']

// --- SSE message types ---

export interface SSESnapshot {
  type: 'snapshot'
  data: {
    initiatives: Array<{ id: string; name: string; color: string; status: string; summary: string }>
    epics: Array<{ id: string; name: string; initiativeId: string; status: string; summary: string }>
    tasks: Array<{ id: string; name: string; epicId: string; initiativeId: string; status: string; summary: string }>
    worktrees: Array<{ id: string; name: string; branch: string; repo: string; worktreePath: string }>
    runs: Array<Record<string, unknown>>
  }
}

export interface SSEDelta {
  type: 'delta'
  data: {
    eventType: BusEventType
    entity: string
    id: string
    data: unknown
  }
}

export type SSEMessage = SSESnapshot | SSEDelta | { type: 'heartbeat' }

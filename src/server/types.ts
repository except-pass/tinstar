import type {
  SessionStatus,
  RunStatus,
  TouchedFile,
  RecapEntry,
} from '../types'
import type { CommitRecord } from './commits'

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

// --- Session management payloads (from session manager) ---

export interface ManagedSessionCreatedPayload {
  name: string
  state: SessionStatus
}

export interface ManagedSessionStateChangedPayload {
  name: string
  state: SessionStatus
}

export interface ManagedSessionDeletedPayload {
  name: string
}

export interface ManagedSessionNatsOrphanedPayload {
  name: string
  orphanedAt: string
  reason: string
  restartRecommended: boolean
}

export interface SessionDeletedPayload {
  sessionId: string
}

export interface TaxonomySyncPayload {
  initiatives: Array<{ id: string; name: string; color: string; status: 'active' | 'paused' | 'archived'; summary: string }>
  epics: Array<{ id: string; name: string; initiativeId: string; status: string; summary: string }>
  tasks: Array<{ id: string; name: string; epicId: string; initiativeId: string; status: string; externalUrl?: string | null }>
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
  status: 'stopped'
}

export interface RunFileTouchedPayload {
  runId: string
  file: TouchedFile
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

export interface PluginWidgetUpdatedPayload {
  id: string
  pluginId: string
  widgetType: string
  spaceId: string
  position: { x: number; y: number }
  size: { width: number; height: number }
  data: unknown
  createdAt: string
  updatedAt: string
}

// --- Discriminated union ---
//
// Adding a new event:
//   1. Declare a `<Name>Payload` interface above.
//   2. Add a `| { type: '<name>'; timestamp: string; payload: <Name>Payload }` variant below.
//   3. Call sites use `emitSessionEvent('<name>', payload)` — the helper is
//      typed `<T extends BusEventType>(type: T, payload: PayloadFor<T>)`, so
//      step 3 fails to compile if you skip 1 or 2.
//
// Don't add an emit site that casts via `as unknown as Parameters<...>[0]` —
// the cast was historical rot and hid two live mismatches before the V5.0
// audit. See docs/conventions.md → "Adding a new BusEvent".

export type BusEvent =
  | { type: 'session.created'; timestamp: string; payload: SessionCreatedPayload }
  | { type: 'session.state_changed'; timestamp: string; payload: SessionStateChangedPayload }
  | { type: 'session.deleted'; timestamp: string; payload: SessionDeletedPayload }
  | { type: 'taxonomy.sync'; timestamp: string; payload: TaxonomySyncPayload }
  | { type: 'run.created'; timestamp: string; payload: RunCreatedPayload }
  | { type: 'run.updated'; timestamp: string; payload: RunUpdatedPayload }
  | { type: 'run.completed'; timestamp: string; payload: RunCompletedPayload }
  | { type: 'run.file_touched'; timestamp: string; payload: RunFileTouchedPayload }
  | { type: 'run.recap_added'; timestamp: string; payload: RunRecapAddedPayload }
  | { type: 'otel.span_started'; timestamp: string; payload: OtelSpanStartedPayload }
  | { type: 'otel.span_ended'; timestamp: string; payload: OtelSpanEndedPayload }
  | { type: 'otel.metric_recorded'; timestamp: string; payload: OtelMetricRecordedPayload }
  | { type: 'managed_session.created'; timestamp: string; payload: ManagedSessionCreatedPayload }
  | { type: 'managed_session.state_changed'; timestamp: string; payload: ManagedSessionStateChangedPayload }
  | { type: 'managed_session.deleted'; timestamp: string; payload: ManagedSessionDeletedPayload }
  | { type: 'managed_session.nats_orphaned'; timestamp: string; payload: ManagedSessionNatsOrphanedPayload }
  | { type: 'ready_queue.update'; timestamp: string; payload: { queue: string[] } }
  | { type: 'pluginWidget.updated'; timestamp: string; payload: PluginWidgetUpdatedPayload }

export type BusEventType = BusEvent['type']

// Extract payload type for a given event type
export type PayloadFor<T extends BusEventType> = Extract<BusEvent, { type: T }>['payload']

// --- SSE message types ---

export interface SSESnapshot {
  type: 'snapshot'
  data: {
    initiatives: Array<{ id: string; name: string; color: string; status: string; summary: string }>
    epics: Array<{ id: string; name: string; initiativeId: string; status: string; summary: string }>
    tasks: Array<{ id: string; name: string; epicId: string; initiativeId: string; status: string; externalUrl?: string | null }>
    worktrees: Array<{ id: string; name: string; branch: string; repo: string; worktreePath: string }>
    runs: Array<Record<string, unknown>>
    commits: CommitRecord[]
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

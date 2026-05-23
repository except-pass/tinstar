// Application API envelope. See docs/adrs/0001-response-envelope.md.
//
// All application API endpoints return ApiResponse<T> — Ok<T> or Err.
// Wire-protocol endpoints (OpenAPI spec, OTLP/Prom exports, /api/state SSE
// snapshot, cc-quota snapshot) are documented exceptions and return raw
// JSON; they're listed in the ADR.

/** Machine-readable error categories. Closed union — adding a new code
 *  requires an ADR amendment so the taxonomy doesn't drift. */
export type ErrorCode =
  // Client errors (4xx)
  | 'BAD_REQUEST'             // malformed JSON, missing required field, wrong type
  | 'INVALID_PARAMS'          // semantic validation failed (range, format, enum mismatch)
  | 'NOT_FOUND'               // entity by id not found
  | 'SESSION_NOT_FOUND'       // session lookup miss — kept distinct; frontend treats it differently
  | 'CONFLICT'                // would violate uniqueness / state precondition
  | 'PATH_OUTSIDE_WORKSPACE'  // path-traversal guard hit
  | 'FORBIDDEN'               // permission/safety guard
  // Server errors (5xx)
  | 'INTERNAL'                // unexpected throw, last-resort catch-all
  | 'BACKEND_UNAVAILABLE'     // tmux / external service not reachable
  | 'BRIDGE_UNAVAILABLE'      // NATS bridge specifically (disabled or never started)
  | 'CONFIG_UNAVAILABLE'      // sessionConfig hasn't loaded yet
  | 'LIST_FAILED'             // a list/enumerate operation failed mid-flight

/** Soft-failure carrier on a successful response. Operation succeeded but
 *  consumer should surface the warnings. Current use: { nats: NatsWarning[] }. */
export type WarningMap = Record<string, unknown[]>

export interface Ok<T> {
  ok: true
  data: T
  warnings?: WarningMap
}

export interface Err {
  ok: false
  error: {
    code: ErrorCode
    message: string
    /** Structured context for specific handlers (validation field maps,
     *  conflicting-state snapshots, etc.). Opaque to generic readers. */
    details?: unknown
  }
}

export type ApiResponse<T> = Ok<T> | Err

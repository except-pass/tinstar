// Application API response helpers. See docs/adrs/0001-response-envelope.md.

import type { ServerResponse } from 'node:http'
import type { ErrorCode, WarningMap } from '../../domain/api'

/** HTTP status auto-derived per ErrorCode. The fail() helper uses this so
 *  body.error.code and the HTTP status can't drift apart. Override with
 *  opts.status only when an endpoint has a documented reason. */
const HTTP_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  INVALID_PARAMS: 400,
  NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  CONFLICT: 409,
  PATH_OUTSIDE_WORKSPACE: 403,
  FORBIDDEN: 403,
  OVERRIDE_MODEL_NOT_CONFIGURED: 403,
  OVERRIDE_MODEL_NOT_ALLOWED: 403,
  OVERRIDE_TOKEN_DISABLED: 403,
  OVERRIDE_TOKEN_MALFORMED: 400,
  BACKEND_UNAVAILABLE: 503,
  BRIDGE_UNAVAILABLE: 503,
  CONFIG_UNAVAILABLE: 503,
  LIST_FAILED: 500,
  INTERNAL: 500,
}

type Headers = Record<string, string>

function write(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Headers,
): true {
  // Some routes respond asynchronously. If the client disconnected or another
  // codepath already wrote the response, don't crash with ERR_HTTP_HEADERS_SENT.
  if (res.headersSent || res.writableEnded) return true
  const allHeaders: Headers = {
    'Content-Type': 'application/json',
    ...(headers ?? { 'Access-Control-Allow-Origin': '*' }),
  }
  res.writeHead(status, allHeaders)
  res.end(JSON.stringify(body))
  return true
}

export interface OkOpts {
  warnings?: WarningMap
  status?: number
  /** Per-request CORS headers passed through from the route handler. */
  headers?: Headers
}

export function ok<T>(res: ServerResponse, data: T, opts: OkOpts = {}): true {
  const body: { ok: true; data: T; warnings?: WarningMap } = { ok: true, data }
  if (opts.warnings) body.warnings = opts.warnings
  return write(res, opts.status ?? 200, body, opts.headers)
}

export interface FailOpts {
  details?: unknown
  status?: number
  headers?: Headers
}

export function fail(
  res: ServerResponse,
  code: ErrorCode,
  message: string,
  opts: FailOpts = {},
): true {
  const body: { ok: false; error: { code: ErrorCode; message: string; details?: unknown } } = {
    ok: false,
    error: { code, message },
  }
  if (opts.details !== undefined) body.error.details = opts.details
  return write(res, opts.status ?? HTTP_STATUS[code], body, opts.headers)
}

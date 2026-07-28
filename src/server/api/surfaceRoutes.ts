// HTTP surface for the canonical Surface primitives (plan U3).
//
// This is a THIN ADAPTER and nothing else. It resolves the path, the acting
// principal, and the idempotency key, hands the raw parsed body straight to
// `SurfaceService`, and maps one result shape onto the response envelope. There
// is no validation here, no field whitelisting, and no conflict logic — all of
// that lives in the service, which is what makes the plan's test scenario "CLI
// commands and HTTP primitives report the same conflict and recovery states"
// true by construction rather than by two implementations agreeing for now.
//
// It lives in its own module rather than inside `routes.ts` for the same reason
// telemetry does: `routes.ts` is already 5,600 lines and a fifteen-endpoint
// resource appended to it is unreviewable. `handleRequest` delegates here on the
// `/api/surfaces` prefix.
//
// ROUTE ORDERING (docs/solutions/conventions/sub-resource-routes-under-prefix-matched-handlers.md):
// every route below matches an ANCHORED REGEX against the query-stripped path,
// and the collection-level verbs are listed first. Anchoring rather than
// `startsWith` is load-bearing twice over: it stops `POST /api/surfaces/group`
// being read as a Surface id, and it stops `DELETE /api/surfaces/:id/purge`
// falling through to the delete handler — which would ERASE what the caller
// asked to move to the recovery store, return 200, and look like it worked.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'
import type { ErrorCode } from '../../domain/api'
import type { SurfacePrincipalRef } from '../../domain/types'
import { ok, fail } from './envelope'
import { readBody } from './readBody'
import type { DocumentStore } from '../stores/document-store'
import { getSession } from '../sessions'
import { hasGraveyardSnapshot } from '../sessions/graveyard-snapshot'
import type { TinstarConfig } from '../sessions/config'
import {
  isSafePrincipalId,
  SurfaceService,
  type SurfaceCallContext,
  type SurfaceResult,
  type SurfaceServiceError,
} from '../surfaces/surface-service'
import type { SurfaceHostProbe } from '../surfaces/surface-context'
import { slateSourceAdapters } from '../surfaces/slate-source'

/** What this module needs from `RouteContext`. Narrowed deliberately: a handler
 *  that could reach NATS or the simulator would eventually be asked to. */
export interface SurfaceRouteContext {
  docStore: DocumentStore
  sessionConfig: TinstarConfig | null
}

/** Header carrying the caller's stable actor id. The browser sends the id it
 *  minted in `uiPrefs`; a managed session sends its session name.
 *
 *  THIS IS ROUTING IDENTITY, NOT AUTHENTICATION (KTD6). Tinstar has no human
 *  auth layer, the first release is explicitly one trusted local human, and a
 *  local process can put whatever it likes in a header. It exists so view state,
 *  audit entries, and prompt routing can tell a browser from a session — not to
 *  keep anything out. */
const ACTOR_HEADER = 'x-tinstar-actor'
const ACTOR_KIND_HEADER = 'x-tinstar-actor-kind'
const IDEMPOTENCY_HEADER = 'idempotency-key'

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && value.trim() ? value.trim() : undefined
}

/**
 * Who is calling.
 *
 * A direct local agent CLI call identifies as its managed session name, which is
 * the trusted-local routing identity the plan specifies. Absent any header the
 * caller is the local human — the only actor the first release has — rather than
 * an error, because refusing unlabelled calls would break every `curl` an agent
 * writes from a baked prompt without buying any actual safety.
 */
export function resolveActor(req: IncomingMessage): SurfacePrincipalRef {
  const id = header(req, ACTOR_HEADER)
  if (!id) return { kind: 'human', id: 'local' }
  const declared = header(req, ACTOR_KIND_HEADER)
  const kind = declared === 'session' || declared === 'job' || declared === 'process' || declared === 'human'
    ? declared
    : 'session'
  return { kind, id }
}

function callContext(req: IncomingMessage): SurfaceCallContext {
  const key = header(req, IDEMPOTENCY_HEADER)
  return { actor: resolveActor(req), ...(key ? { idempotencyKey: key } : {}) }
}

/** Map the service's failure taxonomy onto the closed `ErrorCode` union.
 *
 *  `faulted` and `write-failed` become 503-class codes rather than 500s: neither
 *  is a bug in the request, both are the host being unable to make anything
 *  durable, and a caller's correct response to both is to stop writing rather
 *  than to fix its payload. */
export function statusFor(error: SurfaceServiceError): ErrorCode {
  switch (error.code) {
    case 'not-found': return 'NOT_FOUND'
    case 'invalid': return 'INVALID_PARAMS'
    case 'conflict': return 'CONFLICT'
    case 'faulted': return 'BACKEND_UNAVAILABLE'
    case 'write-failed': return 'BACKEND_UNAVAILABLE'
  }
}

/** One place that turns a service result into a response, so no endpoint can
 *  invent its own error shape. The conflict details carry the authoritative
 *  records, which is what lets a UI restore true state without a snapshot. */
function respond<T>(
  res: ServerResponse, result: SurfaceResult<T>, cors: Record<string, string>, okStatus = 200,
): true {
  if (result.ok) return ok(res, result.data, { status: okStatus, headers: cors })
  const { error } = result
  return fail(res, statusFor(error), error.message, {
    headers: cors,
    details: {
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.current ? { current: error.current } : {}),
      ...(error.topologyRev !== undefined ? { topologyRev: error.topologyRev } : {}),
    },
  })
}

/** A parsed body, or the refusal to send instead of one. */
type BodyOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: ErrorCode; message: string; status?: number }

/**
 * Parse a JSON body, tolerating an empty one. Several primitives (`restore`,
 * `purge`, a leaf `delete`) have nothing to say, and demanding `{}` from them
 * would be ceremony a `curl` author trips over.
 *
 * `readBody` REJECTS on an oversize (>1 MB) or slow (>5 s) request rather than
 * resolving, and an unhandled rejection here surfaced to the caller as a generic
 * 500 — "the server broke", for two conditions that are entirely the request's
 * doing and that a client should handle differently from each other. Both are
 * caught and named.
 */
async function body(req: IncomingMessage): Promise<BodyOutcome> {
  let raw: string
  try {
    raw = await readBody(req)
  } catch (e) {
    const message = (e as Error).message
    return message === 'body too large'
      // 413 and the same phrasing the notices and Slate size caps use, so one
      // client branch covers "you sent too much" wherever it happened.
      ? { ok: false, code: 'BAD_REQUEST', message: 'request body exceeds the 1 MB limit', status: 413 }
      : { ok: false, code: 'INVALID_PARAMS', message: `request body could not be read: ${message}` }
  }
  if (!raw.trim()) return { ok: true, value: {} }
  try { return { ok: true, value: JSON.parse(raw) } } catch {
    return { ok: false, code: 'BAD_REQUEST', message: 'Invalid request body' }
  }
}

/** The live-session and Graveyard predicates, wired to the real session layer.
 *
 *  Graveyard records are keyed by CONVERSATION id, not session name, so the
 *  tombstone table is the index that gets from one to the other. Without that
 *  hop a retired session would resolve to `unavailable` and the UI would offer
 *  no drill-down for a transcript that is sitting right there. */
export function hostProbe(ctx: SurfaceRouteContext): SurfaceHostProbe {
  return {
    isLiveSession(name) {
      const dir = ctx.sessionConfig?.dirs.sessions
      if (!dir) return false
      // The SECOND half of the traversal fix. `SurfaceService` rejects an unsafe
      // principal id at the write boundary, but `name` here comes off a PERSISTED
      // record — one written before that check existed, or hand-edited into the
      // sidecar, which is a ratified property of the JSON store. A record that is
      // already on disk must not be able to keep re-triggering the read, so the
      // charset is asserted again on the way out, and the resolved path is
      // required to stay inside the sessions directory.
      if (!isSafePrincipalId(name)) return false
      if (!withinDir(dir, join(dir, name))) return false
      try { return !!getSession(dir, name) } catch { return false }
    },
    hasGraveyardRecord(name) {
      const root = ctx.sessionConfig?.dirs.root
      if (!root) return false
      if (!isSafePrincipalId(name)) return false
      const tomb = ctx.docStore.getAllTombstones().find(t => t.sessionName === name)
      if (!tomb) return false
      try { return hasGraveyardSnapshot(root, tomb.convId) } catch { return false }
    },
  }
}

/** True when `target` resolves inside `dir`. The boundary check that makes the
 *  charset guard belt-and-braces rather than the only line of defence. */
function withinDir(dir: string, target: string): boolean {
  const root = resolve(dir)
  const full = resolve(target)
  return full === root || full.startsWith(root + sep)
}

const PREFIX = '/api/surfaces'

/**
 * Match `/api/surfaces/<id>[/<sub>]` and return the decoded id.
 *
 * `decodeURIComponent` THROWS on a malformed percent-escape (`/api/surfaces/%zz`),
 * which turned a bad URL into a 500 — the server reporting its own failure for a
 * request that was simply wrong. A segment that will not decode is kept as
 * written: it still names no Surface, so the caller gets the 404 it deserves
 * instead of an alarm.
 */
function matchId(path: string, sub?: string): string | null {
  const pattern = sub
    ? new RegExp(`^/api/surfaces/([^/]+)/${sub}$`)
    : /^\/api\/surfaces\/([^/]+)$/
  const m = pattern.exec(path)
  const raw = m?.[1]
  if (!raw) return null
  try { return decodeURIComponent(raw) } catch { return raw }
}

export async function handleSurfaceRoutes(
  ctx: SurfaceRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' },
): Promise<boolean> {
  const path = url.split('?')[0] ?? url
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false

  // The `slate-file` adapter is registered HERE as well as on the watcher's
  // service, so a source-bound content edit arriving over HTTP is carried into the
  // file rather than refused for want of an adapter (KTD4).
  const svc = new SurfaceService(ctx.docStore, { probe: hostProbe(ctx), sourceAdapters: slateSourceAdapters() })
  const reply = <T>(result: SurfaceResult<T>, okStatus = 200): true => respond(res, result, cors, okStatus)
  const refuse = (code: ErrorCode, message: string, status?: number): true =>
    fail(res, code, message, { headers: cors, ...(status ? { status } : {}) })
  /** Read the body or answer with the refusal it earned. */
  const readOrRefuse = async (): Promise<{ value: unknown } | null> => {
    const parsed = await body(req)
    if (parsed.ok) return { value: parsed.value }
    refuse(parsed.code, parsed.message, parsed.status)
    return null
  }

  // --- Collection reads ---

  if (method === 'GET' && path === PREFIX) {
    const query = new URLSearchParams(url.split('?')[1] ?? '')
    const spaceId = query.get('spaceId') ?? ctx.docStore.activeSpaceId
    if (!spaceId) {
      refuse('INVALID_PARAMS', 'spaceId is required and there is no active space to default to')
      return true
    }
    reply(svc.list({ spaceId, includeDeleted: query.get('includeDeleted') === 'true' }))
    return true
  }

  // --- Collection-level verbs. FIRST, so neither is read as a Surface id. ---

  if (method === 'POST' && (path === `${PREFIX}/group` || path === `${PREFIX}/reparent`)) {
    const parsed = await readOrRefuse()
    if (!parsed) return true
    const call = callContext(req)
    reply(path.endsWith('/group')
      ? await svc.group(parsed.value, call)
      : await svc.reparent(parsed.value, call))
    return true
  }

  if (method === 'POST' && path === PREFIX) {
    const parsed = await readOrRefuse()
    if (!parsed) return true
    reply(await svc.create(parsed.value, callContext(req)), 201)
    return true
  }

  // --- Per-Surface sub-resources. BEFORE the bare-id handlers. ---

  const contextId = method === 'GET' ? matchId(path, 'context') : null
  if (contextId) { reply(svc.context(contextId, callContext(req))); return true }

  const contributorsId = method === 'GET' ? matchId(path, 'contributors') : null
  if (contributorsId) { reply(svc.contributors(contributorsId)); return true }

  const purgeId = method === 'DELETE' ? matchId(path, 'purge') : null
  if (purgeId) {
    const parsed = await readOrRefuse()
    if (!parsed) return true
    reply(await svc.purge(purgeId, parsed.value, callContext(req)))
    return true
  }

  if (method === 'POST' || method === 'PATCH') {
    const subs: [string, (id: string, b: unknown, c: SurfaceCallContext) => Promise<SurfaceResult<unknown>>][] = [
      ['content', (id, b, c) => svc.updateContent(id, b, c)],
      ['authority', (id, b, c) => svc.transferContentAuthority(id, b, c)],
      ['thread', (id, b, c) => svc.appendThread(id, b, c)],
      ['refresh', (id, b, c) => svc.refreshRequest(id, b, c)],
      ['ungroup', (id, b, c) => svc.ungroup(id, b, c)],
      ['restore', (id, b, c) => svc.restore(id, b, c)],
    ]
    for (const [sub, run] of subs) {
      const id = matchId(path, sub)
      if (!id) continue
      // `content` is the one PATCH — it merges into authored content rather than
      // replacing the record — and the rest are POSTs because they are actions.
      const expected = sub === 'content' ? 'PATCH' : 'POST'
      if (method !== expected) {
        refuse('BAD_REQUEST', `use ${expected} for /api/surfaces/:id/${sub}`, 405)
        return true
      }
      const parsed = await readOrRefuse()
      if (!parsed) return true
      reply(await run(id, parsed.value, callContext(req)))
      return true
    }
  }

  // --- Bare-id verbs. LAST. ---

  const id = matchId(path)
  if (id && method === 'GET') { reply(svc.get(id)); return true }
  if (id && method === 'DELETE') {
    const parsed = await readOrRefuse()
    if (!parsed) return true
    reply(await svc.delete(id, parsed.value, callContext(req)))
    return true
  }

  return false
}

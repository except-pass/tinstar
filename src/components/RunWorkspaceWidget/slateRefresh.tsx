// Explicit refresh controls, bound to freshness (R11-R14, KTD4/KTD9/KTD11).
//
// WHAT CHANGED AND WHY IT MATTERS. This hook used to own the truth about whether a
// Surface was refreshing: it set a spinner optimistically on click, held it for up to
// ten minutes, and cleared it when `amendedAt` happened to advance. Every part of
// that is a guess. The server now records the attempt and the completed check on the
// record itself, so the client's job is to REPORT state, not to invent it — the only
// local state left is a one-request-at-a-time guard covering the round trip, because
// a second click before the response has nothing yet to read.
//
// INTENT IS SENT ONLY FROM AN EXPLICIT REFRESH CONTROL. Pointer selection and `j`/`k`
// navigation only move focus; they never rebuild content. The ⟳ button and `r` hotkey
// send `explicit`, while Check all sends `bulk-check` only for host recipes. Nothing
// fires from a mount effect, focus/visibility listener, SSE delivery, or interval.
//
// "REFRESH ALL" IS A CHEAP CHECK (KTD9). It sends `bulk-check`, which the server runs
// only against machine (host) recipes; agent Surfaces are left dirty for their owner
// to visit. A button that fanned prompts out across a Slate is the thing this plan
// exists to remove, so the label says "check" and the request says so too.
import { useCallback, useMemo, useRef, useState } from 'react'
import type { SlateSurface } from '../../types'
import { apiFetch } from '../../apiClient'

/** Why a refresh is being asked for. Mirrors the server's closed list — see
 *  `REFRESH_INTENTS` in `src/server/api/surfaceRoutes.ts`, which refuses anything
 *  outside it rather than defaulting. */
export type SurfaceIntent = 'explicit' | 'bulk-check'

/** What the server said about one intent. `skipped` covers both "already current"
 *  and "a bulk check passing over agent work" — neither is an error. */
export type IntentOutcome =
  | 'started' | 'joined' | 'unavailable' | 'not-executable' | 'skipped' | 'unreachable'

export interface SlateRefreshApi {
  /** Surfaces with a request in flight RIGHT NOW — between the POST and its
   *  response, and nothing longer. The spinner past that point comes from the
   *  server's own `freshness.phase`, which is the only thing that actually knows. */
  pendingIds: ReadonlySet<string>
  /** Surfaces whose last intent could not reach anybody. Distinct from a failure the
   *  server recorded: this one means the REQUEST did not land. */
  unreachableIds: ReadonlySet<string>
  /** True while a cheap check-all is still settling. */
  bulkChecking: boolean
  /** The ⟳ control. `explicit` works whatever the phase says (R18). */
  refresh: (surface: SlateSurface) => void
  /** Check every visible Surface CHEAPLY. Host recipes may run; agent Surfaces are
   *  left dirty, and no prompt is delivered for any of them. */
  checkAll: (visible: SlateSurface[]) => void
}

/** Would a cheap check-all do anything for this Surface? Only a host recipe can run
 *  without a person, so only a host recipe is worth a request. */
export function isHostMaintained(surface: SlateSurface): boolean {
  return surface.refresh?.kind === 'host'
}

/** Owns the refresh state for a run's whole Slate, so the per-surface controls, the
 *  selection seam, and the header's check-all share one source of truth. */
export function useSlateRefresh(runId: string): SlateRefreshApi {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [unreachable, setUnreachable] = useState<ReadonlySet<string>>(() => new Set())
  const [bulkChecking, setBulkChecking] = useState(false)
  // The ONE piece of local truth: a request is on the wire for this Surface. Held in
  // a ref rather than state because it gates the very next call, and a state update
  // that has not flushed yet would let a double click through.
  const inFlight = useRef<Set<string>>(new Set())

  const mark = useCallback((set: (v: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void, id: string, on: boolean) => {
    set(prev => {
      if (prev.has(id) === on) return prev
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const requestRefresh = useCallback(
    (surface: SlateSurface, intent: SurfaceIntent): Promise<IntentOutcome> | undefined => {
      const id = surface.id
      // ONE REQUEST AT A TIME, and only across the round trip. Past the response the
      // server's own state is authoritative and a second intent legitimately JOINS
      // the attempt in flight — refusing it locally would be the client re-inventing
      // the single-flight rule the durable record already enforces.
      if (inFlight.current.has(id)) return undefined
      inFlight.current.add(id)
      mark(setPending, id, true)
      mark(setUnreachable, id, false)

      return (async (): Promise<IntentOutcome> => {
        try {
          const res = await apiFetch(`/api/runs/${runId}/slate/surfaces/${id}/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ intent }),
          })
          const body = (await res.json().catch(() => null)) as
            | { ok?: boolean; data?: { outcome?: IntentOutcome; delivered?: boolean } }
            | null
          if (!res.ok || !body?.ok) throw new Error(`refresh failed (${res.status})`)
          const outcome = body.data?.outcome
            // An older server answers `{ delivered }` and no outcome. Read as
            // started/unavailable rather than as a failure, so a client ahead of its
            // server degrades instead of showing an error nobody can act on.
            ?? (body.data?.delivered === false ? 'unavailable' : 'started')
          if (outcome === 'unavailable') mark(setUnreachable, id, true)
          return outcome
        } catch {
          // The REQUEST did not land — a different fact from the server recording an
          // unavailable check, and the only one the client is entitled to assert.
          mark(setUnreachable, id, true)
          return 'unreachable'
        } finally {
          inFlight.current.delete(id)
          mark(setPending, id, false)
        }
      })()
    },
    [runId, mark],
  )

  const refresh = useCallback(
    (surface: SlateSurface) => { void requestRefresh(surface, 'explicit') },
    [requestRefresh],
  )

  const checkAll = useCallback(
    (visible: SlateSurface[]) => {
      // ONLY THE HOST-MAINTAINED ONES. Sending `bulk-check` for an agent Surface would
      // be answered with `skipped`, so filtering here is not a second policy — it is
      // not asking a question whose answer is already known, on every card, every time.
      const checkable = visible.filter(isHostMaintained)
      if (checkable.length === 0) return
      setBulkChecking(true)
      void Promise.all(checkable.map(s => requestRefresh(s, 'bulk-check')))
        .finally(() => setBulkChecking(false))
    },
    [requestRefresh],
  )

  // Membership sets are already sets; memoised so consumers get stable identities.
  const pendingIds = useMemo(() => pending, [pending])
  const unreachableIds = useMemo(() => unreachable, [unreachable])

  return { pendingIds, unreachableIds, bulkChecking, refresh, checkAll }
}

/**
 * The ⟳ control.
 *
 * `refreshing` comes from the SERVER's phase now, not from a local optimistic flag —
 * so a spinner means the host really is working on it, and it stops when the host
 * says so rather than when a ten-minute timer gives up. `pending` is the separate,
 * much shorter local state covering the request itself.
 */
export function RefreshButton({ id, refreshing, pending, onClick, className }: {
  id: string
  refreshing: boolean
  pending?: boolean
  onClick: () => void
  className?: string
}) {
  const busy = refreshing || !!pending
  return (
    <button
      data-testid={`refresh-surface-${id}`}
      data-refreshing={refreshing ? 'true' : undefined}
      data-pending={pending ? 'true' : undefined}
      onClick={onClick}
      // Disabled only across the round trip. A second click once the server has
      // answered is legitimate — it joins the attempt in flight — and greying the
      // control out for the whole refresh would tell the user the opposite.
      disabled={!!pending}
      title={busy ? 'Refreshing…' : 'Refresh — rebuild this surface now'}
      className={`leading-none text-ink-ctrl hover:text-ink-high disabled:opacity-70 ${className ?? ''}`}
    >
      <span className={busy ? 'inline-block animate-spin' : 'inline-block'}>⟳</span>
    </button>
  )
}

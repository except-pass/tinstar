// Slate v2 U3 — per-surface refresh (re-run the surface's author).
//
// A surface carries an optional file-owned `refresh` recipe. Refreshing a surface
// POSTs to …/slate/surfaces/:pid/refresh, which delivers that recipe (or a bare
// regenerate-nudge) to the run's agent and persists NOTHING. The new surface body
// then arrives later over the SSE `run` delta, bumping `surface.amendedAt`.
//
// So "refreshing" is a claim that a fresh version is ON ITS WAY. Like RoundupWidget's
// shimmer (SHIMMER_MAX_MS), that claim has to be BOUNDED: an agent can ignore, drop,
// or die on the request, and a spinner that pulses forever is a lie. This hook clears
// the spinner three ways:
//   · a newer version landed  — the incoming surface.amendedAt exceeds the value we
//     recorded at click time (the honest "it arrived" signal), or
//   · the bound elapsed        — REFRESH_MAX_MS passed with no new version, or
//   · the run is unreachable   — the POST returned delivered:false, so nothing is
//     coming; we clear at once and surface a "session not reachable" note instead of
//     spinning on a dead run.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlateSurface } from '../../types'
import { apiFetch } from '../../apiClient'

/** How long a refresh keeps spinning before it gives up. Mirrors RoundupWidget's
 *  SHIMMER_MAX_MS: a bound past which "a new version is coming" stops being true. */
export const REFRESH_MAX_MS = 10 * 60_000

export interface SlateRefreshApi {
  /** Ids currently showing the refresh spinner (POST sent, no newer version yet). */
  refreshingIds: ReadonlySet<string>
  /** Ids whose last refresh reached nobody (delivered:false) — show a small note. */
  unreachableIds: ReadonlySet<string>
  /** True while a "refresh all" fan-out is still settling (any surface refreshing). */
  bulkRefreshing: boolean
  /** Refresh ONE surface: POST, spin, and record its current amendedAt as the baseline. */
  refresh: (surface: SlateSurface) => void
  /** Fan out: refresh every surface in `visible`, and hold a Slate-level loading
   *  state until they've each settled (a new version, a timeout, or unreachable). */
  refreshAll: (visible: SlateSurface[]) => void
}

/** Owns the refresh state for a run's whole Slate, so BOTH the per-surface buttons
 *  (cards + open-point rows) and the header "refresh all" share one source of truth. */
export function useSlateRefresh(runId: string, surfaces: SlateSurface[]): SlateRefreshApi {
  // surfaceId → the amendedAt we recorded when refresh was requested. Membership IS
  // "this surface is refreshing"; the value is the baseline the clear-effect compares.
  const [refreshing, setRefreshing] = useState<Map<string, number>>(() => new Map())
  const [unreachable, setUnreachable] = useState<Set<string>>(() => new Set())
  const [bulkRefreshing, setBulkRefreshing] = useState(false)
  // Per-surface timeout handles (the bound) and in-flight POST guard, in refs so they
  // don't churn identities or leak into the closure as stale values.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const inFlight = useRef<Set<string>>(new Set())

  const clear = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t) { clearTimeout(t); timers.current.delete(id) }
    setRefreshing((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const refresh = useCallback(
    (surface: SlateSurface) => {
      const id = surface.id
      if (inFlight.current.has(id)) return // one POST per surface in flight at a time
      inFlight.current.add(id)
      // Optimistic: spin immediately (before the round trip) and drop any stale note.
      setRefreshing((prev) => {
        const next = new Map(prev)
        next.set(id, surface.amendedAt)
        return next
      })
      setUnreachable((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      const existing = timers.current.get(id)
      if (existing) clearTimeout(existing)
      timers.current.set(id, setTimeout(() => clear(id), REFRESH_MAX_MS))

      void (async () => {
        try {
          const res = await apiFetch(`/api/runs/${runId}/slate/surfaces/${id}/refresh`, {
            method: 'POST',
          })
          const body = (await res.json().catch(() => null)) as
            | { ok?: boolean; data?: { delivered?: boolean }; error?: { message?: string } }
            | null
          if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `refresh failed (${res.status})`)
          // Delivered:false — the run is unreachable, so no new version is coming.
          // Clear the spinner NOW and flag the note; don't spin on a dead run.
          if (body.data?.delivered === false) {
            setUnreachable((prev) => new Set(prev).add(id))
            clear(id)
          }
          // Delivered:true — keep spinning until amendedAt advances or the bound elapses.
        } catch {
          // Couldn't even reach the endpoint — treat like unreachable: stop spinning.
          setUnreachable((prev) => new Set(prev).add(id))
          clear(id)
        } finally {
          inFlight.current.delete(id)
        }
      })()
    },
    [runId, clear],
  )

  const refreshAll = useCallback(
    (visible: SlateSurface[]) => {
      if (visible.length === 0) return
      setBulkRefreshing(true)
      for (const s of visible) refresh(s)
    },
    [refresh],
  )

  // Clear the spinner once a NEWER version of the surface has landed (its amendedAt
  // exceeds the recorded baseline). Watching amendedAt directly — not just "the id is
  // still present" — is what distinguishes a real re-authoring from an SSE re-emit of
  // the same surface.
  useEffect(() => {
    if (refreshing.size === 0) return
    let changed = false
    const next = new Map(refreshing)
    for (const [id, recordedAt] of refreshing) {
      const s = surfaces.find((x) => x.id === id)
      if (s && s.amendedAt > recordedAt) {
        const t = timers.current.get(id)
        if (t) { clearTimeout(t); timers.current.delete(id) }
        next.delete(id)
        changed = true
      }
    }
    if (changed) setRefreshing(next)
  }, [surfaces, refreshing])

  // The bulk loading state ends when nothing is left refreshing.
  useEffect(() => {
    if (bulkRefreshing && refreshing.size === 0) setBulkRefreshing(false)
  }, [bulkRefreshing, refreshing.size])

  // Drop every pending timer on unmount.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending.values()) clearTimeout(t)
      pending.clear()
    }
  }, [])

  // Membership set for consumers (the Map's value is only the internal baseline).
  const refreshingIds = useMemo(() => new Set(refreshing.keys()), [refreshing])

  return { refreshingIds, unreachableIds: unreachable, bulkRefreshing, refresh, refreshAll }
}

/** A ⟳ refresh affordance shared by the surface cards and the open-point rows. Shows
 *  a spinning glyph while its surface is refreshing; disabled so a second click can't
 *  re-arm mid-flight. `data-refreshing` lets a test read the state directly. */
export function RefreshButton({ id, refreshing, onClick, className }: {
  id: string
  refreshing: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      data-testid={`refresh-surface-${id}`}
      data-refreshing={refreshing ? 'true' : undefined}
      onClick={onClick}
      disabled={refreshing}
      title={refreshing ? 'Refreshing…' : 'Refresh — re-run this surface’s author'}
      className={`leading-none text-slate-500 hover:text-slate-200 disabled:opacity-70 ${className ?? ''}`}
    >
      <span className={refreshing ? 'inline-block animate-spin' : 'inline-block'}>⟳</span>
    </button>
  )
}

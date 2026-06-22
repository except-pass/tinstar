import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { useServerEvents } from './useServerEvents'
import { apiFetch } from '../apiClient'
import { emptyPinSet, addPin, updatePin, removePin, removePinsForNode, pinsForNode, type PinSet, type Pin } from '../domain/pinSet'

export function usePinSet(spaceId: string) {
  const { state } = useServerEvents()
  const serverSet = useMemo<PinSet>(
    () => (state.pinSets ?? []).find(s => s.spaceId === spaceId) ?? emptyPinSet(spaceId),
    [state.pinSets, spaceId],
  )

  // Optimistic working copy held in a ref so back-to-back mutations in the same
  // tick compose off the latest value (not a stale render snapshot), then fire a
  // single PUT each. Every write is stamped with a strictly increasing revision;
  // the overlay is dropped once the server's revision reaches ours. Mirrors
  // useConstellationGraph exactly.
  const optimisticRef = useRef<PinSet | null>(null)
  const serverSetRef = useRef(serverSet)
  serverSetRef.current = serverSet
  // Highest revision we've PUT, keyed by spaceId — keeps the counter monotonic
  // across space switches and failed (rolled-back) PUTs.
  const lastRevRef = useRef<Map<string, number>>(new Map())
  // Monotonic token identifying the latest user-initiated edit. A 409 rebase-retry
  // checks this (not overlay object-identity) so a legitimate echo-drop of the
  // overlay doesn't cancel the retry, while a NEWER user edit (which bumps this)
  // does — the newer edit owns the overlay and its own persist.
  const editGenRef = useRef(0)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  // The provider is reused across space switches, so clear the overlay the moment
  // spaceId changes — synchronously during render — to avoid leaking one space's
  // optimistic pins into another (which the next mutation would PUT cross-space).
  const lastSpaceIdRef = useRef(spaceId)
  if (lastSpaceIdRef.current !== spaceId) {
    lastSpaceIdRef.current = spaceId
    optimisticRef.current = null
  }

  // Drop the overlay once the server's revision is at or past our latest write.
  useEffect(() => {
    if (!optimisticRef.current) return
    if ((serverSet.rev ?? 0) >= (optimisticRef.current.rev ?? 0)) {
      optimisticRef.current = null
      bump()
    }
  }, [serverSet])

  const set = optimisticRef.current ?? serverSet

  const apply = useCallback((compute: (s: PinSet) => PinSet) => {
    // How many total PUT attempts a single edit gets before falling back to
    // rollback. One initial attempt + up to two rebase-retries on 409.
    const MAX_ATTEMPTS = 3
    // Brief pause before a rebase-retry so the competing write's SSE echo can
    // land in serverSetRef.current — the retry recomputes off the FRESHEST base
    // (e.g. an agent reply that just out-revisioned us) and re-stamps a rev that
    // now beats it. Fixed delay on purpose; this is browser runtime.
    const REBASE_RETRY_DELAY_MS = 60

    // No-op short-circuit BEFORE claiming an edit generation: a no-op apply must
    // not bump editGenRef, or it would cancel an in-flight rebase-retry from a
    // prior real edit (silently dropping that edit).
    const base0 = optimisticRef.current ?? serverSetRef.current
    if (JSON.stringify(compute(base0)) === JSON.stringify(base0)) return

    // Claim the latest-edit slot. A subsequent real apply() bumps this, marking
    // our retry chain stale so it won't clobber the newer user edit.
    const myGen = ++editGenRef.current

    const attempt = (triesLeft: number) => {
      const baseSet = optimisticRef.current ?? serverSetRef.current
      const next = compute(baseSet)
      // No-op mutation: nothing to persist, and the overlay (if any) already
      // reflects this value, so leave it be. On a rebase-retry this also fires
      // when the competing change already subsumed our edit — nothing to write.
      if (JSON.stringify(next) === JSON.stringify(baseSet)) return
      // Stamp a strictly increasing revision so same-tick writes keep advancing
      // before any echo updates serverSet, and a write always out-revisions
      // whatever it edits (including a competitor we just rebased onto).
      const rev = Math.max(serverSetRef.current.rev ?? 0, lastRevRef.current.get(spaceId) ?? 0) + 1
      lastRevRef.current.set(spaceId, rev)
      const stamped = { ...next, rev }
      optimisticRef.current = stamped
      bump()
      // On a failed persist, roll back so reads fall back to serverSet. Only roll
      // back if `stamped` is still the active overlay — a newer in-flight edit may
      // have replaced it, and that one owns its own persist/rollback.
      const rollback = () => { if (optimisticRef.current === stamped) { optimisticRef.current = null; bump() } }
      apiFetch(`/api/pins/${encodeURIComponent(spaceId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stamped),
      }).then(async res => {
        if (res.ok) return
        const detail = await res.text().catch(() => '')
        // A 409 means the revision gate rejected us as stale — a competing write
        // (e.g. an agent reply) bumped the server rev first. Rather than discard
        // the user's edit, rebase onto the fresher server state and re-PUT with a
        // rev that now out-revisions the competitor. Bounded to avoid storms.
        // Note: the overlay-drop effect may have nulled optimisticRef when the
        // competitor's higher rev landed (server rev >= our rev). That's the very
        // case we must recover from, so we gate the retry on the edit generation,
        // not overlay identity — only a NEWER user edit (newer myGen) cancels us.
        if (res.status === 409 && triesLeft > 1 && editGenRef.current === myGen) {
          console.warn(`[pins] persist 409 (stale rev ${rev}); rebase-retry, ${triesLeft - 1} left`, detail)
          setTimeout(() => {
            if (editGenRef.current !== myGen) return
            attempt(triesLeft - 1)
          }, REBASE_RETRY_DELAY_MS)
          return
        }
        console.warn(`[pins] persist failed: HTTP ${res.status}`, detail)
        rollback()
      }).catch(err => { console.warn('[pins] persist failed:', err); rollback() })
    }

    attempt(MAX_ATTEMPTS)
  }, [spaceId])

  const create = useCallback((pin: Pin) => apply(s => addPin(s, pin)), [apply])
  const update = useCallback((id: string, fn: (p: Pin) => Pin) => apply(s => updatePin(s, id, fn)), [apply])
  const remove = useCallback((id: string) => apply(s => removePin(s, id)), [apply])
  const clearNode = useCallback((nodeId: string) => apply(s => removePinsForNode(s, nodeId)), [apply])
  const forNode = useCallback((nodeId: string) => pinsForNode(set, nodeId), [set])

  return { set, create, update, remove, clearNode, forNode }
}

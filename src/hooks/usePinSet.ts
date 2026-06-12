import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { useServerEvents } from './useServerEvents'
import { apiFetch } from '../apiClient'
import { emptyPinSet, addPin, updatePin, removePin, pinsForNode, type PinSet, type Pin } from '../domain/pinSet'

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
    const baseSet = optimisticRef.current ?? serverSetRef.current
    const next = compute(baseSet)
    // No-op mutation: nothing to persist, and the overlay (if any) already
    // reflects this value, so leave it be.
    if (JSON.stringify(next) === JSON.stringify(baseSet)) return
    // Stamp a strictly increasing revision so same-tick writes keep advancing
    // before any echo updates serverSet, and a write always out-revisions
    // whatever it edits.
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
    }).then(async res => { if (!res.ok) { console.warn(`[pins] persist failed: HTTP ${res.status}`, await res.text().catch(() => '')); rollback() } })
      .catch(err => { console.warn('[pins] persist failed:', err); rollback() })
  }, [spaceId])

  const create = useCallback((pin: Pin) => apply(s => addPin(s, pin)), [apply])
  const update = useCallback((id: string, fn: (p: Pin) => Pin) => apply(s => updatePin(s, id, fn)), [apply])
  const remove = useCallback((id: string) => apply(s => removePin(s, id)), [apply])
  const forNode = useCallback((nodeId: string) => pinsForNode(set, nodeId), [set])

  return { set, create, update, remove, forNode }
}

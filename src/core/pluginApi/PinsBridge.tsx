import { useEffect } from 'react'
import { usePinSet } from '../../hooks/usePinSet'
import { setPinsBridge } from './pinsBridgeStore'

/** Host-mounted bridge that publishes the active space's usePinSet mutators into
 *  the module-level pins ref, so api.pins.create/update/remove (non-hook
 *  mutators) can call through. Mount once, inside the active-space provider tree
 *  (alongside ConstellationProvider). Renders nothing. */
export function PinsBridge({ spaceId }: { spaceId: string }) {
  const { create, update, remove } = usePinSet(spaceId)
  useEffect(() => {
    setPinsBridge({ create, update, remove })
    return () => setPinsBridge(null)
  }, [create, update, remove])
  return null
}

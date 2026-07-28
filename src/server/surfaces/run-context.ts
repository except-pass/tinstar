// One answer to "what canonical context does this run reconcile against" (plan U2).
//
// Three consumers need it — the Slate watcher (to build an epoch), the Run Workspace
// write bridge (to create a user point), and the boot migration (which derives the
// same values from the same inputs) — and they must agree exactly. A second
// derivation that rounded a space or a timestamp differently would mint a second set
// of Surface identities for one run, which is unrecoverable: the first set keeps the
// threads and nothing points at it any more.
//
// Server-only and React-free.

import { LEGACY_SPACELESS_SPACE_ID, deriveLegacyRunRootId } from '../stores/surface-migration'
import { deriveRunIncarnation } from '../stores/surfaces'

export interface RunSurfaceContext {
  spaceId: string
  /** The run INCARNATION — "this run, this time". Half the Surface identity basis. */
  incarnation: string
  /** The canonical id of the run's compatibility root Surface. */
  rootSurfaceId: string
}

/**
 * Resolve a run's canonical context, or `null` when it has none.
 *
 * `null` is returned rather than a substitute for exactly one reason, and it is the
 * same reason `deriveRunIncarnation` refuses: a run with no `createdAt` has no
 * derivable incarnation, and a guessed one is indistinguishable from a real one
 * forever after. The caller skips the run; the legacy Slate keeps rendering it.
 */
export function resolveRunSurfaceContext(
  run: { id?: string; createdAt?: string; spaceId?: string },
): RunSurfaceContext | null {
  const incarnation = deriveRunIncarnation(run.id, run.createdAt)
  if (!incarnation) return null
  return {
    // Matches the migration's fallback exactly: `Run.spaceId` is optional and
    // `Surface.spaceId` is required, and quarantining every space-less run would
    // leave the population migration exists to rescue with no canonical form.
    spaceId: run.spaceId || LEGACY_SPACELESS_SPACE_ID,
    incarnation,
    rootSurfaceId: deriveLegacyRunRootId(incarnation),
  }
}

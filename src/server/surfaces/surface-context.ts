// Read-side of the Surface mutation service: capabilities, bounded context, and
// contributor resolution (plan U3, "Read tree and context" and "Inspect
// contributors" in the Agent-Native Action Parity table).
//
// It is a separate module from `surface-service.ts` for one reason worth stating:
// everything here is a PURE FUNCTION OF STORE READS. Nothing in this file
// mutates, commits, or emits. That makes the honest-degradation rules — what a
// caller is told when a child is out of its worktree, what happens when a
// contributor's session is gone — testable without a sidecar, a lock, or a
// filesystem, and it keeps the mutation module free of presentation decisions.
//
// The one seam that reaches outside the store is {@link SurfaceHostProbe}. Live
// sessions and Graveyard transcripts live on disk under `sessionConfig`, and
// asking about them from here would drag tmux and the session layer into every
// context read. Injecting two predicates keeps that dependency at the route
// boundary where it belongs.

import type {
  PointStatus,
  Surface,
  SurfaceCapabilities,
  SurfaceContext,
  SurfaceContributor,
  SurfaceContributorResolution,
  SurfacePrincipalRef,
  SurfaceSummary,
} from '../../domain/types'
import type { DocumentStore } from '../stores/document-store'

/** How much of a thread rides in a context payload. The full thread stays on the
 *  record; this is the bounded tail a prompt or a rail row carries, so a Surface
 *  with a thousand replies cannot make one context read enormous. */
export const RECENT_THREAD_MAX = 20

/**
 * What this caller is authorized to READ authored content from.
 *
 * `worktreeIds: undefined` means unrestricted, which is the first release's
 * trusted-local default (KTD6) — there is no human authentication layer to
 * derive a narrower scope from. The seam is real even so: U5 partitions
 * mixed-worktree parent context through exactly this shape, and building it now
 * means the redaction path is exercised from U3 rather than retrofitted onto a
 * context reader that assumed everything was visible.
 */
export interface SurfaceAccessScope {
  worktreeIds?: string[]
}

/** Whether the host can still open the thing a contributor names. Two
 *  predicates, injected: the real implementations read the session directory and
 *  the Graveyard snapshot store. */
export interface SurfaceHostProbe {
  isLiveSession(sessionName: string): boolean
  hasGraveyardRecord(sessionName: string): boolean
}

/** A probe that finds nothing. The honest default for a context read with no
 *  session layer wired (unit tests, `TINSTAR_NO_SESSIONS`): every contributor
 *  resolves to evidence or unavailable, and no dead terminal is offered. */
export const NO_HOST_PROBE: SurfaceHostProbe = {
  isLiveSession: () => false,
  hasGraveyardRecord: () => false,
}

/** Inputs a capability decision needs that are not on the record itself. */
export interface CapabilityInputs {
  /** True when this Surface is in the recovery store, at any depth. */
  deleted: boolean
  /** True when this Surface IS a recovery-store root (only a root is restorable
   *  or purgeable — a descendant comes back with its parent). */
  recoveryRoot: boolean
  /** True when a source adapter is registered for this Surface's binding, so a
   *  direct content edit can be carried back to the source (KTD4). */
  sourceAdapterAvailable: boolean
}

/**
 * What this actor may do to this Surface right now.
 *
 * Note what is absent: there is no ownership check anywhere below. Under the
 * ratified "Recoverable action over gated action" decision, agents may arrange
 * and delete ANY Surface — arrangement carries no ownership gate — so a
 * capability table that consulted `owner` would be inventing a permission the
 * product deliberately does not have. The only thing that turns topology
 * capabilities off is being deleted already.
 */
export function surfaceCapabilities(surface: Surface, inputs: CapabilityInputs): SurfaceCapabilities {
  const blocked: NonNullable<SurfaceCapabilities['blocked']> = {}

  const sourceBound = surface.contentAuthority === 'source-binding'
  const updateContent = !inputs.deleted && (!sourceBound || inputs.sourceAdapterAvailable)
  if (!updateContent) {
    blocked.updateContent = inputs.deleted
      ? 'the Surface is in the recovery store; restore it first'
      : `content authority is the source binding "${surface.source?.adapter ?? 'unknown'}" and no adapter is ` +
        'registered to carry the edit back to it — transfer authority to canonical-direct to edit here'
  }

  const appendThread = !inputs.deleted
  if (!appendThread) blocked.appendThread = 'the Surface is in the recovery store; restore it first'

  const live = !inputs.deleted
  if (!live) {
    blocked.group = 'the Surface is in the recovery store; restore it first'
    blocked.reparent = blocked.group
    blocked.delete = 'the Surface is already in the recovery store'
  }

  const restore = inputs.recoveryRoot
  if (!restore) {
    blocked.restore = inputs.deleted
      ? 'only the root of a deleted subtree is restorable; its descendants return with it'
      : 'the Surface is not deleted'
  }
  const purge = inputs.recoveryRoot
  if (!purge) blocked.purge = blocked.restore

  // `refresh` is "a refresh request will be accepted", not "the host can run one
  // unattended". Those are different questions and collapsing them would make the
  // capability lie in one direction or the other: a Surface with no recipe can
  // still be nudged (R13 is explicit that refresh then "degrades to a bare
  // nudge"), while one with a recipe can be rebuilt without a human. Two booleans,
  // both honest.
  //
  // "Will be accepted" means EXACTLY what `SurfaceService.refreshRequest` accepts,
  // and that includes the freshness phase: the state machine has no
  // refreshing→queued edge for a human request, so a Surface already `queued` or
  // `refreshing` is refused. Reporting `refresh: true` there advertised a button
  // whose only outcome was a conflict — and a capability that lies is worse than
  // an absent one, because the caller has no reason to check.
  const busy = surface.freshness.phase === 'queued' || surface.freshness.phase === 'refreshing'
  const refresh = !inputs.deleted && !busy
  if (!refresh) {
    blocked.refresh = inputs.deleted
      ? 'the Surface is in the recovery store; restore it first'
      : `a refresh is already ${surface.freshness.phase}; one refresh runs per Surface`
  }
  const refreshRecipe = !!surface.content.recipe

  return {
    contentAuthority: surface.contentAuthority,
    updateContent,
    appendThread,
    group: live,
    reparent: live,
    delete: live,
    restore,
    purge,
    refresh,
    refreshRecipe,
    ...(Object.keys(blocked).length > 0 ? { blocked } : {}),
  }
}

/** True when this caller may see the authored content of a Surface produced in
 *  `worktreeId`. An unrestricted scope sees everything; a Surface with no
 *  recorded worktree is host-context work and is never withheld. */
export function withinScope(scope: SurfaceAccessScope, worktreeId: string | undefined): boolean {
  if (!scope.worktreeIds) return true
  if (!worktreeId) return true
  return scope.worktreeIds.includes(worktreeId)
}

/** Reduce a Surface to a row in someone else's context. Content is withheld —
 *  not the row itself — when the caller is out of scope: hiding the row would
 *  make child counts and rollups lie, which is worse than an explicit gap. */
export function summarizeSurface(
  surface: Surface,
  childCount: number,
  scope: SurfaceAccessScope = {},
): SurfaceSummary {
  const worktreeId = surface.provenance?.worktreeId
  const accessible = withinScope(scope, worktreeId)
  return {
    id: surface.id,
    headline: accessible ? surface.content.headline : '',
    accessible,
    childCount,
    status: surface.thread.status as PointStatus,
    freshness: surface.freshness,
    author: surface.author,
    ...(surface.compatibilityOnly ? { compatibilityOnly: true } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(accessible ? {} : { withheld: `authored content is outside this caller's worktree scope (${worktreeId})` }),
  }
}

/** How a principal resolves into something openable. `session` principals are the
 *  only ones that can ever produce a terminal; everything else is evidence, and
 *  saying so explicitly is what stops the UI offering a dead ttyd (AE4). */
function resolvePrincipal(principal: SurfacePrincipalRef, probe: SurfaceHostProbe): SurfaceContributorResolution {
  if (principal.kind !== 'session') return 'process-evidence'
  if (probe.isLiveSession(principal.id)) return 'live-session'
  if (probe.hasGraveyardRecord(principal.id)) return 'graveyard'
  return 'unavailable'
}

/**
 * Every principal attached to a Surface, resolved to what a human can actually
 * open (R11/F5/AE4).
 *
 * Deduplicated by principal identity, because the owner of a Surface is very
 * often also the session in its provenance, and rendering the same avatar twice
 * is the "parent rollups deduplicate participants" failure one level down.
 */
export function resolveContributors(surface: Surface, probe: SurfaceHostProbe): SurfaceContributor[] {
  const out: SurfaceContributor[] = []
  const seen = new Set<string>()
  const evidence = {
    ...(surface.source?.locator ? { source: surface.source.locator } : {}),
    ...(surface.provenance?.worktreeId ? { worktreeId: surface.provenance.worktreeId } : {}),
    ...(surface.provenance?.runId ? { runId: surface.provenance.runId } : {}),
    ...(surface.provenance?.sessionId ? { sessionId: surface.provenance.sessionId } : {}),
    ...(surface.source?.watermark ? { watermark: surface.source.watermark } : {}),
  }

  const push = (principal: SurfacePrincipalRef, role: SurfaceContributor['role']) => {
    const key = `${principal.kind} ${principal.id}`
    if (seen.has(key)) return
    seen.add(key)
    const resolution = resolvePrincipal(principal, probe)
    out.push({
      principal,
      role,
      resolution,
      terminal: resolution === 'live-session',
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    })
  }

  if (surface.owner) push(surface.owner, 'owner')
  if (surface.provenance?.sessionId) {
    push({ kind: 'session', id: surface.provenance.sessionId }, 'session')
  }
  if (surface.provenance?.runId && surface.provenance.runId !== surface.provenance.sessionId) {
    push({ kind: 'session', id: surface.provenance.runId }, 'run')
  }
  if (surface.source) {
    // A file or process source is never openable as a terminal, whatever the
    // session situation is. Given its own principal kind so the UI does not have
    // to infer "this row has no avatar" from an absent field.
    push({ kind: 'process', id: `${surface.source.adapter}:${surface.source.locator}` }, 'source')
  }
  return out
}

export interface BuildContextOptions {
  scope?: SurfaceAccessScope
  probe?: SurfaceHostProbe
  /** Adapters registered for source-bound content writes, by adapter name. Only
   *  membership is consulted here — the write itself belongs to the service. */
  sourceAdapters?: ReadonlySet<string>
  threadMax?: number
}

/**
 * Assemble everything an agent needs to act on one Surface without reading the
 * store (the parity table's "List/get with ancestors, descendants, freshness, and
 * capabilities").
 *
 * Children are IMMEDIATE ONLY, per KTD8: the workspace scope, not the subtree.
 * `descendantCount` carries the number a delete confirmation and a preview badge
 * need, so bounding the payload does not cost the caller the one aggregate it
 * cannot compute for itself.
 */
export function buildSurfaceContext(
  docStore: DocumentStore,
  id: string,
  opts: BuildContextOptions = {},
): SurfaceContext | undefined {
  const surface = docStore.getSurface(id)
  if (!surface) return undefined

  const scope = opts.scope ?? {}
  const probe = opts.probe ?? NO_HOST_PROBE
  const adapters = opts.sourceAdapters ?? new Set<string>()
  const threadMax = opts.threadMax ?? RECENT_THREAD_MAX

  const recoveryRoot = docStore.surfaceRecoveryRootFor(id)
  const capabilities = surfaceCapabilities(surface, {
    deleted: !!recoveryRoot,
    recoveryRoot: recoveryRoot?.id === id,
    sourceAdapterAvailable: !!surface.source && adapters.has(surface.source.adapter),
  })

  // Nearest-first off the store, reversed to root-first: a breadcrumb reads from
  // the root down, and reversing here means every consumer does not.
  const ancestors = docStore.getSurfaceAncestors(id).reverse()
    .map(a => summarizeSurface(a, docStore.getSurfaceChildren(a.id).length, scope))
  const children = docStore.getSurfaceChildren(id)
    .map(c => summarizeSurface(c, docStore.getSurfaceChildren(c.id).length, scope))

  return {
    surface,
    capabilities,
    spaceId: surface.spaceId,
    topologyRev: docStore.getSurfaceTopologyRev(surface.spaceId),
    ancestors,
    children,
    descendantCount: docStore.getSurfaceDescendants(id).length,
    contributors: resolveContributors(surface, probe),
    recentThread: surface.thread.replies.slice(-threadMax),
    ...(surface.deleted ? { deleted: surface.deleted } : {}),
  }
}

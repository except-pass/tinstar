// The WRITE half of the Run Workspace compatibility layer (plan KTD3, U2).
//
// `run-slate-projection.ts` reads canonical Surfaces back out as the legacy shapes.
// This writes the other way: it takes the run-scoped operations the existing HTTP
// routes perform — reply, resolve, reopen, dismiss, set the Objective, add a point,
// clean the Slate — and performs them on the ONE canonical Surface the run's
// compatibility alias addresses.
//
// It exists so those routes stay thin adapters and so there is exactly one writable
// copy of every Surface (R28/AE8). Everything here goes through `SurfaceService`,
// which is the only mutation boundary: a bridge that constructed candidate records
// and committed them itself would be a second path around every validation, every
// revision gate, and the recovery store.
//
// IDENTITY. A user-authored point takes the SAME derived Surface id a migrated
// legacy point of that local id would (`deriveLegacySurfaceId`). Minting a random
// one instead would work today and collide tomorrow: the boot migration derives its
// ids from the incarnation, so a legacy `objective` point and a freshly-set
// Objective would end up as two records claiming one alias, and the migration would
// quarantine one of them on every boot.
//
// Server-only and React-free.

import { randomUUID } from 'node:crypto'
import { OBJECTIVE_POINT_ID, type A2uiContent, type Point, type Surface, type SurfacePrincipalRef } from '../../domain/types'
import type { DocumentStore } from '../stores/document-store'
import { runAliasOf } from '../stores/run-slate-projection'
import { deriveLegacySurfaceId } from '../stores/surfaces'
import type { SurfaceCallContext, SurfaceService } from './surface-service'
import { resolveRunSurfaceContext } from './run-context'

/** What a bridge operation reports back. `point` is the resulting legacy view, or
 *  `undefined` when the operation could not be performed — the same shape the
 *  routes already branch on. `reason` names why for a caller that wants to log it. */
export interface BridgeResult {
  point?: Point
  reason?: string
}

/** A user-authored point as the routes describe one. Deliberately NOT `PointInput`:
 *  `anchor` and `group` are gone from the canonical model, and accepting fields that
 *  are silently discarded is how a caller comes to believe it set something. */
export interface UserPointInput {
  /** The run-local id. Absent mints one. */
  id?: string
  headline: string
  content?: A2uiContent
}

export class RunSlateBridge {
  constructor(
    private readonly docStore: DocumentStore,
    private readonly svc: SurfaceService,
  ) {}

  /**
   * Append one message to a point's thread, REOPENING first when it is terminal.
   *
   * The reopen is here rather than at the route because it is part of what "reply"
   * means (the lifecycle diagram's reopen-on-reply): a message landing on a resolved
   * point must re-enter the conversation rather than be swallowed by it.
   */
  async appendReply(runId: string, localId: string, text: string, actor: SurfacePrincipalRef): Promise<BridgeResult> {
    const surface = this.find(runId, localId)
    if (!surface) return { reason: 'not-found' }
    const ctx: SurfaceCallContext = { actor }
    if (surface.thread.resolvedAt != null || surface.thread.dismissedAt != null) {
      const reopened = await this.svc.setThreadDisposition(surface.id, { action: 'reopen' }, ctx)
      if (!reopened.ok) return { reason: reopened.error.reason ?? reopened.error.code }
    }
    const appended = await this.svc.appendThread(surface.id, { text }, ctx)
    if (!appended.ok) return { reason: appended.error.reason ?? appended.error.code }
    return this.view(runId, localId)
  }

  /** Resolve, reopen, or dismiss a point. */
  async setDisposition(
    runId: string, localId: string, action: 'resolve' | 'reopen' | 'dismiss', actor: SurfacePrincipalRef,
  ): Promise<BridgeResult> {
    const surface = this.find(runId, localId)
    if (!surface) return { reason: 'not-found' }
    const done = await this.svc.setThreadDisposition(surface.id, { action }, { actor })
    // `no-change` is the honest answer to "dismiss an already-dismissed point" and
    // is not a failure from the route's side — the point is in the state asked for.
    if (!done.ok && done.error.reason !== 'no-change') return { reason: done.error.reason ?? done.error.code }
    return this.view(runId, localId)
  }

  /**
   * Create or amend a USER-authored point — the Objective, and anything composed
   * through the API.
   *
   * A user point holds `canonical-direct` authority, which is what makes it immune
   * to the file channel: a source epoch that observes the same local id reports
   * divergence instead of overwriting it (KTD4). `claim` takes a point the file
   * channel currently owns and moves authority to the record, which is how the
   * Objective survives an agent that also writes an `objective` entry.
   */
  async upsertUserPoint(
    runId: string, input: UserPointInput, actor: SurfacePrincipalRef, opts: { claim?: boolean } = {},
  ): Promise<BridgeResult> {
    const context = this.context(runId)
    if (!context) return { reason: 'no-run-context' }
    const localId = input.id && input.id.length > 0 ? input.id : `pt-user-${randomUUID().slice(0, 12)}`
    const ctx: SurfaceCallContext = { actor }
    const existing = this.find(runId, localId)

    if (!existing) {
      const rooted = await this.svc.ensureRunRoot({
        id: context.rootSurfaceId, spaceId: context.spaceId, runId, createdAt: Date.now(),
      }, ctx)
      if (!rooted.ok) return { reason: rooted.error.reason ?? rooted.error.code }
      const created = await this.svc.createRunPoint({
        id: deriveLegacySurfaceId(context.incarnation, localId),
        spaceId: context.spaceId,
        home: { kind: 'surface', surfaceId: context.rootSurfaceId },
        runId,
        localId,
        content: { headline: input.headline, ...(input.content ? { body: input.content } : {}) },
      }, ctx)
      if (!created.ok) return { reason: created.error.reason ?? created.error.code }
      return this.view(runId, localId)
    }

    // A file-owned point being CLAIMED: authority has to move before the content
    // write, or the write is refused for belonging to the source (KTD4).
    if (opts.claim && existing.contentAuthority === 'source-binding') {
      const moved = await this.svc.transferContentAuthority(
        existing.id, { to: 'canonical-direct', expectedRev: existing.rev, claimAuthorship: true }, ctx,
      )
      if (!moved.ok) return { reason: moved.error.reason ?? moved.error.code }
    }
    const current = this.docStore.getSurface(existing.id)!
    const updated = await this.svc.updateContent(existing.id, {
      headline: input.headline,
      body: input.content ?? null,
      expectedRev: current.rev,
    }, ctx)
    if (!updated.ok && updated.error.reason !== 'no-change') {
      return { reason: updated.error.reason ?? updated.error.code }
    }
    return this.view(runId, localId)
  }

  /** Delete one point. Recoverable: under KTD15 this moves the Surface into the
   *  per-space recovery store rather than erasing it. */
  async deletePoint(runId: string, localId: string, actor: SurfacePrincipalRef): Promise<boolean> {
    const surface = this.find(runId, localId)
    if (!surface) return false
    return this.deleteSubtree(surface, actor)
  }

  /**
   * "Clean the Slate" — delete every point of a run except the user's Objective.
   *
   * ELIGIBILITY is the interesting part. Only Surfaces still homed on the run's
   * compatibility root are cleaned. A Surface the user PROMOTED onto the Canvas has
   * left the Run Workspace and become part of their workspace; wiping it as a side
   * effect of clearing a run's clutter would delete work the user deliberately
   * pulled out of that run. Its run alias survives promotion (KTD3), so eligibility
   * cannot be read off the alias — it has to be read off the home.
   *
   * The Objective survives by design: it is the run's pinned goal, it has its own
   * explicit clear, and it sits outside the surface machinery everywhere else.
   *
   * Every delete names its exact descendant set and an explicit disposition, so the
   * operation can never remove more than the run's own displayed subtree.
   */
  async clean(runId: string, actor: SurfacePrincipalRef): Promise<number> {
    const context = this.context(runId)
    let cleared = 0
    for (const surface of this.docStore.getSurfacesForRunAlias(runId)) {
      const alias = runAliasOf(surface, runId)
      if (!alias || alias.localId === OBJECTIVE_POINT_ID) continue
      if (surface.compatibilityOnly) continue
      // Promoted, grouped elsewhere, or otherwise no longer under this run's root.
      if (surface.home.kind !== 'surface' || surface.home.surfaceId !== context?.rootSurfaceId) continue
      if (await this.deleteSubtree(surface, actor)) cleared++
    }
    return cleared
  }

  // --- Internals ---

  /** Delete a Surface and whatever still hangs off it, naming the exact set. */
  private async deleteSubtree(surface: Surface, actor: SurfacePrincipalRef): Promise<boolean> {
    const descendants = this.docStore.getSurfaceDescendants(surface.id).map(s => s.id)
    const done = await this.svc.delete(surface.id, {
      ...(descendants.length > 0 ? { descendants, disposition: 'delete-subtree' } : {}),
    }, { actor })
    return done.ok
  }

  /** The live canonical record a run's local id addresses, or `undefined`. */
  private find(runId: string, localId: string): Surface | undefined {
    return this.docStore.surfaceForRunAlias(runId, localId)
  }

  private context(runId: string) {
    const run = this.docStore.getRun(runId)
    return run ? resolveRunSurfaceContext(run) : null
  }

  /** The legacy view of a point AFTER a mutation, re-read rather than reconstructed
   *  from the mutation response: the response names the record the operation
   *  produced, and a route's caller wants the current one. */
  private view(runId: string, localId: string): BridgeResult {
    const point = this.docStore.getSlatePoint(runId, localId)
    return point ? { point } : { reason: 'not-found' }
  }
}

// The Run Workspace projection over canonical Surfaces (plan KTD3, U2).
//
// KTD3: "Run Workspace remains a projection over canonical Surfaces … `Run.slate`
// delegates reads and writes through aliases, so Canvas and Run Workspace never
// receive separate writable copies." This module is the READ half of that — pure
// functions from a canonical `Surface` to the two legacy shapes the existing client
// and the existing run-scoped routes already speak.
//
// Until U2 the derivation ran off the legacy `SlateStore`, which was correct while
// the legacy bridge was still the write path. U2 swaps the input, and this is where
// it swaps to.
//
// THREE LEGACY FIELDS DO NOT COME BACK, by author ruling, and it is worth naming
// them here because their absence is the visible difference a user sees:
//   · `anchor` — the card-vs-row distinction it encodes does not exist in the target
//     model, which renders every Surface through one shell. A `kind:'diagram'`
//     surface now projects as an ordinary `open-point`;
//   · `group` — the S4 workbench band. Grouping in the canonical model is a
//     container Surface with children, a SHAPE rather than a field, so a grouped set
//     projects as ordinary rows;
//   · `stalledAt` — the dead-writer marker. Nothing in the canonical record models
//     it; freshness carries the equivalent signal in its own vocabulary.
//
// Server-only and React-free.

import {
  OBJECTIVE_ORDER,
  OBJECTIVE_POINT_ID,
  type Point,
  type SlateSurface,
  type Surface,
  type SurfaceCompatAlias,
} from '../../domain/types'

/** The compatibility alias a Surface carries for `runId`, if any. A Surface may
 *  hold several (KTD3); only this run's is the one the legacy view addresses it by. */
export function runAliasOf(s: Surface, runId: string): SurfaceCompatAlias | undefined {
  return (s.aliases ?? []).find(a => a.bucket.kind === 'run' && a.bucket.runId === runId)
}

/**
 * Is this Surface part of the run's legacy Slate presentation?
 *
 * Two INDEPENDENT exclusions:
 *   · `compatibilityOnly` — the per-run root. It is migration scaffolding that
 *     CONTAINS the run's surfaces; rendering it inside the list it contains would
 *     put a "run root" row into the user's Slate. Today every root also carries a
 *     hidden alias, so either gate alone would exclude it; this one is on the
 *     PROPERTY rather than on a flag a later mutation could flip;
 *   · an invisible alias — closing a legacy presentation hides the alias and never
 *     deletes the canonical Surface (KTD3).
 */
export function inRunSlate(s: Surface, alias: SurfaceCompatAlias | undefined): alias is SurfaceCompatAlias {
  return !!alias && alias.visible && !s.compatibilityOnly
}

/** True when this Surface is the run's USER-owned Objective (S2) — the pinned goal
 *  card. The reserved alias id plus canonical-direct authority plus a user author,
 *  which is exactly the `source === 'user' && id === OBJECTIVE_POINT_ID` test the
 *  legacy derivation used, expressed in canonical fields. */
export function isObjectiveSurface(s: Surface, localId: string): boolean {
  return localId === OBJECTIVE_POINT_ID && s.contentAuthority === 'canonical-direct' && s.author === 'user'
}

/** One canonical Surface as the client-facing `Run.slate` entry it aliases. */
export function slateSurfaceFromCanonical(s: Surface, localId: string): SlateSurface {
  const objective = isObjectiveSurface(s, localId)
  return {
    id: localId,
    author: s.author,
    kind: objective ? 'objective' : 'open-point',
    // The objective is FORCED to its pin sentinel rather than storing one, so
    // whatever order it happens to carry cannot strand it mid-list.
    order: objective ? OBJECTIVE_ORDER : s.order ?? s.createdAt,
    ...(s.content.body ? { body: s.content.body } : {}),
    ...(s.content.recipe ? { refresh: s.content.recipe } : {}),
    headline: s.content.headline,
    status: s.thread.status,
    ...(s.thread.replies.length > 0 ? { thread: s.thread.replies } : {}),
    // U6's freshness, carried whole rather than flattened to a badge string. The
    // panel needs the phase, the reason, the deadline, AND `overdue` — which is
    // orthogonal to the phase — and a pre-rendered label would have to pick one.
    // The Objective is excluded: it is the user's own prose with no source to be
    // stale against, and an amber "unverified" on a goal the user just typed would
    // be nonsense.
    ...(objective ? {} : { freshness: s.freshness }),
    createdAt: s.createdAt,
    amendedAt: s.amendedAt,
  }
}

/**
 * One canonical Surface as the legacy `Point` the run-scoped routes read.
 *
 * `source` is derived from content authority rather than stored: a Surface the file
 * reconciler owns is `'file'`, and one the record itself owns is `'user'`. That is
 * the same pairing the migration wrote in the other direction, so a point that made
 * the round trip comes back as what it went in as.
 */
export function pointFromCanonical(s: Surface, runId: string, localId: string): Point {
  return {
    id: localId,
    runId,
    author: s.author,
    source: s.contentAuthority === 'source-binding' ? 'file' : 'user',
    headline: s.content.headline,
    ...(s.content.body ? { content: s.content.body } : {}),
    ...(s.content.recipe ? { refresh: s.content.recipe } : {}),
    ...(s.order != null ? { order: s.order } : {}),
    status: s.thread.status,
    replies: s.thread.replies,
    createdAt: s.createdAt,
    amendedAt: s.amendedAt,
    ...(s.thread.resolvedAt != null ? { resolvedAt: s.thread.resolvedAt } : {}),
    ...(s.thread.dismissedAt != null ? { dismissedAt: s.thread.dismissedAt } : {}),
  }
}

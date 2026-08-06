// Test helper: put canonical Surfaces on a run's Slate the way production does.
//
// Before U2 a test seeded a run's Slate with `docStore.applyRunSlateProjection(...)`
// — the legacy file→store path. `Run.slate` no longer derives from that store, so a
// test that still seeds it is asserting against a channel nothing renders.
//
// This drives the REAL chain instead: the same reconciler the watcher calls, through
// the same mutation service, onto the same canonical store. It is deliberately not a
// shortcut that writes records directly — a helper that bypassed the service would
// let a test pass against a state production cannot reach.
//
// Not named `*.test.ts`, so vitest collects it as a module rather than a suite.

import { DocumentStore } from '../document-store'
import { SurfaceService } from '../../surfaces/surface-service'
import { reconcileSlateEpoch } from '../../surfaces/source-reconciler'
import { slateEntryWatermark, type SlateSourceEntry } from '../../surfaces/slate-source'
import { resolveRunSurfaceContext } from '../../surfaces/run-context'
import type {
  SurfaceRefreshRecipe,
  A2uiContent, PointAuthor, SurfaceClaim, SurfaceProposal, SurfacePrincipalRef,
} from '../../../domain/types'

const WATCHER: SurfacePrincipalRef = { kind: 'job', id: 'slate-watcher' }

/** One authored entry, as a `.tinstar/slate/*.json` file would state it. */
export interface SeedEntry {
  id: string
  headline: string
  body?: A2uiContent
  recipe?: SurfaceRefreshRecipe
  proposal?: SurfaceProposal
  /** What the entry declares would prove it wrong (U1). Tri-state, exactly as the
   *  file contract is: omit for "the author never said", pass `[]` for "the author
   *  checked and found nothing witnessable". Both project `unwitnessed` (U7). */
  claims?: SurfaceClaim[]
  author?: PointAuthor
  file?: string
}

/**
 * Reconcile `entries` as one epoch for `runId`. Pass `[]` to reconcile an empty
 * directory, which marks every existing binding source-missing exactly as an agent
 * deleting its files would.
 *
 * The run must already exist in the store with a `createdAt` — the incarnation is
 * derived from it, and a run without one has no canonical identity at all.
 */
export async function seedRunSlate(
  docStore: DocumentStore, runId: string, entries: SeedEntry[], at = Date.now(),
): Promise<void> {
  const run = docStore.getRun(runId)
  if (!run) throw new Error(`seedRunSlate: no run ${runId}`)
  const context = resolveRunSurfaceContext(run)
  if (!context) throw new Error(`seedRunSlate: run ${runId} has no derivable incarnation (needs createdAt)`)

  const svc = new SurfaceService(docStore)
  await reconcileSlateEpoch(svc, {
    runId,
    spaceId: context.spaceId,
    incarnation: context.incarnation,
    rootSurfaceId: context.rootSurfaceId,
    worktree: `/tmp/${runId}`,
    at,
    entries: entries.map(toEntry),
    unreadable: [],
  }, { actor: WATCHER, at })
}

function toEntry(seed: SeedEntry): SlateSourceEntry {
  const author: PointAuthor = seed.author ?? 'agent'
  const content = {
    headline: seed.headline,
    ...(seed.body ? { body: seed.body } : {}),
    ...(seed.recipe ? { recipe: seed.recipe } : {}),
    ...(seed.proposal ? { proposal: seed.proposal } : {}),
    // Presence, not truthiness: `[]` is a declaration the author made and must reach
    // the record as itself rather than collapsing into absent.
    ...(seed.claims !== undefined ? { claims: seed.claims } : {}),
  }
  return {
    localId: seed.id,
    file: seed.file ?? 'a.json',
    content,
    author,
    watermark: slateEntryWatermark({ ...content, author }),
  }
}

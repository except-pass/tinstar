// Per-source reconciliation for the `slate-file` adapter (plan U2).
//
// The watcher reads and validates; this decides. One call reconciles ONE run's
// complete watched directory as a single EPOCH — the whole prior binding set
// against the whole current one — and only then applies anything.
//
// WHY AN EPOCH AND NOT AN EVENT. `fs.watch` gives create/modify/remove events with
// no ordering guarantee between them, so a rename arrives as {create, remove} or
// {remove, create} depending on the platform and the debounce boundary. Deciding
// per event means the remove-first ordering retracts a Surface the create was about
// to rebind. Deciding per epoch means a rename is simply "same local id, new
// filename" and both orderings produce the identical outcome, because identity
// follows the entry's LOCAL ID and the run incarnation — never the filename.
//
// WHAT AN OMISSION MEANS, stated plainly because it is the behaviour change U2
// makes. The legacy projection RETRACTED a file-owned point that disappeared from
// the files. Canonical records are not retracted by an omission: the binding is
// marked source-missing and possibly stale, the last-valid body stays on screen,
// and the record only ever leaves the tree through the deletion service (KTD15).
// An `rm`, a `git checkout`, or an editor crash can therefore no longer destroy a
// thread by removing the file that seeded it.
//
// Server-only (rides the server esbuild bundle) and React-free.

import type { Surface, SurfaceCompatAlias, SurfaceHome } from '../../domain/types'
import { deriveLegacySurfaceId } from '../stores/surfaces'
import { parseSlateFileLocator, slateFileLocator, SLATE_FILE_ADAPTER, type SlateSourceEntry } from './slate-source'
import type { SurfaceCallContext, SurfaceService } from './surface-service'

/** One run's complete watched directory, after validation. */
export interface SlateSourceEpoch {
  runId: string
  spaceId: string
  /** The run INCARNATION — half the identity basis, so a deleted-and-recreated run
   *  reconciles onto its own Surfaces rather than inheriting a stranger's threads. */
  incarnation: string
  /** The canonical id of the run's compatibility root, derived from the incarnation. */
  rootSurfaceId: string
  /** Absolute worktree path the entries' filenames resolve against. */
  worktree: string
  /** Epoch ms the directory was read. */
  at: number
  /** Every entry that survived validation, in filename then array order. */
  entries: SlateSourceEntry[]
  /** Files that INTENDED to contribute but could not be read this epoch (torn
   *  write, oversized, unparseable). Bindings addressed to one of these are left
   *  entirely alone — a file that is present but momentarily unreadable is not a
   *  file that vanished, and treating it as one would flap a stale badge on every
   *  save. */
  unreadable: string[]
}

export interface SlateSourceEpochOutcome {
  /** Bindings observed present this epoch. */
  observed: number
  /** Surfaces this epoch created. */
  created: number
  /** Surfaces whose record this epoch rewrote (content, binding, or both). */
  updated: number
  /** Bindings marked source-missing this epoch. */
  missing: number
  /** Local ids that appeared more than once in the FINAL epoch. First occurrence
   *  wins; the rest are refused. Reported so the drop is observable rather than a
   *  surface that silently never appears. */
  duplicates: string[]
  /** Anything the mutation service refused, with its reason. */
  refusals: { localId: string; reason: string }[]
}

/**
 * Runs that still hold a persisted `slate-file` binding, with the worktree that
 * binding names — the watcher's second run source (plan U2: "Decouple source
 * watches from live-session membership when a promoted Surface still has a
 * persisted worktree binding").
 *
 * Read off the RECORDS rather than off the session config, deliberately. The
 * question is not "which runs are alive" — that is the other list — it is "which
 * paths does the canonical store still expect to reconcile from", and only the
 * records know that. `provenance.runId` is the alias-free answer: a Surface promoted
 * onto the Canvas keeps its provenance whatever happens to its home.
 *
 * Runs a Surface still names but whose worktree is gone are still returned; the
 * watcher's own `existsSync` check is what decides there is nothing to watch, and
 * duplicating that judgement here would put two answers in the codebase.
 */
export function boundSlateRuns(surfaces: readonly Surface[]): { runId: string; workdir: string }[] {
  const byRun = new Map<string, string>()
  for (const s of surfaces) {
    if (s.source?.adapter !== SLATE_FILE_ADAPTER) continue
    const { worktree } = s.source
    const runId = s.provenance?.runId
    if (!worktree || !runId || byRun.has(runId)) continue
    byRun.set(runId, worktree)
  }
  return [...byRun].map(([runId, workdir]) => ({ runId, workdir }))
}

/**
 * Reconcile one run's epoch against the canonical store.
 *
 * Ordering inside the epoch is load-bearing in one place only: the compatibility
 * root is ensured FIRST, because every created entry is homed on it. Everything
 * after that is per-binding and independent, which is what makes "updating one
 * source file cannot retract a Surface owned by another file" true by construction
 * — a refusal on one binding neither blocks nor rolls back any other.
 */
export async function reconcileSlateEpoch(
  svc: SurfaceService,
  epoch: SlateSourceEpoch,
  ctx: SurfaceCallContext,
): Promise<SlateSourceEpochOutcome> {
  const out: SlateSourceEpochOutcome = {
    observed: 0, created: 0, updated: 0, missing: 0, duplicates: [], refusals: [],
  }
  const at = epoch.at

  const root = await svc.ensureRunRoot({
    id: epoch.rootSurfaceId,
    spaceId: epoch.spaceId,
    runId: epoch.runId,
    createdAt: at,
  }, { ...ctx, at })
  if (!root.ok) {
    // No home for this run's entries. Refuse the whole epoch rather than homing
    // them on the Canvas: that would put every authored surface of every run on the
    // canvas as a top-level card, which is precisely what the compatibility root
    // exists to prevent (KTD3).
    out.refusals.push({ localId: '', reason: root.error.reason ?? root.error.code })
    return out
  }

  const home: SurfaceHome = { kind: 'surface', surfaceId: epoch.rootSurfaceId }
  const seen = new Set<string>()
  const unreadable = new Set(epoch.unreadable)

  for (const entry of epoch.entries) {
    if (seen.has(entry.localId)) {
      // First occurrence wins, matching the legacy projection's duplicate rule and
      // the migration's. Reported rather than silently dropped: a duplicated id is
      // an authoring mistake whose only other symptom is a surface that never shows
      // up, which has nothing for the author to find.
      if (!out.duplicates.includes(entry.localId)) out.duplicates.push(entry.localId)
      continue
    }
    seen.add(entry.localId)

    const id = deriveLegacySurfaceId(epoch.incarnation, entry.localId)
    const alias: SurfaceCompatAlias = {
      bucket: { kind: 'run', runId: epoch.runId },
      localId: entry.localId,
      visible: true,
    }
    const before = svc.get(id)
    const result = await svc.observeSource({
      id,
      spaceId: epoch.spaceId,
      home,
      adapter: SLATE_FILE_ADAPTER,
      locator: slateFileLocator(entry.file, entry.localId),
      worktree: epoch.worktree,
      alias,
      provenance: { runId: epoch.runId, worktreeId: epoch.worktree },
      author: entry.author,
      content: entry.content,
      watermark: entry.watermark,
      ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
    }, { ...ctx, at })

    if (!result.ok) {
      out.refusals.push({ localId: entry.localId, reason: result.error.reason ?? result.error.code })
      continue
    }
    out.observed++
    if (!before.ok) out.created++
    else if (result.data.surfaces[0]?.surface.rev !== before.data.surface.rev) out.updated++
  }

  // The negative half of the epoch: bindings this reconciler owns for this run that
  // the directory no longer offers. Computed from the COMPLETE prior set against the
  // COMPLETE current one, which is the only way an omission can be attributed to the
  // right binding.
  for (const bound of svc.sourceBindingsForRun(epoch.runId, SLATE_FILE_ADAPTER)) {
    if (seen.has(bound.localId)) continue
    const parsed = parseSlateFileLocator(bound.surface.source!.locator)
    // Its file could not be read this epoch. Not missing — unobserved. Leaving it
    // untouched is what "an invalid read retains the last-valid body" means on the
    // binding as well as on the content.
    if (parsed && unreadable.has(parsed.file)) continue
    const marked = await svc.markSourceMissing(bound.surface.id, SLATE_FILE_ADAPTER, { ...ctx, at })
    if (!marked.ok) {
      out.refusals.push({ localId: bound.localId, reason: marked.error.reason ?? marked.error.code })
      continue
    }
    if (bound.surface.source!.state !== 'missing') out.missing++
  }

  return out
}

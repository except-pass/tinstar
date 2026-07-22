// The Slate staleness sweep (plan U9 / R19).
//
// A `tinstar-run` wrapper writes a "running…" surface on start and finalizes it to
// ✓/✗ in an EXIT trap. A `kill -9` (SIGKILL) can't be trapped, so a hard-killed
// wrapper never runs its finalize and would leave a permanent fake-live spinner on
// the run card. Only the SERVER can detect this — a client (`age.ts`) can style age
// but can't distinguish "still updating" from "the writer died". This sweep is that
// server-side backstop: a low-frequency pass that marks a `process`-authored point
// whose `amendedAt` has gone stale (no file update for N minutes) as stalled.
//
// The rule (matches the plan verbatim): mark a point when it is
//   - authored by a `process` (the `tinstar-run` wrapper's author tag),
//   - NOT explicitly resolved/dismissed,
//   - NOT already stalled (so a repeat sweep is a no-op), and
//   - its `amendedAt` is older than the threshold.
// A live wrapper keeps `amendedAt` fresh via its periodic amend; when it resumes
// writing, the file re-projection clears `stalledAt` (see slate.ts mergeFileOwned).
//
// Server-only and React-free.

import type { Point } from '../../domain/types'

/** Default staleness threshold: no file update for 10 minutes → stalled. */
export const DEFAULT_STALENESS_MS = 10 * 60_000

/** The minimal store surface the sweep drives. Satisfied by `SlateStore`. */
export interface StalenessSweepStore {
  getAllPoints(): Point[]
  markStalled(runId: string, pointId: string, at: number): void
}

/**
 * Mark every process-authored, non-terminal, not-already-stalled point whose
 * `amendedAt` is older than `thresholdMs` as stalled. Returns the set of runIds that
 * had at least one point marked, so a caller can re-project just those runs.
 */
export function sweepStalledProcessPoints(
  store: StalenessSweepStore,
  now: number = Date.now(),
  thresholdMs: number = DEFAULT_STALENESS_MS,
): Set<string> {
  const affected = new Set<string>()
  for (const p of store.getAllPoints()) {
    if (p.author !== 'process') continue
    if (p.resolvedAt != null || p.dismissedAt != null) continue
    if (p.stalledAt != null) continue
    if (now - p.amendedAt <= thresholdMs) continue // strictly OLDER than the threshold
    store.markStalled(p.runId, p.id, now)
    affected.add(p.runId)
  }
  return affected
}

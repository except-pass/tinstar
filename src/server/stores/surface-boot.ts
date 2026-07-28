// Boot wiring for the canonical Surface store (plan U1).
//
// This is the one place that turns three independent pieces — the sidecar, the
// in-memory store, and the re-entrant legacy migration — into a startup
// sequence. It lives outside `index.ts` for a single reason: the faulted-boot
// behaviour is a test scenario ("a faulted load renders legacy Slate content
// behind the degraded marker and never presents it as current, while canonical
// projection stays empty"), and asserting it through the whole backend
// initializer would mean booting tmux, NATS, and a simulator to observe one
// branch.
//
// THE ORDERING THAT MATTERS. Every step here runs before session rehydration
// starts, because a faulted store must refuse persistence BEFORE any later
// startup work could write over the evidence. Concretely:
//
//   1. open the sidecar and take its load outcome (synchronous by design — see
//      `SurfaceSidecar.open`, which leaves no await point for rehydration to be
//      scheduled into);
//   2. on `faulted-read-only`: publish the degraded marker, load NOTHING, and
//      never attach the sidecar. Canonical projection stays EMPTY rather than
//      partial, and the Run Workspace keeps rendering the frozen legacy snapshot
//      behind a marker that says so;
//   3. otherwise: hydrate the records, attach the sidecar on the same gate as
//      `docStore.enablePersistence`, and reconcile legacy Slate points into
//      canonical records.
//
// Step 3's durable commit is the only part that finishes asynchronously, because
// making a snapshot durable involves real fsyncs and `initBackend` is
// synchronous. The returned promise is the seam for anyone who needs to wait.

import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { SurfaceHealthStatus } from '../../domain/types'
import type { DocumentStore } from './document-store'
import { SurfaceSidecar, type SurfaceCommitResult, type SurfaceLoadOutcome } from './surface-persistence'
import {
  migrateLegacySlate,
  type LegacyRunSnapshot,
  type SurfaceMigrationReport,
} from './surface-migration'

export interface SurfaceBootOptions {
  /** The config root holding `surfaces.json`. */
  dir: string
  /** The backend singleton to ASSERT (not acquire). Defaults to the same
   *  `<dir>/server.lock` `standalone.ts` acquires. */
  lockPath?: string
  /** The legacy core snapshot, read only for its mtime — the honest stand-in for
   *  "when was the frozen legacy copy last written" on a faulted boot. Defaults to
   *  `<dir>/docstore.json`. */
  legacySnapshotPath?: string
  /** Epoch ms stamped on the migration report. Injectable for determinism. */
  now?: number
}

export interface SurfaceBootResult {
  outcome: SurfaceLoadOutcome
  status: SurfaceHealthStatus
  /** Null exactly when the load faulted — nothing may write to a faulted store. */
  sidecar: SurfaceSidecar | null
  /**
   * Resolves when the migration pass has been made durable and installed.
   * `report` is absent only on a faulted boot, where no pass runs at all;
   * `commit` is absent when the pass produced no writes, which is the steady
   * state a boot with no legacy drift should reach.
   */
  migration: Promise<{ report?: SurfaceMigrationReport; commit?: SurfaceCommitResult }>
}

/** One sentence naming what was wrong with each snapshot file. Rendered verbatim
 *  in the degraded marker, so it must stay short and free of stack traces. */
function describeFault(outcome: SurfaceLoadOutcome): string | undefined {
  const fault = outcome.fault
  if (!fault) return undefined
  return `primary ${fault.primary.kind}, backup ${fault.backup.kind}`
}

/** When the frozen legacy snapshot was last written. Best-effort: an unreadable
 *  mtime yields no timestamp rather than a fabricated one — the marker says "not
 *  current" either way, and inventing a date is the failure it exists to prevent. */
function frozenAt(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return undefined
  }
}

/** Shape the DocumentStore's runs and Slate points into migration input. Runs
 *  with no id are skipped here rather than handed on: the migration quarantines
 *  them anyway, and reporting the same refusal twice makes the diagnostics dump
 *  read like two problems. */
export function legacyRunSnapshots(docStore: DocumentStore): LegacyRunSnapshot[] {
  const runs: LegacyRunSnapshot[] = []
  for (const run of docStore.getAllRuns()) {
    if (!run?.id) continue
    runs.push({
      runId: run.id,
      ...(run.createdAt ? { createdAt: run.createdAt } : {}),
      ...(run.spaceId ? { spaceId: run.spaceId } : {}),
      points: docStore.getSlatePointsForRun(run.id),
    })
  }
  return runs
}

export function bootSurfaces(docStore: DocumentStore, opts: SurfaceBootOptions): SurfaceBootResult {
  const lockPath = opts.lockPath ?? join(opts.dir, 'server.lock')
  const sidecar = SurfaceSidecar.open({ dir: opts.dir, lockPath })
  const outcome = sidecar.outcome

  if (outcome.health === 'faulted-read-only') {
    const frozen = frozenAt(opts.legacySnapshotPath ?? join(opts.dir, 'docstore.json'))
    const detail = describeFault(outcome)
    const status: SurfaceHealthStatus = {
      health: 'faulted-read-only',
      ...(frozen ? { frozenAt: frozen } : {}),
      ...(detail ? { detail } : {}),
    }
    docStore.setSurfaceHealth(status)
    // No `loadSurfaces`, no `enableSurfacePersistence`. Both omissions are the
    // behaviour, not an oversight: the store stays EMPTY (canonical projection is
    // empty rather than partial) and nothing in this process can write over the
    // two files a human may still be able to salvage.
    return { outcome, status, sidecar: null, migration: Promise.resolve({}) }
  }

  const status: SurfaceHealthStatus = { health: outcome.health }
  docStore.setSurfaceHealth(status)
  // The persisted topology counters ride along with the records. They are no longer
  // derivable from them — `purge` erases records, so `max(homeRev)` is only a floor
  // now (see the KTD5 amendment). A pre-U3 snapshot carries none and the store falls
  // back to that floor, which is exactly what it used to do.
  docStore.loadSurfaces(outcome.records, outcome.topologyRevs)
  docStore.enableSurfacePersistence(sidecar)

  const { puts, report } = migrateLegacySlate({
    runs: legacyRunSnapshots(docStore),
    existing: outcome.records,
    ...(opts.now != null ? { now: opts.now } : {}),
  })

  if (puts.length === 0) {
    return { outcome, status, sidecar, migration: Promise.resolve({ report }) }
  }

  // Durable first, then install — the same KTD7 ordering every other Surface
  // write obeys. A failed migration write leaves the canonical store exactly as
  // the sidecar hydrated it and leaves the legacy snapshot untouched, so the Run
  // Workspace is unaffected and the next boot simply tries again.
  const migration = sidecar
    .commit({ puts, onDurable: records => docStore.loadSurfaces(records) })
    .then(commit => ({ report, commit }))

  return { outcome, status, sidecar, migration }
}

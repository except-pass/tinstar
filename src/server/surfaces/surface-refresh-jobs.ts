// The durable refresh-job table (plan U6, KTD10).
//
// WHY A SEPARATE FILE AND NOT THE SURFACE SIDECAR. The sidecar is rewritten WHOLE
// on every commit and its cost is linear in total bytes — that measurement is what
// made U3's receipt a scalar envelope rather than a record snapshot. A job changes
// state several times per refresh (queued → running → completed) while its Surface
// changes once, so folding jobs in would multiply the cost of the slowest part of
// the system by the churniest data in it.
//
// WHAT THAT COSTS, stated plainly: a job transition and its Surface commit are two
// writes, not one, so a crash between them can leave a job record that disagrees
// with its Surface. That is SAFE here and it is worth naming why: the job table is
// ADVISORY. Every decision that could present stale content as current is made
// against the Surface's own revision and observation generation at the barrier
// (`SurfaceService.completeRefresh`), which re-reads both inside the durable
// transaction that commits the result. A job record that survived its Surface
// moving is refused there, exactly like one that never existed.
//
// Server-only and React-free.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SurfacePrincipalRef, SurfaceStaleReason } from '../../domain/types'
import { getConfigRoot } from '../configRoot'
import { log } from '../logger'

/** Filename under the config root. */
export const REFRESH_JOBS_FILE = 'surface-refresh-jobs.json'
/** Directory workers stage results into. Deliberately under the CONFIG root and
 *  never inside a worktree, so a staged artifact can never be picked up by the
 *  Slate watcher and bypass the barrier (plan U6: "Workers write validated A2UI
 *  and evidence only to a job-specific staging path outside `.tinstar/slate`"). */
export const REFRESH_STAGING_DIR = 'refresh-staging'

export type SurfaceRefreshJobState =
  | 'queued' | 'running' | 'completed' | 'superseded' | 'failed' | 'cancelled'

/** States a job may still move out of. Exactly one may exist per Surface. */
export const ACTIVE_JOB_STATES: readonly SurfaceRefreshJobState[] = ['queued', 'running']

/**
 * The value a retired background-worker dispatch was recorded under.
 *
 * NAMED ONCE, HERE, AND READ NOWHERE ELSE. It exists only so {@link hydrate} can
 * recognise a job written by the removed autonomous-worker architecture and
 * terminalize it. Keeping it as a named constant rather than an inline literal is
 * deliberate: it makes the one legitimate mention greppable and distinguishes it
 * from a dispatch path, which is what the plan's safety gate is looking for.
 */
export const LEGACY_WORKER_DISPATCH_KIND = 'worker'

/** How the work reached its executor. */
export interface SurfaceRefreshDispatch {
  /** `owner` — handed to the Surface's live foreground agent, serialized.
   *  `blocked` — nothing was dispatched, and `reason` says why.
   *
   *  There is deliberately no background variant (plan U1, KTD3). A refresh may not
   *  create a managed session, so there is no third recipient to name. */
  kind: 'owner' | 'blocked'
  /** Session name for `owner`; absent for `blocked`. */
  target?: string
  reason?: string
  at: number
}

export interface SurfaceRefreshJob {
  id: string
  surfaceId: string
  spaceId: string
  /** The run whose worktree the work is authorized in. */
  runId?: string
  worktree?: string
  state: SurfaceRefreshJobState
  /** Why the Surface was scheduled. Carried on the job so a completed job still
   *  explains itself after the Surface's own reason has been cleared. */
  reason: SurfaceStaleReason
  /** The Surface revision this job was created against.
   *
   *  BOOKKEEPING ONLY — do not reach for it as a compare-and-swap. The
   *  coordinator's own `setSchedule`, `markPossiblyStale`, and `beginRefresh`
   *  commits all bump `rev` inside the refresh window, so comparing it at the
   *  barrier would refuse every result the engine ever produced. The guard that
   *  actually protects a concurrent edit is `baseContentDigest`. */
  baseRev: number
  /** {@link surfaceContentDigest} of the authored content this job's worker was
   *  told to replace, snapshotted at `beginRefresh` and handed back to the barrier
   *  as `expectedContentDigest`. Content is the right axis precisely because
   *  everything else on the record legitimately moves while a refresh runs. */
  baseContentDigest?: string
  /** The host observation generation the Surface stood at when the job was
   *  created. */
  startGeneration: number
  /** The newest generation this job must consume. Raised by coalescing, never
   *  lowered — the only ordering KTD10 permits. */
  targetGeneration: number
  dueAt?: number
  /** Who may advance this job, and until when. A lease that has expired is
   *  reclaimable; a live one belonging to someone else is not. */
  lease?: { owner: string; until: number }
  attempts: number
  /** What was true about authorization when the job was created. Snapshotted
   *  rather than re-derived, so a blocked job can still say what blocked it after
   *  the session that owned the worktree is gone. */
  authorization: { principal: SurfacePrincipalRef; worktree?: string; blocked?: string }
  dispatch?: SurfaceRefreshDispatch
  /** Absolute path this job's worker writes its result to. */
  stagingPath: string
  result?: { ok: boolean; message?: string }
  createdAt: number
  updatedAt: number
}

/** How many TERMINAL jobs are retained. Active jobs are never pruned — they are
 *  the work itself. Terminal ones are evidence, and a table that grew without
 *  bound would eventually cost more to rewrite than the refreshes it records. */
export const TERMINAL_JOB_RETENTION = 200

/**
 * The format this store writes.
 *
 * 1 — the autonomous-worker era: a job could carry a `worker` dispatch naming a
 *     managed session the host had launched for it.
 * 2 — after the safety cut (plan U1). No job may name a background session, and any
 *     version-1 job that still did is terminalized once on hydration.
 */
export const REFRESH_JOBS_FORMAT_VERSION = 2

interface JobsFile {
  version: number
  jobs: SurfaceRefreshJob[]
}

/** What one boot's legacy reconciliation did, so the coordinator can settle the
 *  Surfaces those jobs abandoned (KTD8: content preserved, Surface left dirty). */
export interface LegacyJobReconciliation {
  jobId: string
  surfaceId: string
  /** What the terminal record says happened, reused verbatim as the Surface's
   *  recorded check detail so the two cannot drift. */
  message: string
}

/** The message a terminalized legacy worker job carries. One phrasing, so a
 *  diagnostic can recognise reconciled history rather than a live failure. */
export const LEGACY_WORKER_RECONCILED =
  'this refresh was left behind by the removed background-worker architecture; '
  + 'its content is preserved and the Surface is dirty again'

/** Filesystem seam, so tests need no temp dir. */
export interface JobStoreIo {
  read(path: string): string | null
  write(path: string, data: string): void
  mkdir(path: string): void
}

const NODE_IO: JobStoreIo = {
  read(path) {
    try { return readFileSync(path, 'utf8') } catch { return null }
  },
  write(path, data) {
    // Temp-then-rename, like every other durable write in this codebase: a reader
    // must never observe a half-written table and read it as an empty one.
    const temp = `${path}.tmp`
    writeFileSync(temp, data, 'utf8')
    renameSync(temp, path)
  },
  mkdir(path) { mkdirSync(path, { recursive: true }) },
}

function isJob(v: unknown): v is SurfaceRefreshJob {
  if (!v || typeof v !== 'object') return false
  const j = v as Partial<SurfaceRefreshJob>
  return typeof j.id === 'string' && typeof j.surfaceId === 'string' && typeof j.state === 'string'
    && typeof j.baseRev === 'number' && typeof j.stagingPath === 'string'
}

/**
 * The refresh job table.
 *
 * Loaded whole at construction and written whole on mutation — the table is a few
 * hundred small records at its retention cap, and a partial-write scheme would buy
 * nothing against that while adding a second way for it to be inconsistent.
 *
 * A table that will not parse is REPLACED with an empty one rather than throwing:
 * losing the job table costs at most a re-observation (the sweep re-derives due
 * work from the Surfaces themselves), while refusing to boot over it would take
 * the whole dashboard down for a file nothing else depends on.
 */
export class SurfaceRefreshJobStore {
  private jobs = new Map<string, SurfaceRefreshJob>()

  /** Legacy worker jobs this boot terminalized. Read once by the coordinator's
   *  recovery pass; see {@link takeLegacyReconciliations}. */
  private reconciled: LegacyJobReconciliation[] = []

  private constructor(
    private readonly path: string,
    readonly stagingDir: string,
    private readonly io: JobStoreIo,
  ) {}

  static open(dir: string = getConfigRoot(), io: JobStoreIo = NODE_IO): SurfaceRefreshJobStore {
    const store = new SurfaceRefreshJobStore(join(dir, REFRESH_JOBS_FILE), join(dir, REFRESH_STAGING_DIR), io)
    store.hydrate()
    try { io.mkdir(store.stagingDir) } catch (err) {
      log.warn('refresh', `could not create the staging directory: ${(err as Error).message}`)
    }
    return store
  }

  /**
   * Load the table, reconciling anything the removed worker architecture left
   * behind (plan U1, KTD8).
   *
   * TERMINALIZED ONCE, AND THE "ONCE" IS THE PERSIST. An active job naming a
   * background session describes a process that cannot exist any more — nothing
   * will ever write its staging artifact, nothing will ever harvest it, and while
   * it stays active `scheduleFor` coalesces every later trigger onto it, so its
   * Surface stops refreshing entirely. Failing it here converts a permanently
   * wedged Surface into a dirty one.
   *
   * ITS CONTENT IS NOT TOUCHED. This store holds no Surface content and writes
   * none; the coordinator settles the Surface itself from
   * {@link takeLegacyReconciliations}, which preserves last-known content by
   * construction because the only mutators it calls are the ones that do.
   *
   * The rewrite at version {@link REFRESH_JOBS_FORMAT_VERSION} is what makes the
   * conversion idempotent across boots: the second boot reads a table with no
   * active legacy dispatch left in it, so it reconciles nothing.
   */
  private hydrate(): void {
    const raw = this.io.read(this.path)
    if (!raw) return
    let migrated = false
    try {
      const parsed = JSON.parse(raw) as Partial<JobsFile>
      for (const job of parsed.jobs ?? []) {
        if (!isJob(job)) continue
        if (this.isAbandonedLegacyJob(job)) {
          migrated = true
          this.reconciled.push({
            jobId: job.id, surfaceId: job.surfaceId, message: LEGACY_WORKER_RECONCILED,
          })
          this.jobs.set(job.id, {
            ...job,
            state: 'failed',
            result: { ok: false, message: LEGACY_WORKER_RECONCILED },
            // The lease goes with it. A live lease on a terminal job is a claim
            // nobody can release, and a later reader would treat it as work in hand.
            lease: undefined,
          })
          continue
        }
        this.jobs.set(job.id, job)
      }
      if ((parsed.version ?? 1) !== REFRESH_JOBS_FORMAT_VERSION) migrated = true
    } catch (err) {
      log.warn('refresh', `refresh job table unreadable, starting empty: ${(err as Error).message}`)
      return
    }
    if (this.reconciled.length) {
      log.info('refresh', `reconciled ${this.reconciled.length} refresh job(s) from the removed worker architecture`)
    }
    // Rewrite so the reconciliation is durable. Without this the same jobs are
    // re-terminalized on every boot, which would re-dirty their Surfaces forever.
    if (migrated) this.persist()
  }

  /** An ACTIVE job whose dispatch named a background session. Terminal legacy jobs
   *  are left exactly as they are — they are history, and rewriting evidence to
   *  match a newer vocabulary is how evidence stops being evidence. */
  private isAbandonedLegacyJob(job: SurfaceRefreshJob): boolean {
    if (!ACTIVE_JOB_STATES.includes(job.state)) return false
    return (job.dispatch as { kind?: string } | undefined)?.kind === LEGACY_WORKER_DISPATCH_KIND
  }

  /**
   * Hand the caller this boot's legacy reconciliations, exactly once.
   *
   * DRAINED RATHER THAN READ, because the caller's job is to commit a Surface-side
   * consequence for each one and a second reader committing it again would burn a
   * revision — and an SSE frame — for a decision already made.
   */
  takeLegacyReconciliations(): LegacyJobReconciliation[] {
    const out = this.reconciled
    this.reconciled = []
    return out
  }

  /** Where a job's worker stages its result. Per-job, so two workers can never
   *  read each other's output — the property that makes the barrier's evidence
   *  attributable to exactly one dispatch. */
  stagingPathFor(jobId: string): string {
    return join(this.stagingDir, `${jobId}.json`)
  }

  list(): SurfaceRefreshJob[] {
    return [...this.jobs.values()]
  }

  get(id: string): SurfaceRefreshJob | undefined {
    return this.jobs.get(id)
  }

  /** The one job that still owns this Surface, if any. `queued` and `running` are
   *  the only states that own anything — "only one job executes per Surface". */
  active(surfaceId: string): SurfaceRefreshJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.surfaceId === surfaceId && ACTIVE_JOB_STATES.includes(job.state)) return job
    }
    return undefined
  }

  activeCount(state?: SurfaceRefreshJobState): number {
    let n = 0
    for (const job of this.jobs.values()) {
      if (state ? job.state === state : ACTIVE_JOB_STATES.includes(job.state)) n++
    }
    return n
  }

  put(job: SurfaceRefreshJob): SurfaceRefreshJob {
    this.jobs.set(job.id, job)
    this.persist()
    return job
  }

  /** Patch a job by id. Returns the updated record, or undefined if it is gone. */
  update(id: string, patch: Partial<SurfaceRefreshJob>, now: number): SurfaceRefreshJob | undefined {
    const prior = this.jobs.get(id)
    if (!prior) return undefined
    const next = { ...prior, ...patch, updatedAt: now }
    this.jobs.set(id, next)
    this.persist()
    return next
  }

  private persist(): void {
    this.prune()
    const file: JobsFile = { version: REFRESH_JOBS_FORMAT_VERSION, jobs: [...this.jobs.values()] }
    try {
      this.io.write(this.path, JSON.stringify(file))
    } catch (err) {
      // The engine keeps working off its in-memory table; only restart recovery
      // degrades. Louder than a debug line because a persistently unwritable table
      // means every restart re-does work it already did.
      log.warn('refresh', `could not persist the refresh job table: ${(err as Error).message}`)
    }
  }

  /** Drop the oldest terminal jobs past the retention cap. Active jobs are never
   *  candidates — pruning one would lose work in flight. */
  private prune(): void {
    const terminal = [...this.jobs.values()]
      .filter(j => !ACTIVE_JOB_STATES.includes(j.state))
      .sort((a, b) => a.updatedAt - b.updatedAt)
    for (let i = 0; i < terminal.length - TERMINAL_JOB_RETENTION; i++) {
      this.jobs.delete(terminal[i]!.id)
    }
  }
}

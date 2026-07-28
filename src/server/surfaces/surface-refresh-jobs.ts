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

/** How the work reached a worker. */
export interface SurfaceRefreshDispatch {
  /** `owner` — handed to the Surface's live owner session, serialized.
   *  `worker` — a background managed session launched for this job.
   *  `blocked` — nothing was dispatched, and `reason` says why. */
  kind: 'owner' | 'worker' | 'blocked'
  /** Session name for `owner`/`worker`; absent for `blocked`. */
  target?: string
  /** The INCARNATION of `target` at dispatch — a `worker` launch's conversation id
   *  (or creation stamp). Persisted so restart recovery can require that the session
   *  it adopts is the one this job launched: a session name is reusable, and adopting
   *  a stranger that shares it would attribute someone else's output to this job.
   *  Absent on jobs written before this was recorded, and on owner dispatches. */
  incarnation?: string
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

interface JobsFile {
  version: 1
  jobs: SurfaceRefreshJob[]
}

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

  private hydrate(): void {
    const raw = this.io.read(this.path)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as Partial<JobsFile>
      for (const job of parsed.jobs ?? []) {
        if (isJob(job)) this.jobs.set(job.id, job)
      }
    } catch (err) {
      log.warn('refresh', `refresh job table unreadable, starting empty: ${(err as Error).message}`)
    }
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

  /**
   * Running jobs that hold a BACKGROUND WORKER.
   *
   * The fleet cap bounds managed sessions and the ttyd ports they claim, and an
   * OWNER delivery claims neither — it is a prompt handed to a session that already
   * exists. `activeCount('running')` cannot tell the two apart, so it counted owner
   * deliveries against the cap from the sweep AFTER the one that dispatched them.
   * The invariant the dispatch path documents ("this costs no port and no session,
   * so it is NOT counted against the cap") therefore held for exactly one pass, and
   * with `maxConcurrentWorkers: 4`, four in-flight owner deliveries — claiming zero
   * ports — blocked the entire background fleet for up to the worker timeout. Owner
   * delivery is the preferred path whenever the run's session is live, so that was
   * the common case, not the corner.
   */
  runningWorkerCount(): number {
    let n = 0
    for (const job of this.jobs.values()) {
      if (job.state === 'running' && job.dispatch?.kind === 'worker') n++
    }
    return n
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
    const file: JobsFile = { version: 1, jobs: [...this.jobs.values()] }
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

// The durable refresh engine (plan U6, R13-R18, KTD10/KTD11).
//
// WHAT THIS OWNS: turning typed triggers into durable jobs, deciding which of those
// jobs may run right now, dispatching them, and — the part that matters most —
// refusing to call a Surface current unless the host has just re-observed its
// sources and found nothing newer than the result it is about to commit.
//
// THE ONE INVARIANT WORTH RESTATING (KTD10). "The refresh finished" and "the
// Surface is current" are DIFFERENT CLAIMS. A worker that ran for four minutes
// against a repo that moved three minutes in describes a world that no longer
// exists. So every completion goes through a BARRIER: re-observe, advance any
// generation that changed, then hand the result to
// `SurfaceService.completeRefresh`, which compares the Surface's revision and
// observation generation inside the same durable transaction that would commit it.
// A mismatch is not an error — it is a supersession, and exactly one successor is
// scheduled for the newer generation.
//
// EVERYTHING EXTERNAL IS INJECTED. Session launching, prompt delivery, staging
// reads, source re-observation, and the clock all arrive as dependencies, so the
// state machine and its restart behaviour are testable without tmux, without a
// filesystem, and without waiting on real time. The wiring that supplies the real
// ones lives in `src/server/index.ts`.
//
// Server-only and React-free.

import type {
  Surface, SurfaceContent, SurfacePrincipalRef, SurfaceRefreshDeclaration, SurfaceStaleReason,
} from '../../domain/types'
import { log } from '../logger'
import { serializeByKey } from '../sessions/backends/serializeByKey'
import { surfaceContentDigest, type SurfaceCallContext, type SurfaceService } from './surface-service'
import {
  ACTIVE_JOB_STATES,
  type SurfaceRefreshJob,
  type SurfaceRefreshJobStore,
} from './surface-refresh-jobs'
import {
  coalesceGeneration,
  deriveDueAt,
  effectiveDeclaration,
  matchTrigger,
  MIN_INTERVAL_MS,
  type SurfaceTriggerEvent,
} from './surface-trigger-matcher'

/** A worker's staged output, after the caller has validated it. */
export interface StagedRefreshResult {
  /** Authored content the worker produced. Absent means "I looked and nothing
   *  needed to change" — a legitimate outcome that must still complete the job
   *  explicitly rather than leave a spinner running (R17). */
  content?: SurfaceContent
  /** Free text the worker wrote about what it did, for the failure path. */
  note?: string
  /** Present when the worker reports it could NOT do the job. */
  error?: string
}

/** What a launch attempt produced. */
export type WorkerLaunch =
  | {
    ok: true
    sessionName: string
    /** The launched session's INCARNATION — its conversation id, or its creation
     *  stamp when it has none. Persisted onto the dispatch so restart recovery can
     *  require that the session it adopts is the same incarnation this job
     *  launched, not a later one that reused the name. */
    incarnation?: string
  }
  | { ok: false; message: string }

export interface RefreshCoordinatorConfig {
  /** Fleet-wide cap on concurrently RUNNING background workers. */
  maxConcurrentWorkers: number
  /** Wall-clock bound on one worker before its job is failed. */
  workerTimeoutMs: number
  /** Verification interval for a Surface that asked for one without saying how long. */
  defaultIntervalMs: number
  /** KTD11's rollout kill switch. False ⇒ no background worker is ever launched
   *  and every dispatch falls back to owner delivery. */
  autonomousWorkers: boolean
}

export interface RefreshCoordinatorDeps {
  service: SurfaceService
  jobs: SurfaceRefreshJobStore
  /** Every Surface the coordinator may consider. */
  surfaces: () => readonly Surface[]
  config: () => RefreshCoordinatorConfig
  now: () => number
  newJobId: () => string
  /** Hand serialized work to a live owner session. Resolves false when it did not
   *  land, which is not an error — the owner may simply be asleep. */
  deliverToOwner: (input: { sessionName: string; prompt: string; job: SurfaceRefreshJob }) => Promise<boolean>
  /** Is this managed session alive right now? Liveness must mean a PROCESS, not a
   *  record: a session file outlives the tmux process it describes. */
  isLiveSession: (name: string) => boolean
  /** The incarnation this session is currently on, or undefined when there is no
   *  session. Compared against the one a dispatch recorded, so restart recovery
   *  cannot adopt a different session that happens to share the name. */
  sessionIncarnation: (name: string) => string | undefined
  /** Launch a background managed session that runs the recipe and writes
   *  `job.stagingPath`. Only called when `autonomousWorkers` is on. */
  launchWorker: (input: { job: SurfaceRefreshJob; surface: Surface; prompt: string }) => Promise<WorkerLaunch>
  /** Retire a worker session through the normal Graveyard path. */
  retireWorker: (sessionName: string) => Promise<void>
  /** Read a staged artifact, or null when the worker has not written one yet. */
  readStaged: (path: string) => Promise<StagedRefreshResult | null>
  /** Discard a consumed staging artifact. Best-effort. */
  clearStaged: (path: string) => Promise<void>
  /** THE BARRIER's first half: directly re-observe every authoritative source for
   *  this Surface, advancing any generation that changed. Must complete before a
   *  result may claim current. */
  observeSources: (surface: Surface) => Promise<void>
  /** Build the self-contained instruction a worker or owner receives. */
  buildPrompt: (input: { surface: Surface; job: SurfaceRefreshJob; stagingPath: string }) => string
}

/** The principal the coordinator itself acts as (KTD6: host jobs get their own). */
export const COORDINATOR_PRINCIPAL: SurfacePrincipalRef = {
  kind: 'job', id: 'refresh-coordinator', label: 'Refresh coordinator',
}

/** How long a dispatch lease is held before another sweep may reclaim it. Longer
 *  than one sweep and shorter than a worker timeout, so a coordinator that died
 *  mid-dispatch does not strand its job until the timeout. */
export const LEASE_MS = 60_000

/** What one `note`/`sweep` pass did, for logging and for tests. */
export interface RefreshPassReport {
  /** Surfaces this pass moved to possibly-stale (or re-armed while in flight). */
  marked: string[]
  /** Jobs created. */
  queued: string[]
  /** Jobs whose target generation was raised instead of a second job being made. */
  coalesced: string[]
  /** Jobs dispatched this pass. */
  dispatched: string[]
  /** Jobs held back by the concurrency cap. */
  heldByCap: string[]
  /** Jobs that could not be dispatched, with the reason. */
  blocked: { jobId: string; reason: string }[]
  /** Jobs that completed successfully. */
  completed: string[]
  /** Jobs whose result was refused by the barrier. */
  superseded: string[]
  /** Jobs that failed, with the reason. */
  failed: { jobId: string; reason: string }[]
}

function emptyReport(): RefreshPassReport {
  return {
    marked: [], queued: [], coalesced: [], dispatched: [], heldByCap: [],
    blocked: [], completed: [], superseded: [], failed: [],
  }
}

/** The one serialization key every public entry point runs under. See
 *  {@link SurfaceRefreshCoordinator.entry}. */
const ENTRY_KEY = 'refresh-coordinator'

/** The verification interval in force, floored the same way `deriveDueAt` floors
 *  it — so a retry cooldown can never be shorter than the shortest interval an
 *  author is allowed to ask for. */
function intervalFor(decl: SurfaceRefreshDeclaration, defaultIntervalMs: number): number {
  return Math.max(MIN_INTERVAL_MS, decl.intervalMs ?? defaultIntervalMs)
}

export class SurfaceRefreshCoordinator {
  constructor(private readonly deps: RefreshCoordinatorDeps) {}

  /** In-flight tail for {@link entry}. Instance-scoped: two coordinators (a test
   *  builds several) must not queue behind each other. */
  private readonly chain = new Map<string, Promise<unknown>>()

  /**
   * Run one public entry point, never overlapping another.
   *
   * WHY THIS IS NOT OPTIONAL. `scheduleFor` is a read-modify-write split by two
   * awaits: it reads `jobs.active(surfaceId)`, awaits `enqueueRefresh`, then awaits
   * its way to `jobs.put`. Two callers interleaving inside that window BOTH see no
   * active job and BOTH create one, and the durable table's own "exactly one active
   * job per Surface" invariant is gone. The host makes that interleaving the normal
   * case: `index.ts` fires `void refreshCoordinator.note(...)` from the 15s git poll
   * and never awaits it, while the sweep timer is guarded only against another
   * SWEEP.
   *
   * What that cost before this: the loser of the race sits `queued` forever. It can
   * never `begin` — `beginRefresh` requires phase `queued`, which the winner has
   * already left — and nothing ages a queued job out, so the Surface holds an active
   * job that will never run, and every later trigger coalesces onto it instead of
   * scheduling work. The Surface becomes un-refreshable for the process lifetime,
   * and the manual refresh button hits the same wall.
   *
   * The queue is the whole fix, and it is cheap: `note` is a few commits, and a
   * sweep already holds the only interesting work. Callers still observe their own
   * result and their own rejection.
   */
  private entry<T>(task: () => Promise<T>): Promise<T> {
    return serializeByKey(this.chain, ENTRY_KEY, task)
  }

  private ctx(at: number): SurfaceCallContext {
    return { actor: COORDINATOR_PRINCIPAL, at }
  }

  private surface(id: string): Surface | undefined {
    return this.deps.surfaces().find(s => s.id === id)
  }

  // --- Triggers ------------------------------------------------------------

  /**
   * Record one typed observation.
   *
   * Marking is idempotent on the reason key (see
   * `SurfaceService.markPossiblyStale`), so a poll floor re-reporting the same Git
   * SHA every few seconds commits nothing after the first time. Scheduling is
   * idempotent per Surface: an active job absorbs the newer generation rather than
   * a second job being created, which is what "repeated equivalent events create
   * one queued job" means at the durable layer.
   */
  async note(event: SurfaceTriggerEvent): Promise<RefreshPassReport> {
    return this.entry(() => this.noteNow(event))
  }

  private async noteNow(event: SurfaceTriggerEvent): Promise<RefreshPassReport> {
    const report = emptyReport()
    const at = event.at || this.deps.now()
    for (const match of matchTrigger(event, this.deps.surfaces())) {
      const marked = await this.deps.service.markPossiblyStale(match.surface.id, match.reason, this.ctx(at))
      if (!marked.ok) {
        log.warn('refresh', `could not mark ${match.surface.id} stale: ${marked.error.message}`)
        continue
      }
      const after = this.surface(match.surface.id)
      if (!after) continue
      // `markPossiblyStale` short-circuits a repeat to an unchanged result. Nothing
      // moved, so there is nothing new to schedule either.
      if (marked.data.surfaces[0]?.surface.rev === match.surface.rev) continue
      report.marked.push(after.id)
      // `mark-stale` policy stops HERE. That is its entire visible difference from
      // `automatic`: the badge and the reason appear, and no job is ever created.
      if (match.policy !== 'automatic') continue
      await this.scheduleFor(after, after.freshness.staleReason, report)
    }
    return report
  }

  /**
   * Schedule a job for a Surface a human explicitly asked for.
   *
   * Separate from `note` because the route has already moved the Surface to
   * `queued` through `SurfaceService.refreshRequest` — U3 owns that transition and
   * re-deriving it here would double-commit it. This only creates the durable job
   * that services it, and it works for `manual` and `mark-stale` Surfaces too:
   * being asked is the one thing every policy honours (R18's "manual recovery
   * available whenever automatic refresh cannot complete").
   */
  async requestFor(surfaceId: string): Promise<SurfaceRefreshJob | undefined> {
    return this.entry(() => this.requestForNow(surfaceId))
  }

  private async requestForNow(surfaceId: string): Promise<SurfaceRefreshJob | undefined> {
    const surface = this.surface(surfaceId)
    if (!surface) return undefined
    const report = emptyReport()
    const at = this.deps.now()
    const reason: SurfaceStaleReason = surface.freshness.staleReason ?? {
      kind: 'human-intent',
      key: `human-intent ${surfaceId} ${at}`,
      detail: 'you asked for it',
      generation: surface.source?.generation ?? 0,
      at,
    }
    return this.scheduleFor(surface, reason, report)
  }

  /**
   * Create or coalesce the one job that owns this Surface.
   *
   * COALESCING IS A MAX OF GENERATIONS and nothing else — an active job raises its
   * target and keeps running rather than being cancelled and re-made, so a burst of
   * triggers during a refresh produces one successor, not one per trigger.
   */
  private async scheduleFor(
    surface: Surface, reason: SurfaceStaleReason | undefined, report: RefreshPassReport,
  ): Promise<SurfaceRefreshJob | undefined> {
    const at = this.deps.now()
    // A PERMANENTLY BLOCKED SURFACE GETS NO JOB AT ALL. Creating one and failing it
    // at dispatch would be the same loop with extra steps: the deadline that
    // scheduled it can never move (`dueAt` derives from the last SUCCESSFUL
    // verification), so every sweep after the failure cooldown would make another
    // one. The blocker is recorded on the Surface instead, once, where the user can
    // read it — and a human ⟳ hits this too, which is right: being asked does not
    // conjure a file back.
    const permanent = this.refreshBlocker(surface)
    if (permanent?.permanent) {
      await this.recordBlocked(surface, permanent.reason, at)
      report.blocked.push({ jobId: '', reason: permanent.reason })
      return undefined
    }
    const generation = surface.source?.generation ?? 0
    const existing = this.deps.jobs.active(surface.id)
    if (existing) {
      // A RUNNING job's target is FROZEN at dispatch, and that is the whole
      // supersession mechanism: raising it here would quietly redefine what the
      // worker was computing against, so a result produced before the newer
      // observation would sail through the barrier and claim current. A queued job
      // has not been handed to anybody yet, so it absorbs the newer generation and
      // no second job is created.
      if (existing.state !== 'queued') return existing
      const target = coalesceGeneration(existing.targetGeneration, generation)
      if (target !== existing.targetGeneration) {
        report.coalesced.push(existing.id)
        return this.deps.jobs.update(existing.id, { targetGeneration: target }, at)
      }
      return existing
    }

    const decl = effectiveDeclaration(surface)
    const id = this.deps.newJobId()
    const worktree = surface.source?.worktree ?? surface.provenance?.worktreeId
    const runId = surface.provenance?.runId
    const job: SurfaceRefreshJob = {
      id,
      surfaceId: surface.id,
      spaceId: surface.spaceId,
      ...(runId ? { runId } : {}),
      ...(worktree ? { worktree } : {}),
      state: 'queued',
      reason: reason ?? {
        kind: 'human-intent', key: `human-intent ${surface.id} ${at}`,
        detail: 'you asked for it', generation, at,
      },
      baseRev: surface.rev,
      startGeneration: generation,
      targetGeneration: generation,
      ...(deriveDueAt(surface, decl, this.deps.config().defaultIntervalMs) !== undefined
        ? { dueAt: deriveDueAt(surface, decl, this.deps.config().defaultIntervalMs)! }
        : {}),
      attempts: 0,
      authorization: {
        principal: COORDINATOR_PRINCIPAL,
        ...(worktree ? { worktree } : {}),
        ...(permanent ? { blocked: permanent.reason } : {}),
      },
      stagingPath: this.deps.jobs.stagingPathFor(id),
      createdAt: at,
      updatedAt: at,
    }
    // The record moves FIRST. A durable job whose Surface still reads `current` is
    // the one inconsistency a user would actually notice — the badge is the whole
    // point of the feature — so if the transition is refused, no job is written at
    // all and the next trigger tries again.
    const queued = await this.deps.service.enqueueRefresh(surface.id, { jobId: id }, this.ctx(at))
    if (!queued.ok) {
      log.info('refresh', `could not queue ${surface.id}: ${queued.error.message}`)
      return undefined
    }
    report.queued.push(id)
    return this.deps.jobs.put(job)
  }

  /**
   * Why this Surface may NOT be refreshed autonomously, or undefined.
   *
   * AE7's mixed-worktree rule: a dispatch has to name exactly one worktree it is
   * authorized in. A Surface whose binding and provenance disagree about which
   * worktree it belongs to is precisely the "parent spanning two worktrees" case,
   * and guessing between them would write into a repository nobody authorized.
   *
   * THE MISSING SOURCE IS THE ONE THAT DOES NOT RETRY, and it is the only blocker
   * here that is `permanent`. U2 keeps a Surface whose source file was deleted —
   * deliberately, so an `rm` or a `git checkout` cannot destroy a thread — but U6
   * never consulted that state, so the refresh engine kept scheduling work with
   * nowhere to commit it. Observed on this machine: a Surface sat `refreshing` while
   * a real background agent ran to its ten-minute timeout, failed, waited one
   * interval, and did it again, forever, because `verifiedAt` can never advance
   * through a binding that resolves to no file.
   */
  private refreshBlocker(surface: Surface): { reason: string; permanent: boolean } | undefined {
    if (surface.source?.state === 'missing') {
      return {
        reason: `its source (${surface.source.locator}) is gone, so a rebuilt result would have nowhere to land`,
        permanent: true,
      }
    }
    const bound = surface.source?.worktree
    const provenance = surface.provenance?.worktreeId
    if (bound && provenance && bound !== provenance) {
      return {
        reason: `this Surface names two worktrees (${bound} and ${provenance}); a refresh may not choose between them`,
        permanent: false,
      }
    }
    if (!bound && !provenance) {
      return { reason: 'no worktree is recorded, so there is nowhere authorized to run a refresh', permanent: false }
    }
    if (!surface.content.recipe) {
      return {
        reason: 'this Surface declares no refresh recipe, so nothing can rebuild it without a human',
        permanent: false,
      }
    }
    return undefined
  }

  /**
   * Record a blocker on the Surface WITHOUT burning a revision per sweep.
   *
   * A permanent blocker is re-derived on every deadline pass, so committing it
   * unconditionally would rewrite the record — and emit SSE — every few seconds for
   * as long as the file stays deleted. `failRefresh` cannot short-circuit this
   * itself: its `failure.at` stamp moves on every call, so the store's no-change
   * check never fires.
   */
  private async recordBlocked(surface: Surface, reason: string, at: number): Promise<void> {
    if (surface.freshness.phase === 'failed' && surface.freshness.failure?.message === reason) return
    await this.deps.service.failRefresh(surface.id, { jobId: '', message: reason }, this.ctx(at))
  }

  // --- The sweep -----------------------------------------------------------

  /**
   * One periodic pass: deadlines, then harvest, then dispatch.
   *
   * ORDER IS LOAD-BEARING. Deadlines first, so a Surface that just went overdue is
   * visible even if everything after it is capped out. Harvest before dispatch, so
   * a slot freed by a finishing worker is reusable in the same pass rather than one
   * sweep later.
   */
  async sweep(): Promise<RefreshPassReport> {
    return this.entry(() => this.sweepNow())
  }

  private async sweepNow(): Promise<RefreshPassReport> {
    const report = emptyReport()
    await this.applyDeadlines(report)
    await this.harvest(report)
    await this.dispatch(report)
    return report
  }

  /**
   * Re-derive `dueAt` and `overdue` for every Surface, and raise a `periodic`
   * trigger for the ones whose deadline has just passed.
   *
   * `setSchedule` writes nothing when neither value moved, which is what keeps this
   * free: it runs over every Surface on every sweep, and the steady state is that
   * nothing changed.
   */
  private async applyDeadlines(report: RefreshPassReport): Promise<void> {
    const now = this.deps.now()
    const cfg = this.deps.config()
    for (const surface of this.deps.surfaces()) {
      if (surface.deleted || surface.home.kind === 'recovery' || surface.compatibilityOnly) continue
      const decl = effectiveDeclaration(surface)
      const dueAt = deriveDueAt(surface, decl, cfg.defaultIntervalMs)
      // OVERDUE IS NOT A PHASE (R18). Once raised it stays raised — this sweep can
      // only ever set it — and the ONLY thing that lowers it is a successful
      // barrier in `completeRefresh`. That is what stops a retry loop from making
      // an overdue Surface look attended to: entering queued or refreshing changes
      // nothing here.
      //
      // A Surface with NO deadline is not overdue, and that clause is the one
      // exception to "only a barrier lowers it": `overdue` means a deadline elapsed
      // unverified, so when the deadline itself goes away there is nothing left to
      // be past. The plan's own wording allows it — overdue "remains visible until a
      // successful barrier OR AN EXPLICIT POLICY CHANGE" — and without it an author
      // who drops `periodic` from a Surface leaves an amber badge nothing can ever
      // clear, because the only thing that clears it is the refresh they just
      // stopped asking for.
      const overdue = dueAt === undefined ? false : (surface.freshness.overdue || now >= dueAt)
      // An unchanged schedule is a SUCCESS, not a conflict — that is what
      // `setSchedule`'s short-circuit buys, and it is load-bearing on the first
      // sweep after a restart: a Surface that was ALREADY overdue when the process
      // died has nothing to change here, and treating that as a failure would skip
      // it on every sweep forever.
      const set = await this.deps.service.setSchedule(surface.id, { dueAt, overdue }, this.ctx(now))
      if (!set.ok) continue
      if (!overdue || dueAt === undefined) continue
      if (decl.policy === 'manual') continue
      // One periodic trigger per missed deadline. The dedupe lives on the REASON
      // KEY, which embeds the deadline — `markPossiblyStale` refuses a repeat of a
      // key it already holds, so a re-check here would be a second implementation
      // of the same rule.
      const marked = await this.deps.service.markPossiblyStale(surface.id, {
        kind: 'periodic',
        key: `periodic ${surface.id} ${dueAt}`,
        detail: 'its verification interval elapsed',
        at: now,
      }, this.ctx(now))
      if (!marked.ok) continue
      const after = this.surface(surface.id)
      if (!after) continue
      report.marked.push(after.id)
      if (decl.policy !== 'automatic') continue
      // A DEADLINE THAT CANNOT MOVE MUST NOT RETRY AT SWEEP CADENCE. `dueAt` is
      // derived from the last SUCCESSFUL verification on purpose (a failing loop may
      // not silence its own overdue badge), so a Surface whose recipe is broken
      // stays permanently past a deadline that never advances. Without this, every
      // sweep would schedule another job for it — a real background agent in the
      // user's worktree every few seconds, forever, for a recipe that cannot work.
      //
      // One interval of quiet after a failure, and no longer: the badge is
      // untouched, the reason is untouched, and the retry still happens — it just
      // happens on the cadence the Surface asked to be verified on rather than on
      // the cadence the host happens to sweep at.
      const failedAt = after.freshness.failure?.at
      if (failedAt !== undefined && now < failedAt + intervalFor(decl, cfg.defaultIntervalMs)) continue
      await this.scheduleFor(after, after.freshness.staleReason, report)
    }
  }

  /**
   * Consume finished workers and time out stuck ones.
   *
   * The barrier is here: staged result → re-observe every authoritative source →
   * hand the result to `completeRefresh`, which compares the revision and the
   * generation inside the durable transaction. Any disagreement is a supersession,
   * not a commit.
   */
  private async harvest(report: RefreshPassReport): Promise<void> {
    const cfg = this.deps.config()
    for (const job of this.deps.jobs.list()) {
      if (job.state !== 'running') continue
      const now = this.deps.now()
      const surface = this.surface(job.surfaceId)
      if (!surface) {
        await this.finishJob(job, 'cancelled', 'its Surface no longer exists', report)
        continue
      }

      // A SOURCE THAT VANISHED MID-FLIGHT ends the job now rather than at the
      // worker timeout. The result has nowhere to commit, so ten more minutes of a
      // managed session in the user's worktree buys a failure that is already
      // certain — and the Surface spends every one of those minutes badged
      // `refreshing`, which is the single most misleading state it can show.
      const gone = this.refreshBlocker(surface)
      if (gone?.permanent) {
        await this.failJob(job, gone.reason, report)
        continue
      }

      let staged: StagedRefreshResult | null = null
      try {
        staged = await this.deps.readStaged(job.stagingPath)
      } catch (err) {
        await this.failJob(job, `staged result could not be read: ${(err as Error).message}`, report)
        continue
      }

      if (!staged) {
        // A session that has VANISHED is finished whatever the clock says — waiting
        // out the timeout on a session that is already gone would leave the Surface
        // spinning for minutes with nothing behind it. Applies to an OWNER dispatch
        // as well as to a worker: an owner that exited mid-turn is exactly as
        // incapable of writing the result as a dead worker.
        const target = job.dispatch?.kind === 'blocked' ? undefined : job.dispatch?.target
        if (target && !this.deps.isLiveSession(target)) {
          await this.failJob(
            job,
            job.dispatch?.kind === 'owner'
              ? `its owner session (${target}) exited without writing a result`
              : 'its refresh worker exited without writing a result',
            report,
          )
          continue
        }
        if (job.dispatch && now - job.dispatch.at > cfg.workerTimeoutMs) {
          await this.failJob(job, `no result after ${Math.round(cfg.workerTimeoutMs / 1000)}s`, report)
        }
        continue
      }

      if (staged.error) {
        await this.failJob(job, staged.error.slice(0, 400), report)
        continue
      }

      // THE BARRIER. Re-observe before comparing: a source that changed while the
      // worker ran, whose watcher event has not arrived yet, is caught HERE and
      // nowhere else. Without this, a delayed event would let an already-stale
      // result claim current and the Surface would look verified until the next
      // trigger happened to arrive.
      try {
        await this.deps.observeSources(surface)
      } catch (err) {
        await this.failJob(job, `sources could not be re-observed: ${(err as Error).message}`, report)
        continue
      }
      const observed = this.surface(job.surfaceId)
      if (!observed) {
        await this.finishJob(job, 'cancelled', 'its Surface no longer exists', report)
        continue
      }

      // `expectedRev` is re-read on the line above and `completeRefresh` re-reads it
      // synchronously on entry, so on a single-threaded event loop the two can never
      // disagree — that guard is unreachable from here and is kept only for callers
      // that genuinely hold an older read. `expectedContentDigest` is the one that
      // bites: it is the baseline `begin` snapshotted, and comparing it is what stops
      // a concurrent edit being silently overwritten by this result.
      const live = this.deps.jobs.get(job.id) ?? job
      const completed = await this.deps.service.completeRefresh(observed.id, {
        jobId: job.id,
        expectedRev: observed.rev,
        observedGeneration: job.targetGeneration,
        ...(live.baseContentDigest ? { expectedContentDigest: live.baseContentDigest } : {}),
        ...(staged.content ? { content: staged.content } : {}),
      }, this.ctx(this.deps.now()))

      await this.deps.clearStaged(job.stagingPath).catch(() => { /* best effort */ })
      await this.retire(job)

      if (completed.ok) {
        this.deps.jobs.update(job.id, {
          state: 'completed',
          result: { ok: true, ...(staged.note ? { message: staged.note.slice(0, 400) } : {}) },
        }, this.deps.now())
        report.completed.push(job.id)
        continue
      }
      if (completed.error.reason === 'superseded') {
        this.deps.jobs.update(job.id, {
          state: 'superseded', result: { ok: false, message: completed.error.message },
        }, this.deps.now())
        report.superseded.push(job.id)
        // Exactly ONE successor, for the newest pending generation. The Surface is
        // back at possibly-stale and holds no active job, so this creates one.
        const pending = this.surface(job.surfaceId)
        if (pending && effectiveDeclaration(pending).policy === 'automatic') {
          await this.scheduleFor(pending, pending.freshness.staleReason, report)
        }
        continue
      }
      await this.failJob(job, completed.error.message, report)
    }
  }

  /**
   * Launch queued work, up to the cap.
   *
   * THE CAP IS THE FLEET BOUND. The plan's per-Surface rule ("only one job executes
   * per Surface") bounds nothing when a hundred Surfaces go stale at once, and every
   * managed session claims a ttyd port. Excess jobs stay `queued` and launch
   * NOTHING — they are not failed, not deferred to a timer, and not given a port
   * they might not get to use.
   */
  private async dispatch(report: RefreshPassReport): Promise<void> {
    const cfg = this.deps.config()
    // Oldest first: a job that has waited through several sweeps should not lose
    // its slot to one created this pass.
    const queued = this.deps.jobs.list()
      .filter(j => j.state === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)

    // WORKERS, not running jobs. See `SurfaceRefreshJobStore.runningWorkerCount`:
    // counting by state alone made an owner delivery consume a cap slot on every
    // sweep after the one that dispatched it, silently starving the background fleet.
    let running = this.deps.jobs.runningWorkerCount()
    for (const job of queued) {
      const now = this.deps.now()
      const surface = this.surface(job.surfaceId)
      if (!surface) {
        await this.finishJob(job, 'cancelled', 'its Surface no longer exists', report)
        continue
      }
      if (job.lease && job.lease.until > now && job.lease.owner !== COORDINATOR_PRINCIPAL.id) {
        // Someone else's live lease. Two workers must not complete one job.
        continue
      }
      // A QUEUED JOB THAT NO LONGER OWNS ITS SURFACE IS DEAD, and must be told so
      // rather than retried forever. `enqueueRefresh` stamped `freshness.jobId` with
      // this job's id when it was created, so a Surface naming a DIFFERENT job (or
      // none) has been taken over — by a racing scheduler, a second backend, or a
      // failure that cleared the stamp. Such a job can never `begin`: `beginRefresh`
      // requires phase `queued`, which will not recur while another job holds the
      // Surface, and nothing else ages a queued job out. Left alone it stays active
      // forever, and `scheduleFor` coalesces every later trigger onto it instead of
      // scheduling work that could actually run — so the Surface stops refreshing
      // entirely, manual button included.
      //
      // Deliberately NOT a blanket age-out on `queued`: a job held back by the
      // concurrency cap is queued for exactly the right reason and may sit there for
      // as long as the fleet is full. Ownership is the precise test.
      if (surface.freshness.jobId !== job.id) {
        await this.finishJob(
          job, 'cancelled',
          `another refresh (${surface.freshness.jobId ?? 'none'}) took this Surface over before this one started`,
          report,
        )
        continue
      }
      // Re-checked at dispatch, not just at scheduling: a source can vanish between
      // the two, and launching a worker for a Surface whose file went away in that
      // window is a managed session guaranteed to time out with nothing to write.
      const blocker = this.refreshBlocker(surface)
      if (blocker) {
        const blocked = blocker.reason
        this.deps.jobs.update(job.id, {
          state: 'failed',
          dispatch: { kind: 'blocked', reason: blocked, at: now },
          authorization: { ...job.authorization, blocked },
          result: { ok: false, message: blocked },
        }, now)
        await this.deps.service.failRefresh(job.surfaceId, { jobId: job.id, message: blocked }, this.ctx(now))
        report.blocked.push({ jobId: job.id, reason: blocked })
        continue
      }

      const prompt = this.deps.buildPrompt({ surface, job, stagingPath: job.stagingPath })

      // AN AVAILABLE OWNER RECEIVES WORK DIRECTLY (KTD11). This costs no port and
      // no session, so it is NOT counted against the cap — the cap bounds the
      // background fleet, which is what competes for ports.
      const owner = surface.owner?.kind === 'session' ? surface.owner.id : job.runId
      if (owner && this.deps.isLiveSession(owner)) {
        const began = await this.begin(job, surface)
        if (!began) continue
        const delivered = await this.deps.deliverToOwner({ sessionName: owner, prompt, job })
        this.deps.jobs.update(job.id, {
          dispatch: { kind: 'owner', target: owner, at: now },
          ...(delivered ? {} : { result: { ok: false, message: 'the owner session did not accept the work' } }),
        }, now)
        if (!delivered) {
          await this.failJob(this.deps.jobs.get(job.id)!, 'the owner session did not accept the work', report)
          continue
        }
        report.dispatched.push(job.id)
        continue
      }

      if (!cfg.autonomousWorkers) {
        // The kill switch. Nothing is launched and the job stays queued, so turning
        // it back on resumes exactly where it left off rather than losing the work.
        report.heldByCap.push(job.id)
        continue
      }
      if (running >= cfg.maxConcurrentWorkers) {
        report.heldByCap.push(job.id)
        continue
      }

      const began = await this.begin(job, surface)
      if (!began) continue
      const launch = await this.deps.launchWorker({ job, surface, prompt })
      if (!launch.ok) {
        await this.failJob(this.deps.jobs.get(job.id)!, launch.message, report)
        continue
      }
      this.deps.jobs.update(job.id, {
        dispatch: {
          kind: 'worker',
          target: launch.sessionName,
          ...(launch.incarnation ? { incarnation: launch.incarnation } : {}),
          at: now,
        },
      }, now)
      running++
      report.dispatched.push(job.id)
    }
  }

  /**
   * Take the Surface into `refreshing` and the job into `running`, under a lease.
   *
   * Returns false when the Surface refused — which is how two sweeps racing one
   * queued job resolve: the compare-and-swap in `beginRefresh` lets exactly one
   * through, and the loser leaves the job alone.
   */
  private async begin(job: SurfaceRefreshJob, surface: Surface): Promise<boolean> {
    const now = this.deps.now()
    const began = await this.deps.service.beginRefresh(
      surface.id, { jobId: job.id, expectedRev: surface.rev }, this.ctx(now),
    )
    if (!began.ok) {
      log.info('refresh', `job ${job.id} did not take ${surface.id}: ${began.error.message}`)
      return false
    }
    this.deps.jobs.update(job.id, {
      state: 'running',
      attempts: job.attempts + 1,
      baseRev: surface.rev,
      // Snapshotted HERE, and safe to take from the Surface we read rather than
      // re-reading: `beginRefresh` just compare-and-swapped on `surface.rev`, so if
      // it returned ok this content is exactly what the record holds. This is the
      // baseline the barrier compares against, and it is the only thing standing
      // between a worker's result and a concurrent edit it would otherwise silently
      // overwrite.
      baseContentDigest: surfaceContentDigest(surface.content),
      lease: { owner: COORDINATOR_PRINCIPAL.id, until: now + LEASE_MS },
    }, now)
    return true
  }

  private async retire(job: SurfaceRefreshJob): Promise<void> {
    if (job.dispatch?.kind !== 'worker' || !job.dispatch.target) return
    try {
      await this.deps.retireWorker(job.dispatch.target)
    } catch (err) {
      log.warn('refresh', `could not retire worker ${job.dispatch.target}: ${(err as Error).message}`)
    }
  }

  private async failJob(job: SurfaceRefreshJob, message: string, report: RefreshPassReport): Promise<void> {
    await this.retire(job)
    await this.deps.clearStaged(job.stagingPath).catch(() => { /* best effort */ })
    this.deps.jobs.update(job.id, { state: 'failed', result: { ok: false, message } }, this.deps.now())
    await this.deps.service.failRefresh(job.surfaceId, { jobId: job.id, message }, this.ctx(this.deps.now()))
    report.failed.push({ jobId: job.id, reason: message })
  }

  private async finishJob(
    job: SurfaceRefreshJob, state: 'cancelled' | 'completed', message: string, report: RefreshPassReport,
  ): Promise<void> {
    await this.retire(job)
    this.deps.jobs.update(job.id, { state, result: { ok: state === 'completed', message } }, this.deps.now())
    if (state === 'cancelled') report.failed.push({ jobId: job.id, reason: message })
  }

  // --- Restart -------------------------------------------------------------

  /**
   * Reconstruct in-flight work after a restart.
   *
   * WHAT THIS MAY NOT DO is the point: it may not declare anything current. A
   * `running` job whose worker survived the restart is adopted — but ONLY if the
   * session is genuinely LIVE and is still on the incarnation this job recorded,
   * because a session name is reusable and adopting a stranger that happens to
   * share it would attribute someone else's output to this job. Everything else is
   * failed with a reason, which leaves its Surface visibly failed rather than
   * quietly stale.
   *
   * BOTH HALVES OF THAT SENTENCE USED TO BE FALSE, which is why they are spelled
   * out. `isLiveSession` was a `readFileSync` of a session record that outlives its
   * tmux process, so a worker that died with the host was adopted and had its lease
   * renewed. And no incarnation was persisted at all — the launcher built one and
   * the wiring discarded it — so the match was on the NAME the docstring says is
   * not enough. A job that recorded no incarnation (written before this) falls back
   * to name plus liveness rather than being failed for the omission.
   *
   * `queued` jobs need no repair at all: they never launched anything, so the next
   * sweep dispatches them exactly as it would have.
   */
  async recover(): Promise<RefreshPassReport> {
    return this.entry(() => this.recoverNow())
  }

  private async recoverNow(): Promise<RefreshPassReport> {
    const report = emptyReport()
    for (const job of this.deps.jobs.list()) {
      if (!ACTIVE_JOB_STATES.includes(job.state)) continue
      const surface = this.surface(job.surfaceId)
      if (!surface) {
        await this.finishJob(job, 'cancelled', 'its Surface no longer exists', report)
        continue
      }
      if (job.state === 'queued') continue

      const dispatch = job.dispatch?.kind === 'worker' ? job.dispatch : undefined
      const target = dispatch?.target
      // A recorded incarnation must still match. Absent (an older job record) falls
      // back to liveness alone rather than failing work that is genuinely still
      // running for want of a field it never had.
      const sameIncarnation = !dispatch?.incarnation
        || dispatch.incarnation === this.deps.sessionIncarnation(dispatch.target ?? '')
      if (target && this.deps.isLiveSession(target) && sameIncarnation) {
        // A live matching incarnation. Renew the lease and leave it to the sweep,
        // which will harvest it through the same barrier as any other worker.
        this.deps.jobs.update(job.id, {
          lease: { owner: COORDINATOR_PRINCIPAL.id, until: this.deps.now() + LEASE_MS },
        }, this.deps.now())
        continue
      }
      await this.failJob(
        job,
        target
          ? sameIncarnation
            ? `its refresh worker (${target}) did not survive the restart`
            : `session ${target} is live but is a different incarnation than this refresh launched`
          : 'the host restarted while this refresh was in flight',
        report,
      )
    }
    return report
  }
}

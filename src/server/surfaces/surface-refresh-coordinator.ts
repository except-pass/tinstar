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
  Surface, SurfaceClaim, SurfaceContent, SurfacePrincipalRef, SurfaceRefreshDeclaration, SurfaceStaleReason,
} from '../../domain/types'
import { log } from '../logger'
import { serializeByKey } from '../sessions/backends/serializeByKey'
import {
  claimsWithoutStoredValue,
  surfaceContentDigest,
  type SurfaceCallContext,
  type SurfaceService,
  type WitnessObservationInput,
} from './surface-service'
import {
  ACTIVE_JOB_STATES,
  type SurfaceRefreshJob,
  type SurfaceRefreshJobStore,
} from './surface-refresh-jobs'
import {
  claimsObserveTriggerKind,
  coalesceGeneration,
  deriveDueAt,
  effectiveDeclaration,
  matchTrigger,
  MIN_INTERVAL_MS,
  type SurfaceTriggerEvent,
} from './surface-trigger-matcher'
import type { WitnessOutcome } from './witness-registry'

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
  /** Run ONE claim's witness and report what it saw (plan U4, R9).
   *
   *  Injected for the same reason `launchWorker` and `observeSources` are: it reaches
   *  a subprocess (`git fetch`) and the network, and the state machine that decides
   *  WHEN to check a claim has to be testable without either.
   *
   *  Must never reject — `runWitness` in the registry already guarantees that, and it
   *  matters here because a rejection would take down a pass that is looking at other
   *  Surfaces too. REQUIRED rather than optional: an optional effect dep is one a
   *  wiring can forget, and the symptom of forgetting this one is a fleet of cards
   *  that quietly never check themselves — the exact failure this plan exists to end,
   *  reintroduced as a missing key. */
  runWitness: (input: { surface: Surface; claim: SurfaceClaim }) => Promise<WitnessOutcome>
}

/** One Surface's claims, snapshotted at collect so the run outside the lock and the
 *  commit back inside it are talking about the same declaration. */
interface WitnessTask {
  surfaceId: string
  claims: SurfaceClaim[]
  /** Claim id → a stable rendering of its declaration, compared again at commit. */
  fingerprints: Record<string, string>
}

/** What has to be identical for a witness result to still be an answer about this
 *  claim. The id alone is not enough: an author who edits `params.url` has changed the
 *  question, and storing the old URL's status code against the new one would report a
 *  value that moved when nothing in the world did. `params` is already key-sorted by
 *  the parser, so this is stable against a formatter reordering the file. */
function claimFingerprint(claim: SurfaceClaim): string {
  return JSON.stringify([claim.witness, claim.locus, claim.params ?? null])
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
  /** Surfaces whose every claim was checked and held this pass — the cheap outcome,
   *  and the one the whole split exists to make common. No job, no session, no agent. */
  witnessed: string[]
  /** Claims whose stored value a completed lookup contradicted. */
  moved: { surfaceId: string; claimId: string }[]
  /** Claims whose witness ran and produced no value — nobody could look, or the claim
   *  itself is broken (KTD8). Reported because a Surface that never leaves this list
   *  is a Surface nothing is actually checking. */
  unresolved: { surfaceId: string; claimId: string }[]
}

function emptyReport(): RefreshPassReport {
  return {
    marked: [], queued: [], coalesced: [], dispatched: [], heldByCap: [],
    blocked: [], completed: [], superseded: [], failed: [],
    witnessed: [], moved: [], unresolved: [],
  }
}

/** The one serialization key every public entry point runs under. See
 *  {@link SurfaceRefreshCoordinator.entry}. */
const ENTRY_KEY = 'refresh-coordinator'

/**
 * How many claim-bearing Surfaces one witness pass may look at (KTD3).
 *
 * SIZED AGAINST THE SLOWEST KIND, not against the number of Surfaces. `unit-landed`
 * budgets 30s for a `git fetch` on a link the host does not control; at
 * {@link WITNESS_CONCURRENCY} of 4 a full pass is therefore two batches, bounded at a
 * minute of wall clock — and it holds no lock for any of it. A backlog of a hundred
 * Surfaces drains in thirteen passes, about a minute at the five-second sweep, which
 * is well inside the shortest verification interval an author may ask for
 * ({@link MIN_INTERVAL_MS}). Bigger buys nothing: the steady state is that almost
 * nothing is due.
 *
 * Deliberately NOT `maxConcurrentWorkers`, which the plan's open question offers as
 * the one-fewer-knob alternative. That number bounds managed sessions and the ttyd
 * ports they claim; this one bounds subprocesses and HTTP requests. Sharing them
 * would mean tightening the fleet cap silently throttled detection, and detection is
 * the half that is supposed to be generous.
 */
export const WITNESS_BUDGET_PER_PASS = 8

/** How many witnesses run at once inside a pass. Four, matching the shipped
 *  `maxConcurrentWorkers` default, so a sweep can never have more outstanding
 *  subprocesses than the fleet it is supposed to be cheaper than. */
export const WITNESS_CONCURRENCY = 4

/** The shortest gap between two looks at the same Surface, whatever else says it is
 *  due. Its job is to stop hammering, not to replace the deadline: the interval is
 *  what governs a healthy Surface's cadence, and this is what stops a trigger storm
 *  (or a Surface that can never be stamped, because a claim will not resolve) turning
 *  into a `git fetch` every five seconds. */
export const WITNESS_MIN_GAP_MS = MIN_INTERVAL_MS

/**
 * How many OWNER deliveries one dispatch pass may make (KTD9, R16).
 *
 * ITS OWN COUNTER, and the two obvious alternatives are both wrong.
 * `runningWorkerCount()` counts only `dispatch.kind === 'worker'` and every one of
 * the 175 jobs in the live table dispatched as `owner`, so moving the existing cap
 * check above the owner branch would gate against a constant zero. And counting owner
 * deliveries in the worker cap re-creates the documented starvation regression on
 * {@link SurfaceRefreshJobStore.runningWorkerCount}, where an owner delivery held a
 * fleet slot on every sweep after the one that dispatched it.
 *
 * PER PASS RATHER THAN CONCURRENT, because an owner delivery is a prompt — it is
 * finished the moment it lands, and there is nothing to still be holding. What was
 * unbounded was the burst: a commit fires every Surface bound to that worktree, and
 * ten Surfaces became ten prompts into one working session. Three per pass at the
 * five-second sweep drains that in four sweeps, without anybody's conversation being
 * buried.
 */
export const OWNER_DELIVERIES_PER_PASS = 3

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

  /** The most recent witness pass. Retained after it settles so a caller that starts
   *  a pass and then joins it gets THAT pass's report rather than an empty one. */
  private pass: Promise<RefreshPassReport> = Promise.resolve(emptyReport())

  /** True while a witness pass is between its collect and its last commit. One pass
   *  at a time, which is what bounds the number of outstanding subprocesses to
   *  {@link WITNESS_BUDGET_PER_PASS} across the whole process rather than per sweep. */
  private passing = false

  /** Surface id → the earliest instant it may be looked at again. In memory on
   *  purpose: it is a rate limit, not a fact about the world, and the cost of losing
   *  it in a restart is one extra look per Surface. Putting it on the record would
   *  mean a durable write every time the host DECIDED NOT to do something. */
  private readonly nextLookAt = new Map<string, number>()

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
    const report = await this.entry(() => this.noteNow(event))
    // THE SAME STEP BOTH ENTRY POINTS REACH (KTD3). A commit reaches `markPossiblyStale`
    // and then `scheduleFor` without ever touching the deadline pass — 115 of 175
    // measured jobs took that route — so a revalidation wired only to `applyDeadlines`
    // would leave the cheap check unreachable from the trigger that produces most of
    // the work. Started, not awaited: see {@link witnessPass}.
    this.startWitnessPass()
    return report
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
      // THE CHEAP CHECK GETS FIRST REFUSAL (R13). A Surface whose claims observe this
      // trigger's kind is not scheduled for a rebuild on the strength of the trigger
      // alone: the witness pass this call starts will ask whether anything the Surface
      // asserts actually moved, and a job is queued only if something did. That is the
      // whole split — 110 of 121 completed refreshes changed nothing, and each of them
      // was a background agent in the user's worktree.
      //
      // The Surface is left MARKED, which is what makes this safe to leave to a later
      // pass: `collectDueWitnesses` treats a possibly-stale Surface holding a reason
      // its claims observe as due, so a trigger that arrives while a pass is already
      // running is picked up by the next one rather than dropped.
      if (claimsObserveTriggerKind(after.content.claims, match.reason.kind)) continue
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
        ...(this.authorizationProblem(surface) ? { blocked: this.authorizationProblem(surface)! } : {}),
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
   */
  private authorizationProblem(surface: Surface): string | undefined {
    const bound = surface.source?.worktree
    const provenance = surface.provenance?.worktreeId
    if (bound && provenance && bound !== provenance) {
      return `this Surface names two worktrees (${bound} and ${provenance}); a refresh may not choose between them`
    }
    if (!bound && !provenance) return 'no worktree is recorded, so there is nowhere authorized to run a refresh'
    if (!surface.content.recipe) {
      return 'this Surface declares no refresh recipe, so nothing can rebuild it without a human'
    }
    return undefined
  }

  // --- The sweep -----------------------------------------------------------

  /**
   * One periodic pass: deadlines, then rebuild debts, then harvest, then dispatch.
   *
   * ORDER IS LOAD-BEARING. Deadlines first, so a Surface that just went overdue is
   * visible even if everything after it is capped out. Harvest before dispatch, so
   * a slot freed by a finishing worker is reusable in the same pass rather than one
   * sweep later. The rebuild drain sits with the deadlines because it is the other
   * thing that CREATES work, and putting it after harvest would make a debt recorded
   * this pass wait an extra sweep for its dispatch.
   *
   * RETURNS BEFORE ITS WITNESSES DO, and that is the point of the whole unit. Every
   * entry point here serializes on one key, so a `git fetch` awaited inside this call
   * would stall harvest, dispatch, and the manual refresh button behind network
   * latency — and would destroy the property that makes the every-Surface walk free.
   * The pass this starts holds no lock; join it with {@link witnessPass}.
   */
  async sweep(): Promise<RefreshPassReport> {
    const report = await this.entry(() => this.sweepNow())
    this.startWitnessPass()
    return report
  }

  private async sweepNow(): Promise<RefreshPassReport> {
    const report = emptyReport()
    await this.applyDeadlines(report)
    await this.drainRebuilds(report)
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
      const overdue = surface.freshness.overdue || (dueAt !== undefined && now >= dueAt)
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
      // A CLAIM-BEARING SURFACE ANSWERS ITS OWN DEADLINE (R13/R14). Its claims all
      // observe `periodic` — elapsed time can invalidate any observation whatever —
      // so the deadline that just passed is exactly the question a witness pass
      // answers, and answering it with a background agent instead would be paying
      // repair prices for detection. `collectDueWitnesses` picks this Surface up on
      // the pass the caller starts after the lock is released; only a value that
      // actually moved reaches `scheduleFor`, through `drainRebuilds`.
      if (surface.content.claims?.length) continue
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

  // --- The claim check -----------------------------------------------------

  /**
   * Queue the rebuild a moved claim value earned, for every Surface still carrying
   * that debt (R11/R12/R17).
   *
   * THE MARKER IS DRAINED HERE AND NOWHERE ELSE, which makes the restart case the
   * ORDINARY case rather than a rarely-exercised recovery path: the commit that
   * records a moved value queues nothing, so every rebuild this feature produces —
   * including the ones no crash was involved in — comes out of this loop. A path
   * taken only after a restart is a path that is broken after a restart.
   *
   * "EXACTLY ONE" is structural rather than counted: `jobs.active` holds at most one
   * job per Surface, so a Surface that already has one is skipped, and the marker
   * survives until `completeRefresh` retires it.
   *
   * THE RECIPE-LESS ARM IS LEFT INTACT DELIBERATELY (R12). `launchWorker` answers a
   * recipe-less Surface with "this Surface declares no refresh recipe", and
   * `authorizationProblem` turns that into a blocked job — so a rebuild dispatched
   * here with no instruction would land the Surface in `failed` and retry on every
   * deadline forever. Such a Surface keeps its delta and its stale badge and queues
   * nothing, which is the honest end of that road.
   */
  private async drainRebuilds(report: RefreshPassReport): Promise<void> {
    const now = this.deps.now()
    const cfg = this.deps.config()
    for (const surface of this.deps.surfaces()) {
      if (!surface.freshness.claimRebuild) continue
      if (surface.deleted || surface.home.kind === 'recovery' || surface.compatibilityOnly) continue
      if (!surface.content.recipe) continue
      if (this.deps.jobs.active(surface.id)) continue
      const decl = effectiveDeclaration(surface)
      if (decl.policy !== 'automatic') continue
      // The same cooldown `applyDeadlines` applies for the same reason: a Surface
      // whose rebuild is broken must retry on the cadence it asked to be verified on,
      // not on the cadence the host happens to sweep at.
      const failedAt = surface.freshness.failure?.at
      if (failedAt !== undefined && now < failedAt + intervalFor(decl, cfg.defaultIntervalMs)) continue
      await this.scheduleFor(surface, surface.freshness.staleReason, report)
    }
  }

  /**
   * Join the witness pass in flight, or the most recent one.
   *
   * WHY THIS IS A SEPARATE AWAIT and not just the tail of `sweep()`. The host's sweep
   * timer guards against overlap with a `sweeping` flag, so a `sweep()` that awaited
   * its own witnesses would stall the NEXT sweep's deadlines and dispatch behind a
   * `git fetch` — the lock would be free and the loop would be blocked anyway. Kept
   * out of the returned report for the same reason: the report describes what the
   * locked pass did, and a pass that has not finished cannot honestly be in it.
   *
   * Tests and shutdown are the callers. Production fires and forgets, which is safe
   * because every commit the pass makes goes through the same serialized entry point
   * as everything else.
   */
  witnessPass(): Promise<RefreshPassReport> {
    return this.pass
  }

  /** Start a pass unless one is already running. One at a time is what bounds the
   *  process to {@link WITNESS_BUDGET_PER_PASS} outstanding witnesses however many
   *  sweeps and triggers arrive while it runs. */
  private startWitnessPass(): void {
    if (this.passing) return
    this.passing = true
    this.pass = this.runWitnessPass()
      // NOBODY AWAITS THIS IN PRODUCTION — `index.ts` starts the sweep with `void` —
      // so a rejection escaping here would be an unhandled rejection on the process
      // rather than a failed refresh. Swallowed into an empty report, logged, and the
      // next sweep tries again: a pass that could not run has cost nothing durable.
      .catch(err => {
        log.warn('refresh', `witness pass failed: ${(err as Error).message}`)
        return emptyReport()
      })
      .finally(() => { this.passing = false })
  }

  /**
   * COLLECT inside the lock, RUN outside it, COMMIT one Surface at a time (KTD3).
   *
   * The only slow step is the middle one, and it holds nothing. Collect is a read of
   * the Surface list; each commit is one mutator call that re-checks what it is
   * committing against.
   */
  private async runWitnessPass(): Promise<RefreshPassReport> {
    const report = emptyReport()
    const tasks = await this.entry(async () => this.collectDueWitnesses())
    if (!tasks.length) return report

    // Bounded fan-out over one shared cursor: workers pull the next task rather than
    // being handed a pre-sliced share, so one Surface whose `git fetch` hangs to its
    // timeout does not idle the other three lanes.
    let cursor = 0
    const lanes = Array.from({ length: Math.min(WITNESS_CONCURRENCY, tasks.length) }, async () => {
      for (;;) {
        const task = tasks[cursor++]
        if (!task) return
        const results = await this.runClaims(task)
        await this.commitWitness(task, results, report)
      }
    })
    await Promise.all(lanes)
    return report
  }

  /**
   * Which Surfaces are due a look, and which claims to run for each.
   *
   * THREE WAYS TO BE DUE, in the order they matter:
   *
   *   · A claim with NO STORED VALUE (R8). Due immediately rather than an interval
   *     from now — a card asserting something the host has never checked is exactly
   *     the state this plan exists to end, and it is the whole reason U3's optional
   *     seeding seam in the reconciler could be deleted: the first look happens on
   *     the next sweep rather than inside the file-watcher's debounced epoch.
   *   · A TRIGGER the claims observe, still sitting on the record as the stale reason
   *     that put the Surface in `possibly-stale`. Reading it off the record rather
   *     than passing it down from `noteNow` is what makes a trigger that arrives
   *     while a pass is running survive to the next one.
   *   · The DEADLINE, counted from `witnessedAt` — the last time every claim held —
   *     and never from `verifiedAt`, which an author's file save moves (KTD7).
   */
  private collectDueWitnesses(): WitnessTask[] {
    const now = this.deps.now()
    const cfg = this.deps.config()
    const out: WitnessTask[] = []
    for (const surface of this.deps.surfaces()) {
      if (out.length >= WITNESS_BUDGET_PER_PASS) break
      if (surface.deleted || surface.home.kind === 'recovery' || surface.compatibilityOnly) continue
      const claims = surface.content.claims
      if (!claims?.length) continue
      // A rebuild already owns this Surface. Re-observing the world it is being
      // rebuilt against would at best duplicate what the barrier re-observes anyway,
      // and at worst record a move against content nobody has written yet.
      if (this.deps.jobs.active(surface.id)) continue
      const next = this.nextLookAt.get(surface.id)
      if (next !== undefined && now < next) continue
      if (!this.witnessDue(surface, now, cfg)) continue
      out.push({
        surfaceId: surface.id,
        claims: claims.map(c => ({ ...c })),
        // Identity, not equality: the author may edit the declaration while the
        // witnesses run, and a result computed from the OLD parameters must not be
        // stored against the new claim. Compared again at commit.
        fingerprints: Object.fromEntries(claims.map(c => [c.id, claimFingerprint(c)])),
      })
    }
    return out
  }

  private witnessDue(surface: Surface, now: number, cfg: RefreshCoordinatorConfig): boolean {
    if (claimsWithoutStoredValue(surface).length > 0) return true
    const reason = surface.freshness.staleReason
    if (
      surface.freshness.phase === 'possibly-stale'
      && reason && claimsObserveTriggerKind(surface.content.claims, reason.kind)
    ) return true
    const witnessedAt = surface.freshness.witnessedAt
    if (witnessedAt === undefined) return true
    return now >= witnessedAt + intervalFor(effectiveDeclaration(surface), cfg.defaultIntervalMs)
  }

  /** Run every claim on one Surface, outside the lock. Sequential within a Surface:
   *  its claims are few, and a card's own witnesses competing with each other buys
   *  nothing while making the fan-out bound above meaningless. */
  private async runClaims(task: WitnessTask): Promise<WitnessObservationInput[]> {
    const surface = this.surface(task.surfaceId)
    if (!surface) return []
    const out: WitnessObservationInput[] = []
    for (const claim of task.claims) {
      let outcome: WitnessOutcome
      try {
        outcome = await this.deps.runWitness({ surface, claim })
      } catch (err) {
        // The registry's runner never rejects. A wiring that does must not take down
        // the pass — and must not be recorded as a value either.
        outcome = { status: 'unresolved', detail: `the witness runner threw: ${(err as Error).message}` }
      }
      out.push({ claimId: claim.id, outcome })
    }
    return out
  }

  /**
   * Commit one Surface's results, under the lock, after re-checking what they are
   * about.
   *
   * TWO THINGS ARE RE-CHECKED and both have a failure they prevent. The Surface may
   * have been DELETED while its witnesses ran, and a mutator called on it would
   * either fail noisily or resurrect state on a record nobody expects to move. And
   * its claims may have been EDITED, in which case an outcome computed from the old
   * parameters is an answer to a question nobody is asking any more — storing it
   * would let a claim's value change without the world changing at all.
   */
  private async commitWitness(
    task: WitnessTask, results: readonly WitnessObservationInput[], report: RefreshPassReport,
  ): Promise<void> {
    if (!results.length) return
    await this.entry(async () => {
      const now = this.deps.now()
      const surface = this.surface(task.surfaceId)
      if (!surface || surface.deleted) return
      const live = surface.content.claims ?? []
      const observations = results.filter(r => {
        const claim = live.find(c => c.id === r.claimId)
        return !!claim && claimFingerprint(claim) === task.fingerprints[r.claimId]
      })
      if (!observations.length) return

      const recorded = await this.deps.service.recordWitnessResult(
        surface.id, { observations }, this.ctx(now),
      )
      if (!recorded.ok) {
        log.info('refresh', `could not record a witness result for ${surface.id}: ${recorded.error.message}`)
        return
      }
      const after = this.surface(surface.id)
      if (!after) return

      const problems = observations.filter(o => o.outcome.status !== 'value')
      for (const problem of problems) {
        report.unresolved.push({ surfaceId: surface.id, claimId: problem.claimId })
      }
      const rebuild = after.freshness.claimRebuild
      const movedNow = rebuild?.at === now ? rebuild.moves : []
      for (const move of movedNow) report.moved.push({ surfaceId: surface.id, claimId: move.claimId })
      if (after.freshness.witnessedAt === now && !movedNow.length) report.witnessed.push(surface.id)

      // WHEN THIS SURFACE MAY BE LOOKED AT AGAIN. A pass that produced no verification
      // leaves the Surface due by every test above — `witnessedAt` did not move — so
      // without a cooldown a claim nobody can resolve would be a `git fetch` on every
      // five-second sweep, forever. One verification interval of quiet after a problem
      // or a move is the same rule `applyDeadlines` already applies to a failed
      // rebuild; a first look (which can never match, so can never stamp) gets only
      // the minimum gap, or a newly authored card would wait a full interval for the
      // second look that is allowed to verify it.
      const interval = intervalFor(effectiveDeclaration(after), this.deps.config().defaultIntervalMs)
      const quiet = problems.length || movedNow.length ? interval : WITNESS_MIN_GAP_MS
      this.nextLookAt.set(surface.id, now + quiet)
    })
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
    // And the OTHER half of that, which the narrowing left unbounded (KTD9, R16). See
    // `OWNER_DELIVERIES_PER_PASS`: this counter is per pass and separate on purpose,
    // and `runningWorkerCount` stays worker-only.
    let ownerDeliveries = 0
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
      const blocked = this.authorizationProblem(surface)
      if (blocked) {
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
      // no session, so it is NOT counted against the WORKER cap — that cap bounds the
      // background fleet, which is what competes for ports. It is counted against its
      // own budget, because what it does cost is a prompt in somebody's live
      // conversation, and ten Surfaces bound to one worktree became ten prompts into
      // one working session on a single commit.
      const owner = surface.owner?.kind === 'session' ? surface.owner.id : job.runId
      if (owner && this.deps.isLiveSession(owner)) {
        if (ownerDeliveries >= OWNER_DELIVERIES_PER_PASS) {
          // Held, not failed and not transferred to a worker: the owner is alive and
          // is still the right recipient, the queue is durable, and the next sweep is
          // five seconds away.
          report.heldByCap.push(job.id)
          continue
        }
        const began = await this.begin(job, surface)
        if (!began) continue
        ownerDeliveries++
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

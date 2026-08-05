// The durable refresh engine (R13-R18, KTD10).
//
// WHAT THIS OWNS: turning typed triggers into durable jobs, deciding which of those
// jobs may run right now, dispatching them, and — the part that matters most —
// refusing to call a Surface current unless the host has just re-observed its
// sources and found nothing newer than the result it is about to commit.
//
// WHAT IT MAY NOT DO (plan U1, KTD3). It cannot create a managed session, a tmux
// pane, or a terminal port, and there is no dependency it could reach one through:
// `launchWorker`/`retireWorker` are gone from {@link RefreshCoordinatorDeps}, so a
// coordinator constructed with ANY deps object — the real wiring or a test double —
// structurally has no such capability. The one recipient of work is a foreground
// session that already exists, reached through `deliverToOwner`. When there is no
// live owner, that is the answer: the Surface keeps its last-known content and
// records that a fresh result could not be obtained (R13/R17). It is never a reason
// to make one.
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

/** An executor's staged output, after the caller has validated it. */
export interface StagedRefreshResult {
  /** Authored content the executor produced. Absent means "I looked and nothing
   *  needed to change" — a legitimate outcome that must still complete the job
   *  explicitly rather than leave a spinner running (R17). */
  content?: SurfaceContent
  /** Free text the executor wrote about what it did, for the failure path. */
  note?: string
  /** Present when the executor reports it could NOT do the job. */
  error?: string
}

export interface RefreshCoordinatorConfig {
  /** Wall-clock bound on one refresh attempt before its job is failed. A timeout
   *  records a failed check and creates no successor (R18). */
  attemptTimeoutMs: number
  /** Verification interval for a Surface that asked for one without saying how long. */
  defaultIntervalMs: number
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
   *  record: a session file outlives the tmux process it describes.
   *
   *  THE ONLY QUESTION THE HOST ASKS ABOUT SESSIONS. There is deliberately no
   *  dependency here that could create, adopt, or retire one (plan U1, KTD3). */
  isLiveSession: (name: string) => boolean
  /** Read a staged artifact, or null when the executor has not written one yet. */
  readStaged: (path: string) => Promise<StagedRefreshResult | null>
  /** Discard a consumed staging artifact. Best-effort. */
  clearStaged: (path: string) => Promise<void>
  /** THE BARRIER's first half: directly re-observe every authoritative source for
   *  this Surface, advancing any generation that changed. Must complete before a
   *  result may claim current. */
  observeSources: (surface: Surface) => Promise<void>
  /** Build the self-contained instruction the foreground owner receives. */
  buildPrompt: (input: { surface: Surface; job: SurfaceRefreshJob; stagingPath: string }) => string
  /** Run ONE claim's witness and report what it saw (plan U4, R9).
   *
   *  Injected for the same reason `observeSources` is: it reaches a subprocess
   *  (`git fetch`) and the network, and the state machine that decides WHEN to check
   *  a claim has to be testable without either.
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
 *  than one sweep and shorter than an attempt timeout, so a coordinator that died
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
 */
export const WITNESS_BUDGET_PER_PASS = 8

/** How many witnesses run at once inside a pass. Four: enough that one slow
 *  `git fetch` does not idle the pass, few enough that a sweep cannot put more
 *  outstanding subprocesses on the box than a person would expect from a dashboard
 *  that is supposed to be idle. */
export const WITNESS_CONCURRENCY = 4

/** The shortest gap between two looks at the same Surface, whatever else says it is
 *  due. Its job is to stop hammering, not to replace the deadline: the interval is
 *  what governs a healthy Surface's cadence, and this is what stops a trigger storm
 *  (or a Surface that can never be stamped, because a claim will not resolve) turning
 *  into a `git fetch` every five seconds. */
export const WITNESS_MIN_GAP_MS = MIN_INTERVAL_MS

/**
 * How many OWNER deliveries one dispatch pass may make (R16).
 *
 * PER PASS RATHER THAN CONCURRENT, because an owner delivery is a prompt — it is
 * finished the moment it lands, and there is nothing to still be holding. What was
 * unbounded was the burst: a commit fires every Surface bound to that worktree, and
 * ten Surfaces became ten prompts into one working session. Three per pass at the
 * five-second sweep drains that without anybody's conversation being buried.
 *
 * A BACKSTOP RATHER THAN THE POLICY, now that agent recipes run only on discrete
 * human intent (R11/R12): the burst this bounds should no longer be reachable, and a
 * pass that ever hits this cap is evidence that something is dispatching agent work
 * the human did not ask for.
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
    // A HOST RECIPE IS NOT THIS EXECUTOR'S WORK (R6/R9, KTD2). It is machine work
    // with its own executor and its own budgets; queueing it here would hand it to
    // the one dispatcher there is, which delivers prompts to a live foreground agent
    // — the exact opposite of "machine-only". Left DIRTY instead, which is what R9
    // asks for: a trigger may mark anything dirty, and only the parsed recipe kind
    // decides what may then execute.
    //
    // A recipe-LESS or UNREADABLE Surface deliberately does NOT return here: it falls
    // through to the blocker path below, which records WHY on the Surface where a
    // reader can see it. "Nothing happened and nobody said why" is the state this
    // whole plan exists to end.
    if (surface.content.recipe?.kind === 'host') return undefined

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
    const recipe = surface.content.recipe
    if (!recipe) {
      return {
        reason: 'this Surface declares no refresh recipe, so nothing can rebuild it without a human',
        permanent: false,
      }
    }
    // AN UNREADABLE RECIPE FAILS TOWARD THE HUMAN AND STOPS (KTD1). The host will not
    // guess what the author meant, and it will not fall back to running the text as
    // an instruction — that guess is the authority leak the closed union exists to
    // close. Reported so the author can see what was wrong instead of watching a
    // Surface quietly never refresh.
    if (recipe.kind === 'unreadable') {
      return { reason: `its refresh recipe cannot be read: ${recipe.detail}`, permanent: false }
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

      // A SOURCE THAT VANISHED MID-FLIGHT ends the job now rather than at the
      // attempt timeout. The result has nowhere to commit, so ten more minutes of
      // waiting buys a failure that is already certain — and the Surface spends every
      // one of those minutes badged `refreshing`, which is the single most misleading
      // state it can show.
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
        // AN OWNER THAT HAS VANISHED is finished whatever the clock says — waiting
        // out the timeout on a session that is already gone would leave the Surface
        // spinning for minutes with nothing behind it. An owner that exited mid-turn
        // is exactly as incapable of writing the result as one that never started.
        const target = job.dispatch?.kind === 'owner' ? job.dispatch.target : undefined
        if (target && !this.deps.isLiveSession(target)) {
          await this.failJob(job, `its foreground agent (${target}) exited without writing a result`, report)
          continue
        }
        // THE TIMEOUT CREATES NO SUCCESSOR (R18). It records a failed check and
        // stops; the Surface goes back to waiting for its next allowed opportunity,
        // which for an agent recipe means the next discrete human action.
        if (job.dispatch && now - job.dispatch.at > cfg.attemptTimeoutMs) {
          await this.failJob(job, `no result after ${Math.round(cfg.attemptTimeoutMs / 1000)}s`, report)
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
   * Hand queued work to the one recipient that exists: a live foreground owner.
   *
   * THERE IS NO SECOND BRANCH (plan U1, KTD3). This loop used to end with "…and if
   * no owner is available, launch a background managed session", and that fallback
   * is what turned a trigger fan-out into a fleet of tmux panes. A queued job whose
   * owner is not live now ends here as an `unavailable` outcome: the Surface keeps
   * its last-known content, records that a fresh result could not be obtained, and
   * waits for the next allowed opportunity (R13/R17/R18).
   */
  private async dispatch(report: RefreshPassReport): Promise<void> {
    // Oldest first: a job that has waited through several sweeps should not lose
    // its turn to one created this pass.
    const queued = this.deps.jobs.list()
      .filter(j => j.state === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)

    // See `OWNER_DELIVERIES_PER_PASS`. Per pass rather than concurrent: a delivery
    // is finished the moment it lands, so there is nothing left to hold a slot.
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

      // THE ONE RECIPIENT. A foreground session the human is already talking to,
      // which costs no port and no new process. It is bounded by its own per-pass
      // budget because what it DOES cost is a prompt in somebody's live conversation.
      const owner = surface.owner?.kind === 'session' ? surface.owner.id : job.runId
      if (!owner || !this.deps.isLiveSession(owner)) {
        // NO FALLBACK LIVES HERE (R13). Recording the honest outcome is the whole
        // behaviour: the Surface keeps its last-known content, says a fresh result
        // could not be obtained, and waits for its next allowed opportunity. There is
        // no background executor to promote this to, and adding one back would
        // restore the exact architecture this unit removed.
        await this.failJob(
          job,
          owner
            ? `its foreground agent (${owner}) is not running, so nobody could rebuild it`
            : 'no foreground agent owns this Surface, so nobody could rebuild it',
          report,
        )
        continue
      }
      if (ownerDeliveries >= OWNER_DELIVERIES_PER_PASS) {
        // Held, not failed: the owner is alive and is still the right recipient, the
        // queue is durable, and the next sweep is five seconds away.
        report.heldByCap.push(job.id)
        continue
      }
      const prompt = this.deps.buildPrompt({ surface, job, stagingPath: job.stagingPath })
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

  private async failJob(job: SurfaceRefreshJob, message: string, report: RefreshPassReport): Promise<void> {
    await this.deps.clearStaged(job.stagingPath).catch(() => { /* best effort */ })
    this.deps.jobs.update(job.id, { state: 'failed', result: { ok: false, message } }, this.deps.now())
    await this.deps.service.failRefresh(job.surfaceId, { jobId: job.id, message }, this.ctx(this.deps.now()))
    report.failed.push({ jobId: job.id, reason: message })
  }

  private async finishJob(
    job: SurfaceRefreshJob, state: 'cancelled' | 'completed', message: string, report: RefreshPassReport,
  ): Promise<void> {
    this.deps.jobs.update(job.id, { state, result: { ok: state === 'completed', message } }, this.deps.now())
    if (state === 'cancelled') report.failed.push({ jobId: job.id, reason: message })
  }

  // --- Restart -------------------------------------------------------------

  /**
   * Reconstruct in-flight work after a restart.
   *
   * NOTHING IS ADOPTED (plan U1, KTD8). A delivered owner prompt may outlive the
   * server, and the host has no way to tell "the agent is still working on it" from
   * "the agent read it, moved on, and will never write the staging file". So a
   * `running` attempt is FAILED as unavailable rather than adopted: its Surface keeps
   * its content, shows an honest failed check, and waits for a new discrete human
   * action. That is strictly better than a spinner nobody will ever clear.
   *
   * This used to adopt a live background worker whose incarnation still matched. With
   * no background executor left there is nothing to adopt, and the incarnation match
   * that made adoption safe went with it.
   *
   * `queued` jobs need no repair at all: they never dispatched anything, so the next
   * sweep handles them exactly as it would have.
   */
  async recover(): Promise<RefreshPassReport> {
    return this.entry(() => this.recoverNow())
  }

  private async recoverNow(): Promise<RefreshPassReport> {
    const report = emptyReport()
    await this.reconcileLegacyJobs(report)
    for (const job of this.deps.jobs.list()) {
      if (!ACTIVE_JOB_STATES.includes(job.state)) continue
      const surface = this.surface(job.surfaceId)
      if (!surface) {
        await this.finishJob(job, 'cancelled', 'its Surface no longer exists', report)
        continue
      }
      if (job.state === 'queued') continue
      const target = job.dispatch?.kind === 'owner' ? job.dispatch.target : undefined
      await this.failJob(
        job,
        target
          ? `the host restarted while ${target} was rebuilding this; ask for it again when you need it fresh`
          : 'the host restarted while this refresh was in flight',
        report,
      )
    }
    return report
  }

  /**
   * Settle the Surfaces whose jobs the store terminalized at hydration (KTD8).
   *
   * The store can only fix its own table. These Surfaces were left holding an active
   * job that named a background session which no longer exists, so without this they
   * would sit `refreshing` forever — and `scheduleFor` would coalesce every later
   * trigger onto the dead job rather than doing anything.
   *
   * FAIL THEN RE-DIRTY, in that order and both deliberately. The failure is what
   * records WHY the content stopped advancing, and the re-dirty is what makes the
   * Surface eligible again — for a host recipe on its next allowed pass, or for the
   * next human who navigates to it. Neither mutator touches content: the last-known
   * result stays exactly where it was (R17).
   */
  private async reconcileLegacyJobs(report: RefreshPassReport): Promise<void> {
    for (const entry of this.deps.jobs.takeLegacyReconciliations()) {
      const surface = this.surface(entry.surfaceId)
      if (!surface) continue
      const at = this.deps.now()
      await this.deps.service.failRefresh(
        entry.surfaceId, { jobId: entry.jobId, message: entry.message }, this.ctx(at),
      )
      // Keyed on the JOB, so a table that somehow presented the same reconciliation
      // twice commits the dirty mark once.
      await this.deps.service.markPossiblyStale(entry.surfaceId, {
        kind: 'human-intent',
        key: `legacy-refresh-reconciled ${entry.jobId}`,
        detail: 'the refresh that was rebuilding it was retired with the background-worker architecture',
        at,
      }, this.ctx(at))
      report.failed.push({ jobId: entry.jobId, reason: entry.message })
    }
  }
}

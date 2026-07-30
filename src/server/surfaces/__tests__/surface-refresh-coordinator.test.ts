// @vitest-environment node
//
// The durable refresh engine's state machine (plan U6, R13-R18, KTD10/KTD11).
//
// Runs the REAL `SurfaceService` against a real in-memory `DocumentStore` and a
// real `SurfaceRefreshJobStore` (with an in-memory filesystem), so the freshness
// transitions, the compare-and-swap, and the barrier are the shipped ones. Only
// what leaves the process — session launching, prompt delivery, staged reads,
// source re-observation — is stubbed, and the clock is injected so the tests are
// not time-dependent.
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../../stores/document-store'
import { SurfaceService, type SurfaceCallContext } from '../surface-service'
import { SurfaceRefreshJobStore, type JobStoreIo, type SurfaceRefreshJob } from '../surface-refresh-jobs'
import {
  OWNER_DELIVERIES_PER_PASS,
  SurfaceRefreshCoordinator,
  WITNESS_BUDGET_PER_PASS,
  type RefreshCoordinatorConfig,
  type RefreshCoordinatorDeps,
  type WorkerLaunch,
} from '../surface-refresh-coordinator'
import { parseStagedResult } from '../refresh-wiring'
import type {
  Surface, SurfaceClaim, SurfaceClaimValue, SurfaceFreshness, SurfaceRefreshDeclaration,
} from '../../../domain/types'
import type { SurfaceTriggerEvent } from '../surface-trigger-matcher'
import type { WitnessOutcome } from '../witness-registry'

const SPACE = 'spc-a'
const WORKTREE = '/tmp/wt/alpha'
const RUN = 'run-a'

function memoryIo(): JobStoreIo {
  const files = new Map<string, string>()
  return {
    read: p => files.get(p) ?? null,
    write: (p, d) => { files.set(p, d) },
    mkdir: () => { /* nothing to make in memory */ },
  }
}

interface Harness {
  docStore: DocumentStore
  svc: SurfaceService
  jobs: SurfaceRefreshJobStore
  coord: SurfaceRefreshCoordinator
  clock: { now: number }
  cfg: RefreshCoordinatorConfig
  live: Set<string>
  /** Session name → its current incarnation, as the real wiring reads it off the
   *  session record. Only populated for sessions a launch actually minted. */
  incarnations: Map<string, string>
  /** Staging path → the RAW BYTES a worker wrote. Deliberately not a
   *  `StagedRefreshResult`: every result a test stages must be a thing the real
   *  worker contract can actually produce, and it reaches the barrier through the
   *  real `parseStagedResult`. Hand-writing the parsed shape is how the barrier's
   *  happy-path test came to stage a `recipe` no worker can emit, which is what hid
   *  a refresh deleting the recipe from every Surface it touched. */
  staged: Map<string, string>
  hidden: Set<string>
  launches: string[]
  retired: string[]
  delivered: { sessionName: string; prompt: string }[]
  launchOutcome: (job: SurfaceRefreshJob) => WorkerLaunch
  observe: (surface: Surface) => Promise<void>
  /** What a claim's witness reports. Stubbed because it is what LEAVES THE PROCESS —
   *  a `git fetch` and an HTTP request — exactly like `launchWorker` and `readStaged`
   *  beside it. The three-valued outcome is the registry's own shape, so a test can
   *  express "nobody could look" as something other than a value. */
  witness: (input: { surface: Surface; claim: SurfaceClaim }) => Promise<WitnessOutcome> | WitnessOutcome
  /** Every witness the coordinator actually ran, in order. */
  witnessRuns: { surfaceId: string; claimId: string }[]
  seed(over?: Partial<Surface>): Promise<Surface>
  get(id: string): Surface
  jobFor(id: string): SurfaceRefreshJob | undefined
}

function ctx(at: number): SurfaceCallContext {
  return { actor: { kind: 'job', id: 'test' }, at }
}

function harness(over: Partial<RefreshCoordinatorConfig> = {}): Harness {
  const docStore = new DocumentStore()
  const svc = new SurfaceService(docStore)
  const io = memoryIo()
  const jobs = SurfaceRefreshJobStore.open('/cfg', io)
  const clock = { now: 10_000 }
  const cfg: RefreshCoordinatorConfig = {
    maxConcurrentWorkers: 2,
    workerTimeoutMs: 60_000,
    defaultIntervalMs: 10 * 60_000,
    autonomousWorkers: true,
    ...over,
  }
  const h: Partial<Harness> = {
    docStore, svc, jobs, clock, cfg,
    live: new Set<string>(),
    incarnations: new Map<string, string>(),
    staged: new Map<string, string>(),
    hidden: new Set<string>(),
    launches: [],
    retired: [],
    delivered: [],
    launchOutcome: (job) => ({ ok: true, sessionName: `refresh-${job.id}`, incarnation: `conv-${job.id}` }),
    observe: async () => { /* the default barrier finds nothing new */ },
    witnessRuns: [],
    // Unresolved by default, which is the safe default for the same reason KTD8 makes
    // it an outcome: a test that forgot to configure a witness must not accidentally
    // stamp a Surface verified.
    witness: () => ({ status: 'unresolved', detail: 'no witness configured for this test' }),
  }
  let n = 0
  const deps: RefreshCoordinatorDeps = {
    service: svc,
    jobs,
    // `hidden` stands in for a Surface that was deleted out from under a job —
    // `loadSurfaces` merges rather than replaces, so removal is expressed here.
    surfaces: () => docStore.getAllSurfaces().filter(s => !h.hidden!.has(s.id)),
    config: () => h.cfg!,
    now: () => clock.now,
    newJobId: () => `job-${++n}`,
    deliverToOwner: async ({ sessionName, prompt }) => {
      h.delivered!.push({ sessionName, prompt })
      return h.live!.has(sessionName)
    },
    isLiveSession: name => h.live!.has(name),
    sessionIncarnation: name => h.incarnations!.get(name),
    launchWorker: async ({ job }) => {
      const outcome = h.launchOutcome!(job)
      if (outcome.ok) {
        h.launches!.push(outcome.sessionName)
        h.live!.add(outcome.sessionName)
        if (outcome.incarnation) h.incarnations!.set(outcome.sessionName, outcome.incarnation)
      }
      return outcome
    },
    retireWorker: async name => { h.retired!.push(name); h.live!.delete(name) },
    // THROUGH THE REAL PARSER. `parseStagedResult` is the only thing that turns
    // worker bytes into a `StagedRefreshResult` in production, so it is the only
    // thing allowed to do it here: a test that hands the barrier a shape the parser
    // cannot emit is testing a contract nothing upstream can satisfy.
    readStaged: async path => {
      const raw = h.staged!.get(path)
      return raw === undefined ? null : parseStagedResult(raw)
    },
    clearStaged: async path => { h.staged!.delete(path) },
    observeSources: s => h.observe!(s),
    runWitness: async ({ surface, claim }) => {
      h.witnessRuns!.push({ surfaceId: surface.id, claimId: claim.id })
      return h.witness!({ surface, claim })
    },
    buildPrompt: ({ surface, stagingPath }) =>
      `${surface.content.recipe ?? 'regenerate'}\nWrite the result to ${stagingPath}`,
  }
  h.coord = new SurfaceRefreshCoordinator(deps)
  h.seed = async (surfaceOver: Partial<Surface> = {}) => {
    const surface: Surface = {
      id: 'sf-1',
      spaceId: SPACE,
      home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'Coverage', recipe: 'Re-run coverage.' },
      contentAuthority: 'canonical-direct',
      author: 'agent',
      provenance: { runId: RUN, worktreeId: WORKTREE },
      source: { adapter: 'slate-file', locator: 'file:cov.json#cov', worktree: WORKTREE, generation: 1 },
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'current', overdue: false, observedGeneration: 1, verifiedAt: 5_000 },
      rev: 1,
      homeRev: 1,
      createdAt: 1_000,
      amendedAt: 5_000,
      ...surfaceOver,
    }
    docStore.loadSurfaces([...docStore.getAllSurfaces().filter(s => s.id !== surface.id), surface])
    return surface
  }
  h.get = id => {
    const s = docStore.getSurface(id)
    if (!s) throw new Error(`no Surface ${id}`)
    return s
  }
  h.jobFor = id => jobs.list().find(j => j.surfaceId === id)
  return h as Harness
}

/** The bytes a worker writes to its staging path. Only the three shapes
 *  `refreshBriefText` actually asks for — `{headline,content?,note?}`,
 *  `{note}`, `{error}` — because that is the whole contract a worker has. */
function workerJson(result: {
  headline?: string
  content?: unknown
  note?: string
  error?: string
}): string {
  return JSON.stringify(result)
}

function gitEvent(over: Partial<SurfaceTriggerEvent> = {}): SurfaceTriggerEvent {
  return { kind: 'git-revision', sourceId: WORKTREE, worktree: WORKTREE, evidence: 'sha-1', at: 20_000, ...over }
}

const AUTOMATIC: SurfaceRefreshDeclaration = { policy: 'automatic', triggers: ['git-revision'] }
const MARK_STALE: SurfaceRefreshDeclaration = { policy: 'mark-stale', triggers: ['git-revision'] }
const MANUAL: SurfaceRefreshDeclaration = { policy: 'manual', triggers: ['git-revision'] }

function withPolicy(decl: SurfaceRefreshDeclaration): Partial<Surface> {
  return { content: { headline: 'Coverage', recipe: 'Re-run coverage.', refreshPolicy: decl } }
}

// --- Claims (plan U4) -------------------------------------------------------

const REPO_CLAIM: SurfaceClaim = {
  id: 'u4', witness: 'unit-landed', locus: 'repo',
  params: { plan: 'docs/plans/2026-07-29-001-plan.md', unit: 'U4' },
}
const INFRA_CLAIM: SurfaceClaim = {
  id: 'up', witness: 'http-status', locus: 'infra', params: { url: 'https://tinstar.test/health' },
}

const sawValue = (value: SurfaceClaimValue): WitnessOutcome => ({ status: 'value', value })

/**
 * A Surface that declares claims.
 *
 * `recipe: null` is spelled out rather than omitted, because whether a Surface has one
 * is the entire difference between R11's rebuild and R12's record-the-delta-and-stop —
 * a test that meant to drop it and merely forgot to pass it would be indistinguishable.
 */
function claiming(over: {
  id?: string
  claims?: SurfaceClaim[]
  recipe?: string | null
  /** Values the host has ALREADY observed. A claim with none has never been looked at,
   *  which is a different due-ness (R8) and a different match outcome. */
  stored?: Record<string, SurfaceClaimValue>
  freshness?: Partial<SurfaceFreshness>
} = {}): Partial<Surface> {
  const recipe = over.recipe === null ? undefined : over.recipe ?? 'Re-derive the roadmap.'
  const observations = over.stored
    ? Object.fromEntries(Object.entries(over.stored).map(([id, value]) => [id, { value, at: 5_000 }]))
    : undefined
  return {
    ...(over.id ? { id: over.id } : {}),
    content: {
      headline: 'Roadmap',
      ...(recipe ? { recipe } : {}),
      claims: over.claims ?? [REPO_CLAIM],
    },
    freshness: {
      phase: 'current',
      overdue: false,
      observedGeneration: 1,
      verifiedAt: 5_000,
      ...(observations ? { claimObservations: observations } : {}),
      ...over.freshness,
    },
  }
}

describe('triggers → possibly stale', () => {
  it('records the reason, its evidence, and the advanced host generation', async () => {
    // MARK_STALE, so the assertion is about MARKING and not about the scheduling
    // that immediately follows it under an automatic policy.
    const h = harness()
    await h.seed(withPolicy(MARK_STALE))
    await h.coord.note(gitEvent())
    const s = h.get('sf-1')
    expect(s.freshness.phase).toBe('possibly-stale')
    expect(s.freshness.staleReason?.kind).toBe('git-revision')
    expect(s.freshness.staleReason?.evidence).toBe('sha-1')
    // The generation ADVANCED — that is what makes it stale, not the badge.
    expect(s.source?.generation).toBe(2)
    expect(s.freshness.staleReason?.generation).toBe(2)
    expect(s.freshness.observedGeneration).toBe(1)
  })

  it('repeated equivalent events create ONE queued job and commit nothing after the first', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    const first = await h.coord.note(gitEvent())
    const revAfterFirst = h.get('sf-1').rev
    const second = await h.coord.note(gitEvent())
    const third = await h.coord.note(gitEvent())
    expect(first.queued).toHaveLength(1)
    expect(second.queued).toEqual([])
    expect(third.queued).toEqual([])
    expect(h.jobs.list()).toHaveLength(1)
    // No SSE / persistence storm: the repeats did not bump the revision.
    expect(h.get('sf-1').rev).toBe(revAfterFirst)
  })

  it('a NEW event coalesces onto the existing job by generation, never a second job', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent({ evidence: 'sha-1' }))
    const report = await h.coord.note(gitEvent({ evidence: 'sha-2' }))
    expect(report.queued).toEqual([])
    expect(report.coalesced).toHaveLength(1)
    expect(h.jobs.list()).toHaveLength(1)
    expect(h.jobFor('sf-1')!.targetGeneration).toBe(3)
    expect(h.jobFor('sf-1')!.startGeneration).toBe(2)
  })

  it('two live triggers do not invalidate each other, so an IDLE repo goes quiet', async () => {
    // The livelock. Both host-default triggers are in force, and the two clocks that
    // raise them alternate: the 5s sweep raises `periodic`, the 15s git poll raises
    // `git-revision`. Against ONE staleReason slot each overwrote the other's key and
    // then read it back as new — so a repo where nothing whatsoever happened burned a
    // revision and a generation every few seconds, forever.
    const h = harness()
    await h.seed({
      content: { headline: 'Coverage', recipe: 'Re-run coverage.' },
      freshness: { phase: 'current', overdue: false, observedGeneration: 1, verifiedAt: 1_000 },
    })
    h.clock.now = 2_000_000

    // Settle: let the first genuine observations land and the first refresh finish.
    for (let i = 0; i < 4; i++) {
      h.clock.now += 5_000
      await h.coord.sweep()
      const running = h.jobs.list().find(j => j.state === 'running')
      if (running) h.staged.set(running.stagingPath, workerJson({ note: 'no change' }))
      h.clock.now += 5_000
      await h.coord.note(gitEvent({ evidence: 'sha-STEADY', at: h.clock.now }))
    }
    h.clock.now += 5_000
    await h.coord.sweep()

    // Now HEAD still has not moved and no deadline has passed. Nothing may be
    // written, and nothing may be launched.
    const settledRev = h.get('sf-1').rev
    const settledGeneration = h.get('sf-1').source!.generation
    const launchesSoFar = h.launches.length
    for (let i = 0; i < 6; i++) {
      h.clock.now += 5_000
      await h.coord.sweep()
      h.clock.now += 5_000
      await h.coord.note(gitEvent({ evidence: 'sha-STEADY', at: h.clock.now }))
    }
    expect(h.get('sf-1').rev).toBe(settledRev)
    expect(h.get('sf-1').source!.generation).toBe(settledGeneration)
    expect(h.launches.length).toBe(launchesSoFar)
  })

  it('a verified Surface is not re-staled by the very evidence it was verified against', async () => {
    // The other half of the same defect: a successful barrier clears `staleReason`,
    // so with the dedupe living there the NEXT poll of an unchanged SHA read as new.
    // The memory has to survive the refresh that consumed it.
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent({ evidence: 'sha-1' }))
    await h.coord.sweep()
    const job = h.jobFor('sf-1')!
    h.staged.set(job.stagingPath, workerJson({ headline: 'Coverage 92%' }))
    h.clock.now = 30_000
    await h.coord.sweep()
    expect(h.get('sf-1').freshness.phase).toBe('current')

    const rev = h.get('sf-1').rev
    h.clock.now = 45_000
    const report = await h.coord.note(gitEvent({ evidence: 'sha-1', at: 45_000 }))
    expect(report.marked).toEqual([])
    expect(report.queued).toEqual([])
    expect(h.get('sf-1').rev).toBe(rev)
    expect(h.get('sf-1').freshness.phase).toBe('current')
  })

  it('a failed refresh retries on the verification interval, not on the sweep', async () => {
    // `dueAt` is derived from the last SUCCESSFUL verification so a failing loop
    // cannot silence its own overdue badge — which means a broken recipe sits
    // permanently past a deadline that never advances. Without a cooldown that is a
    // real background agent launched in the user's worktree every sweep, forever.
    const h = harness()
    await h.seed({
      content: {
        headline: 'Coverage', recipe: 'Re-run coverage.',
        refreshPolicy: { policy: 'automatic', triggers: ['periodic'], intervalMs: 60_000 },
      },
    })
    h.clock.now = 70_000
    await h.coord.sweep()
    const first = h.jobFor('sf-1')!
    h.staged.set(first.stagingPath, workerJson({ error: 'the coverage tool is not installed' }))
    await h.coord.sweep()
    expect(h.get('sf-1').freshness.phase).toBe('failed')
    const launchesAfterFailure = h.launches.length

    // Six more sweeps inside the interval launch nothing.
    for (let i = 0; i < 6; i++) {
      h.clock.now += 5_000
      await h.coord.sweep()
    }
    expect(h.launches.length).toBe(launchesAfterFailure)
    // The badge is untouched — the Surface is still visibly failed and overdue.
    expect(h.get('sf-1').freshness.phase).toBe('failed')
    expect(h.get('sf-1').freshness.overdue).toBe(true)

    // Past the interval, it tries again.
    h.clock.now += 60_000
    await h.coord.sweep()
    expect(h.launches.length).toBe(launchesAfterFailure + 1)
  })

  it('the three policies produce distinct visible outcomes', async () => {
    for (const [decl, expected] of [
      [AUTOMATIC, { phase: 'queued', jobs: 1 }],
      [MARK_STALE, { phase: 'possibly-stale', jobs: 0 }],
      [MANUAL, { phase: 'current', jobs: 0 }],
    ] as const) {
      const h = harness()
      await h.seed(withPolicy(decl))
      await h.coord.note(gitEvent())
      expect(h.get('sf-1').freshness.phase).toBe(expected.phase)
      expect(h.jobs.list()).toHaveLength(expected.jobs)
    }
  })
})

describe('dispatch', () => {
  it('takes the Surface to refreshing and launches one background worker', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const report = await h.coord.sweep()
    expect(report.dispatched).toHaveLength(1)
    expect(h.launches).toHaveLength(1)
    expect(h.get('sf-1').freshness.phase).toBe('refreshing')
    const job = h.jobFor('sf-1')!
    expect(job.state).toBe('running')
    expect(job.dispatch?.kind).toBe('worker')
    expect(job.attempts).toBe(1)
    expect(job.lease?.owner).toBe('refresh-coordinator')
  })

  it('a fan-out beyond the cap leaves the excess QUEUED and launches nothing for it', async () => {
    const h = harness({ maxConcurrentWorkers: 2 })
    for (let i = 1; i <= 5; i++) {
      await h.seed({ id: `sf-${i}`, ...withPolicy(AUTOMATIC) })
    }
    await h.coord.note(gitEvent())
    const report = await h.coord.sweep()
    expect(report.dispatched).toHaveLength(2)
    expect(report.heldByCap).toHaveLength(3)
    expect(h.launches).toHaveLength(2)
    expect(h.jobs.activeCount('running')).toBe(2)
    expect(h.jobs.activeCount('queued')).toBe(3)
    // The held jobs are still QUEUED — not failed, not dropped.
    for (const job of h.jobs.list().filter(j => j.state === 'queued')) {
      expect(job.dispatch).toBeUndefined()
      // Visibly QUEUED, not silently stale: the cap is a real state the user sees.
      expect(h.get(job.surfaceId).freshness.phase).toBe('queued')
    }
  })

  it('hands work to a LIVE owner directly, without a worker or a cap slot', async () => {
    const h = harness({ maxConcurrentWorkers: 0 })
    await h.seed({ ...withPolicy(AUTOMATIC), owner: { kind: 'session', id: RUN } })
    h.live.add(RUN)
    await h.coord.note(gitEvent())
    const report = await h.coord.sweep()
    expect(report.dispatched).toHaveLength(1)
    expect(h.launches).toEqual([])
    expect(h.delivered[0]?.sessionName).toBe(RUN)
    expect(h.jobFor('sf-1')!.dispatch?.kind).toBe('owner')
  })

  it('an in-flight OWNER delivery does not consume a worker slot on the NEXT sweep', async () => {
    // The cap bounds managed sessions and their ttyd ports; an owner delivery claims
    // neither. Counting `running` by STATE could not see the difference, so the
    // invariant the dispatch path documents held for exactly the sweep that
    // dispatched it — and every cap test ran a single sweep, which is why this
    // passed. With `maxConcurrentWorkers: 1`, one in-flight owner delivery blocked
    // the whole background fleet until the worker timeout.
    const h = harness({ maxConcurrentWorkers: 1 })
    await h.seed({ id: 'sf-owned', ...withPolicy(AUTOMATIC), owner: { kind: 'session', id: RUN } })
    h.live.add(RUN)
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    const owned = h.jobFor('sf-owned')!
    expect(owned.dispatch?.kind).toBe('owner')
    expect(owned.state).toBe('running')

    // A second Surface goes stale, in a run whose session is NOT live, so it can
    // only be serviced by a background worker. On the NEXT sweep — the owner job
    // still running — that worker must still launch.
    await h.seed({
      id: 'sf-plain', ...withPolicy(AUTOMATIC),
      provenance: { runId: 'run-b', worktreeId: WORKTREE },
    })
    h.clock.now = 25_000
    await h.coord.note(gitEvent({ evidence: 'sha-2', at: 25_000 }))
    const second = await h.coord.sweep()
    expect(second.heldByCap).toEqual([])
    expect(h.launches).toHaveLength(1)
    expect(h.jobFor('sf-plain')!.dispatch?.kind).toBe('worker')
  })

  it('the kill switch holds jobs queued and launches nothing', async () => {
    const h = harness({ autonomousWorkers: false })
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const report = await h.coord.sweep()
    expect(report.dispatched).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.jobFor('sf-1')!.state).toBe('queued')
  })

  it('reports an unauthorized mixed-worktree dispatch as blocked, with its reason', async () => {
    const h = harness()
    await h.seed({
      ...withPolicy(AUTOMATIC),
      provenance: { runId: RUN, worktreeId: '/tmp/wt/beta' },
    })
    await h.coord.note(gitEvent({ worktree: undefined }))
    const report = await h.coord.sweep()
    expect(report.blocked).toHaveLength(1)
    expect(report.blocked[0]?.reason).toMatch(/two worktrees/)
    expect(h.launches).toEqual([])
    const s = h.get('sf-1')
    expect(s.freshness.phase).toBe('failed')
    expect(s.freshness.failure?.message).toMatch(/two worktrees/)
    expect(h.jobFor('sf-1')!.authorization.blocked).toMatch(/two worktrees/)
  })

  it('a recipe-LESS Surface is blocked rather than dispatched to nothing', async () => {
    const h = harness()
    await h.seed({ content: { headline: 'Notes', refreshPolicy: AUTOMATIC } })
    await h.coord.note(gitEvent())
    const report = await h.coord.sweep()
    expect(report.blocked[0]?.reason).toMatch(/no refresh recipe/)
  })

  it('a failed launch fails the job and leaves the Surface visibly failed', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    h.launchOutcome = () => ({ ok: false, message: 'no port available in window "refresh"' })
    await h.coord.note(gitEvent())
    const report = await h.coord.sweep()
    expect(report.failed[0]?.reason).toMatch(/no port available/)
    expect(h.get('sf-1').freshness.phase).toBe('failed')
    expect(h.get('sf-1').freshness.failure?.message).toMatch(/no port available/)
  })

  /** An overdue Surface carrying NO author declaration, so it runs on the host
   *  defaults the real fleet runs on: policy `automatic`, triggers `git-revision` +
   *  `periodic`. Both are live, which is what lets the sweep and the git poll each
   *  schedule for the same Surface. */
  async function overdueOnDefaults(h: Harness): Promise<void> {
    await h.seed({
      content: { headline: 'Coverage', recipe: 'Re-run coverage.' },
      freshness: { phase: 'current', overdue: false, observedGeneration: 1, verifiedAt: 1_000 },
    })
    h.clock.now = 2_000_000 // long past verifiedAt + defaultIntervalMs
  }

  it('a note() interleaving with a sweep() cannot create two jobs for one Surface', async () => {
    // The host's real shape: `index.ts` fires `void refreshCoordinator.note(...)`
    // from the 15s git poll and never awaits it, and the sweep timer guards only
    // against another SWEEP. `scheduleFor` reads `jobs.active()`, then awaits twice
    // before `jobs.put`, so two callers inside that window both see no active job
    // and both create one.
    const h = harness()
    await overdueOnDefaults(h)
    await Promise.all([
      h.coord.sweep(),
      h.coord.note(gitEvent({ evidence: 'sha-1', at: h.clock.now })),
    ])
    // ONE job was ever CREATED — not "one survived". The ownership guard in
    // `dispatch` cancels a duplicate on the next pass, which repairs the damage but
    // does not prevent it: the second job still claimed a table slot, and the
    // Surface still spent a window owned by a job that could never run. The
    // serializer is what stops it existing.
    expect(h.jobs.list()).toHaveLength(1)
    expect(h.jobs.active('sf-1')).toBeDefined()
  })

  it('a Surface does not become un-refreshable after a racing schedule', async () => {
    // The CONSEQUENCE, which is what makes the race a P0 rather than an untidiness:
    // the losing job can never begin (`beginRefresh` needs phase `queued`, which
    // does not recur), nothing ages a queued job out, and `scheduleFor` coalesces
    // every later trigger onto it — so the Surface stops refreshing for the process
    // lifetime, manual button included.
    const h = harness()
    await overdueOnDefaults(h)
    await Promise.all([
      h.coord.sweep(),
      h.coord.note(gitEvent({ evidence: 'sha-1', at: h.clock.now })),
    ])
    // Let whatever is in flight finish.
    for (let i = 0; i < 2; i++) {
      const running = h.jobs.list().find(j => j.state === 'running')
      if (running) h.staged.set(running.stagingPath, workerJson({ note: 'no change' }))
      h.clock.now += 5_000
      await h.coord.sweep()
    }

    // Now four more commits land. Each must schedule, dispatch, and complete.
    for (let i = 2; i < 6; i++) {
      h.clock.now += 15_000
      await h.coord.note(gitEvent({ evidence: `sha-${i}`, at: h.clock.now }))
      await h.coord.sweep()
      const job = h.jobs.active('sf-1')
      expect(job?.state).toBe('running')
      h.staged.set(job!.stagingPath, workerJson({ note: 'no change' }))
      h.clock.now += 5_000
      await h.coord.sweep()
      expect(h.get('sf-1').freshness.phase).toBe('current')
    }
    expect(h.jobs.list().filter(j => j.state === 'queued')).toEqual([])
  })

  it('cancels a queued job whose Surface another job has taken over', async () => {
    // The guard that makes the deadlock unreachable even without the serializer —
    // a second backend, or a hand-edited sidecar, can still hand a queued job a
    // Surface it no longer owns.
    const h = harness({ autonomousWorkers: false })
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const job = h.jobFor('sf-1')!
    expect(job.state).toBe('queued')

    // Somebody else takes the Surface.
    await h.svc.enqueueRefresh('sf-1', { jobId: 'job-elsewhere' }, ctx(21_000))
    expect(h.get('sf-1').freshness.jobId).toBe('job-elsewhere')

    h.clock.now = 22_000
    const report = await h.coord.sweep()
    expect(h.jobs.get(job.id)!.state).toBe('cancelled')
    expect(report.failed[0]?.reason).toMatch(/took this Surface over/)
    // And nothing is left owning it, so the next trigger can schedule real work.
    expect(h.jobs.active('sf-1')).toBeUndefined()
  })

  it('two sweeps cannot both take one queued job', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const [a, b] = await Promise.all([h.coord.sweep(), h.coord.sweep()])
    expect(a.dispatched.length + b.dispatched.length).toBe(1)
    expect(h.launches).toHaveLength(1)
  })

  it('two takers of one lease: the SECOND is refused at the record, not at the table', async () => {
    // The test above passes even with the compare-and-swap removed, because the job
    // table's own state filter happens to serialize two in-process sweeps. That is
    // not the invariant — the invariant is that the RECORD refuses a second taker,
    // which is what protects a restart-adopted job or a second backend from
    // completing work another worker already owns. So it is asserted directly.
    const h = harness()
    const seeded = await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const queued = h.get(seeded.id)
    expect(queued.freshness.phase).toBe('queued')

    const first = await h.svc.beginRefresh(seeded.id, { jobId: 'job-a', expectedRev: queued.rev }, ctx(21_000))
    expect(first.ok).toBe(true)

    // Same expectedRev, a different job: the world moved, so this must lose.
    const second = await h.svc.beginRefresh(seeded.id, { jobId: 'job-b', expectedRev: queued.rev }, ctx(21_001))
    expect(second.ok).toBe(false)
    expect(h.get(seeded.id).freshness.jobId).toBe('job-a')

    // And even at the CURRENT revision it loses, because the Surface is no longer
    // queued — the phase check and the revision check are separate guards.
    const third = await h.svc.beginRefresh(
      seeded.id, { jobId: 'job-b', expectedRev: h.get(seeded.id).rev }, ctx(21_002),
    )
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.error.reason).toBe('already-refreshing')
    expect(h.get(seeded.id).freshness.jobId).toBe('job-a')
  })

  it('a Surface that moved while STILL queued refuses a sweep holding the older revision', async () => {
    // The case the phase check cannot catch, and therefore the only one that
    // proves the revision compare-and-swap is load-bearing rather than decorative:
    // a trigger arriving between a sweep reading the Surface and taking it leaves
    // the phase at `queued` and moves the revision. Letting the sweep through would
    // dispatch a worker against a generation the host has already moved past —
    // guaranteeing a supersession, and a wasted managed session with it.
    const h = harness()
    const seeded = await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const asRead = h.get(seeded.id)
    expect(asRead.freshness.phase).toBe('queued')

    // A newer trigger. The phase stays `queued`; only the revision and the
    // generation move.
    await h.coord.note(gitEvent({ evidence: 'sha-2', at: 21_000 }))
    const moved = h.get(seeded.id)
    expect(moved.freshness.phase).toBe('queued')
    expect(moved.rev).toBeGreaterThan(asRead.rev)

    const stale = await h.svc.beginRefresh(
      seeded.id, { jobId: 'job-stale', expectedRev: asRead.rev }, ctx(21_500),
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.reason).toBe('stale-surface-revision')
    expect(h.get(seeded.id).freshness.phase).toBe('queued')
    expect(h.get(seeded.id).freshness.jobId).not.toBe('job-stale')
  })
})

describe('the observation barrier', () => {
  async function dispatched(over: Partial<RefreshCoordinatorConfig> = {}): Promise<Harness> {
    const h = harness(over)
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    return h
  }

  it('commits a result computed against the current generation and clears the reason', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    h.staged.set(job.stagingPath, workerJson({ headline: 'Coverage 92%' }))
    h.clock.now = 30_000
    const report = await h.coord.sweep()
    expect(report.completed).toEqual([job.id])
    const s = h.get('sf-1')
    expect(s.freshness.phase).toBe('current')
    expect(s.freshness.verifiedAt).toBe(30_000)
    expect(s.freshness.observedGeneration).toBe(2)
    expect(s.freshness.staleReason).toBeUndefined()
    expect(s.freshness.jobId).toBeUndefined()
    expect(s.content.headline).toBe('Coverage 92%')
    // AND THE INPUT SURVIVED THE OUTPUT. A worker restates neither the recipe nor
    // the declaration — `parseStagedResult` cannot even express them — so a barrier
    // that assigned the staged content wholesale deleted both on the FIRST success
    // and left the Surface permanently unrefreshable. Asserted here rather than in
    // a dedicated test because this is the ordinary path that destroyed them.
    expect(s.content.recipe).toBe('Re-run coverage.')
    expect(s.content.refreshPolicy).toEqual(AUTOMATIC)
    // The worker session was retired, and its staged artifact consumed.
    expect(h.retired).toEqual([`refresh-${job.id}`])
    expect(h.staged.size).toBe(0)
  })

  it('a SECOND refresh of the same Surface still has a recipe to run', async () => {
    // The compounding form of the same defect: the first success is what deletes
    // the recipe, so nothing before the second dispatch can notice. A Surface that
    // can only ever be refreshed once looks perfectly healthy for one cycle.
    const h = await dispatched()
    const first = h.jobFor('sf-1')!
    h.staged.set(first.stagingPath, workerJson({ headline: 'Coverage 92%' }))
    h.clock.now = 30_000
    await h.coord.sweep()
    expect(h.get('sf-1').freshness.phase).toBe('current')

    h.clock.now = 40_000
    const report = await h.coord.note(gitEvent({ evidence: 'sha-2', at: 40_000 }))
    // Not blocked for want of a recipe, which is what `authorizationProblem` would
    // have said — and the dispatch prompt still carries one to run.
    expect(report.queued).toHaveLength(1)
    const second = await h.coord.sweep()
    expect(second.blocked).toEqual([])
    expect(second.dispatched).toHaveLength(1)
    expect(h.jobs.list().find(j => j.id !== first.id)!.state).toBe('running')
  })

  it('a newer event DURING execution supersedes the result and keeps the Surface pending', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    // The world moves while the worker runs.
    h.clock.now = 25_000
    await h.coord.note(gitEvent({ evidence: 'sha-2', at: 25_000 }))
    expect(h.get('sf-1').freshness.phase).toBe('refreshing')

    h.staged.set(job.stagingPath, workerJson({ headline: 'Coverage 92%' }))
    h.clock.now = 30_000
    const report = await h.coord.sweep()
    expect(report.superseded).toEqual([job.id])
    expect(report.completed).toEqual([])
    const s = h.get('sf-1')
    // The stale result did NOT land, and the Surface did not claim current.
    expect(s.content.headline).toBe('Coverage')
    expect(s.freshness.phase).not.toBe('current')
    expect(s.freshness.staleReason?.evidence).toBe('sha-2')
    // Exactly ONE successor, for the newest generation. It is already running:
    // `sweep` harvests before it dispatches, so a slot freed this pass is reused
    // this pass rather than one sweep later.
    const successors = h.jobs.list().filter(j => j.id !== job.id)
    expect(successors).toHaveLength(1)
    expect(successors[0]!.startGeneration).toBe(3)
    expect(successors[0]!.targetGeneration).toBe(3)
  })

  it('a source change whose watcher event is DELAYED is caught by the barrier', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    // Nothing has told the coordinator anything. The re-observation is what finds
    // it — this is the only place a delayed event can be caught.
    h.observe = async (surface) => {
      await h.svc.markPossiblyStale(surface.id, {
        kind: 'source-content', key: 'late', detail: 'the source moved', evidence: 'hash-9', at: 29_000,
      }, ctx(29_000))
    }
    h.staged.set(job.stagingPath, workerJson({ headline: 'Coverage 92%' }))
    h.clock.now = 30_000
    const report = await h.coord.sweep()
    expect(report.superseded).toEqual([job.id])
    expect(h.get('sf-1').freshness.phase).not.toBe('current')
    expect(h.get('sf-1').content.headline).toBe('Coverage')
  })

  it('a concurrent content edit is NOT overwritten by the result it raced', async () => {
    // The guard the record could not previously express. The generation catches
    // SOURCE movement; `updateContent` — the path an agent's Slate write and a
    // user's edit both take — bumps `rev` but writes the adapter's new watermark
    // straight onto the binding, so `observeSource` sees no evidence move and the
    // generation sees nothing. And the revision compare-and-swap is unreachable
    // from harvest, which re-reads `rev` on the line above the call.
    //
    // Executed against this branch before the fix: a user's "DO NOT TOUCH, I am
    // mid-triage" headline was destroyed, the phase committed `current`, and there
    // was no conflict and no trace.
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    expect(job.baseContentDigest).toBeDefined()

    // The user edits mid-flight. Legitimately: the Surface is `refreshing`, and
    // `guardLive` only blocks recovery-store records, so nothing stops this.
    const edited = await h.svc.updateContent('sf-1', {
      headline: 'Coverage — DO NOT TOUCH, I am mid-triage',
      expectedRev: h.get('sf-1').rev,
    }, ctx(25_000))
    expect(edited.ok).toBe(true)

    h.staged.set(job.stagingPath, workerJson({ headline: 'Coverage 91%' }))
    h.clock.now = 30_000
    const report = await h.coord.sweep()

    expect(report.completed).toEqual([])
    expect(report.superseded).toEqual([job.id])
    expect(h.get('sf-1').content.headline).toBe('Coverage — DO NOT TOUCH, I am mid-triage')
    // And the edit did not merely survive by luck — the Surface did not claim it
    // had been verified, and one successor was scheduled to redo the work.
    expect(h.get('sf-1').freshness.phase).not.toBe('current')
    expect(h.jobs.list().filter(j => j.id !== job.id)).toHaveLength(1)
  })

  it('a thread reply during a refresh does NOT supersede the result', async () => {
    // The other side of the same line. Content is the axis on purpose: a reply, a
    // schedule change, or an ownership transfer must not throw away a result that
    // is still perfectly valid for the content it replaces. A `baseRev` comparison
    // would have refused all of them — including the coordinator's own commits.
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    await h.svc.appendThread('sf-1', { text: 'still true?' }, ctx(25_000))

    h.staged.set(job.stagingPath, workerJson({ headline: 'Coverage 91%' }))
    h.clock.now = 30_000
    const report = await h.coord.sweep()
    expect(report.completed).toEqual([job.id])
    expect(h.get('sf-1').content.headline).toBe('Coverage 91%')
    expect(h.get('sf-1').thread.replies).toHaveLength(1)
  })

  it('a watcher observation that ends the refresh is a SUPERSESSION, not a failure', async () => {
    // `observeSource` sets `phase: 'current'` whenever the binding is authoritative
    // and the watermark moved — including while `refreshing`, and without clearing
    // `jobId`. So an ordinary agent write during a refresh takes the Surface out of
    // `refreshing` under the job's feet.
    //
    // The barrier then checked the PHASE first and answered
    // `stale-surface-revision`, which the coordinator's supersession branch does not
    // match — so it fell through to `failJob`. Net: a Surface the watcher had just
    // made current was committed as `failed`, no successor was scheduled, and the
    // badge read "The last refresh failed: mutation refused: stale-surface-revision".
    // Both the state and the message were wrong.
    const h = harness()
    await h.seed({ ...withPolicy(AUTOMATIC), contentAuthority: 'source-binding' })
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    const job = h.jobFor('sf-1')!
    expect(h.get('sf-1').freshness.phase).toBe('refreshing')

    // The watcher lands the agent's file write during the barrier's re-observation.
    h.observe = async surface => {
      await h.svc.observeSource({
        id: surface.id,
        spaceId: SPACE,
        home: surface.home,
        adapter: 'slate-file',
        locator: 'file:cov.json#cov',
        worktree: WORKTREE,
        alias: { bucket: { kind: 'run', runId: RUN }, localId: 'cov', visible: true },
        author: 'agent',
        content: { headline: 'Coverage 90% (agent)', recipe: 'Re-run coverage.', refreshPolicy: AUTOMATIC },
        watermark: 'sha256:moved',
      }, ctx(29_000))
    }
    // A "nothing to change" result, so the outcome turns on the phase and not on
    // whether an adapter is registered to carry content back.
    h.staged.set(job.stagingPath, workerJson({ note: 'no change' }))
    h.clock.now = 30_000
    const report = await h.coord.sweep()

    expect(report.superseded).toEqual([job.id])
    expect(report.failed).toEqual([])
    expect(h.get('sf-1').freshness.phase).not.toBe('failed')
    expect(h.get('sf-1').freshness.failure).toBeUndefined()
    // Exactly one successor, for the generation the observation moved to.
    expect(h.jobs.list().filter(j => j.id !== job.id)).toHaveLength(1)
  })

  it('a byte-identical regeneration completes explicitly rather than spinning forever', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    const before = h.get('sf-1').amendedAt
    // The worker looked and found nothing to change. That still has to COMPLETE:
    // "nothing changed" and "still running" look identical to a spinner.
    h.staged.set(job.stagingPath, workerJson({ note: 'no change since the last run' }))
    h.clock.now = 30_000
    const report = await h.coord.sweep()
    expect(report.completed).toEqual([job.id])
    const s = h.get('sf-1')
    expect(s.freshness.phase).toBe('current')
    expect(s.freshness.verifiedAt).toBe(30_000)
    expect(s.amendedAt).toBeGreaterThan(before)
    expect(h.jobs.get(job.id)!.result?.message).toMatch(/no change/)
  })

  it('a worker that reports an error fails the job and retires its session', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    h.staged.set(job.stagingPath, workerJson({ error: 'the coverage tool is not installed' }))
    const report = await h.coord.sweep()
    expect(report.failed[0]?.reason).toMatch(/not installed/)
    expect(h.get('sf-1').freshness.phase).toBe('failed')
    expect(h.retired).toEqual([`refresh-${job.id}`])
  })

  it('an OWNER that exits mid-refresh fails the job rather than spinning to the timeout', async () => {
    // The owner-delivery counterpart of the vanished-worker case. An owner that
    // exited is exactly as incapable of writing the result as a dead worker, and
    // waiting out the timeout would leave the Surface refreshing for minutes with
    // nothing behind it.
    const h = harness({ maxConcurrentWorkers: 0 })
    await h.seed({ ...withPolicy(AUTOMATIC), owner: { kind: 'session', id: RUN } })
    h.live.add(RUN)
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    expect(h.jobFor('sf-1')!.dispatch?.kind).toBe('owner')

    h.live.delete(RUN)
    h.clock.now = 21_000 // well inside workerTimeoutMs
    const report = await h.coord.sweep()
    expect(report.failed[0]?.reason).toMatch(/owner session .* exited without writing a result/)
    expect(h.get('sf-1').freshness.phase).toBe('failed')
  })

  it('a QUEUED job whose owner exits before dispatch transfers to a worker, once', async () => {
    const h = harness({ maxConcurrentWorkers: 1 })
    await h.seed({ ...withPolicy(AUTOMATIC), owner: { kind: 'session', id: RUN } })
    // The owner was never live, so the first dispatch goes to a background worker.
    await h.coord.note(gitEvent())
    const first = await h.coord.sweep()
    expect(first.dispatched).toHaveLength(1)
    expect(h.delivered).toEqual([])
    expect(h.launches).toHaveLength(1)
    // And only once: a second sweep finds the job running, not queued.
    const second = await h.coord.sweep()
    expect(second.dispatched).toEqual([])
    expect(h.launches).toHaveLength(1)
  })

  it('a worker that vanishes without writing a result fails before the timeout elapses', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    h.live.delete(`refresh-${job.id}`)
    h.clock.now = 21_000 // well inside workerTimeoutMs
    const report = await h.coord.sweep()
    expect(report.failed[0]?.reason).toMatch(/exited without writing a result/)
    expect(h.get('sf-1').freshness.phase).toBe('failed')
  })

  it('a worker that hangs past the timeout is failed, not left running', async () => {
    const h = await dispatched({ workerTimeoutMs: 5_000 })
    h.clock.now = 100_000
    const report = await h.coord.sweep()
    expect(report.failed[0]?.reason).toMatch(/no result after/)
    expect(h.get('sf-1').freshness.phase).toBe('failed')
  })

  it('a failure retains the stale reason and the overdue flag', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    await h.svc.setSchedule('sf-1', { dueAt: 1_000, overdue: true }, ctx(20_500))
    h.staged.set(job.stagingPath, workerJson({ error: 'boom' }))
    await h.coord.sweep()
    const s = h.get('sf-1')
    expect(s.freshness.overdue).toBe(true)
    expect(s.freshness.staleReason?.kind).toBe('git-revision')
  })
})

describe('freshness transitions the coordinator relies on', () => {
  // These three guards are REACHABLE only from outside the coordinator's happy
  // path — a second backend, a restart-adopted job, a hand-edited sidecar. The
  // coordinator's own sequencing masks them, so backing one out breaks nothing in
  // the flow tests above. They are asserted directly, because what they protect is
  // a Surface claiming current on work nobody can vouch for.

  it('refuses to queue a Surface that is already refreshing', async () => {
    const h = harness()
    const seeded = await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    await h.svc.beginRefresh(seeded.id, { jobId: 'job-a', expectedRev: h.get(seeded.id).rev }, ctx(21_000))
    expect(h.get(seeded.id).freshness.phase).toBe('refreshing')

    const requeued = await h.svc.enqueueRefresh(seeded.id, { jobId: 'job-b' }, ctx(22_000))
    expect(requeued.ok).toBe(false)
    if (!requeued.ok) expect(requeued.error.reason).toBe('already-refreshing')
    // The in-flight job still owns it — re-queueing would orphan a running worker
    // whose result then had nothing to complete.
    expect(h.get(seeded.id).freshness.phase).toBe('refreshing')
    expect(h.get(seeded.id).freshness.jobId).toBe('job-a')
  })

  it('refuses to complete a Surface that is not refreshing', async () => {
    const h = harness()
    const seeded = await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const queued = h.get(seeded.id)
    expect(queued.freshness.phase).toBe('queued')

    // A result for work that was never started. Accepting it would mark the Surface
    // verified on the strength of a job the host never dispatched.
    const completed = await h.svc.completeRefresh(seeded.id, {
      jobId: 'job-ghost',
      expectedRev: queued.rev,
      observedGeneration: queued.source!.generation,
      content: { headline: 'Ghost result' },
    }, ctx(23_000))
    expect(completed.ok).toBe(false)
    expect(h.get(seeded.id).content.headline).toBe('Coverage')
    expect(h.get(seeded.id).freshness.phase).toBe('queued')
  })

  it('refuses a result whose record moved for a reason the generation cannot see', async () => {
    // The generation catches SOURCE movement. It cannot see a concurrent edit to
    // the record itself — a thread reply, a headline the user just fixed — because
    // none of those touch a source binding. `completeRefresh` writes `content`
    // wholesale, so without the revision compare-and-swap a refresh that started
    // before the user's edit would silently overwrite it.
    const h = harness()
    const seeded = await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const queued = h.get(seeded.id)
    await h.svc.beginRefresh(seeded.id, { jobId: 'job-a', expectedRev: queued.rev }, ctx(21_000))
    const dispatchedAt = h.get(seeded.id)

    // A human replies on the thread while the worker runs. Same generation, newer
    // revision.
    const replied = await h.svc.appendThread(seeded.id, { text: 'still true?' }, ctx(21_500))
    expect(replied.ok).toBe(true)
    expect(h.get(seeded.id).source!.generation).toBe(dispatchedAt.source!.generation)

    const completed = await h.svc.completeRefresh(seeded.id, {
      jobId: 'job-a',
      expectedRev: dispatchedAt.rev,
      observedGeneration: dispatchedAt.source!.generation,
      content: { headline: 'Coverage 92%' },
    }, ctx(22_000))
    expect(completed.ok).toBe(false)
    // The reply survives, and the stale-based rewrite did not land.
    expect(h.get(seeded.id).thread.replies).toHaveLength(1)
    expect(h.get(seeded.id).content.headline).toBe('Coverage')
  })

  it('an unchanged schedule is a SUCCESS, so an already-overdue Surface is still picked up', async () => {
    // The restart case. A Surface persisted as overdue has nothing for `setSchedule`
    // to change; if that came back as a conflict the sweep would skip it, and a
    // Surface that went overdue before the process died would never be refreshed
    // again.
    const h = harness()
    await h.seed({
      content: {
        headline: 'Coverage', recipe: 'Re-run coverage.',
        refreshPolicy: { policy: 'automatic', triggers: ['periodic'], intervalMs: 60_000 },
      },
      // Exactly what the sweep will derive: verifiedAt 5,000 + 60,000 = 65,000.
      freshness: { phase: 'possibly-stale', overdue: true, dueAt: 65_000, observedGeneration: 1, verifiedAt: 5_000 },
    })
    const unchanged = await h.svc.setSchedule('sf-1', { dueAt: 65_000, overdue: true }, ctx(70_000))
    expect(unchanged.ok).toBe(true)

    h.clock.now = 70_000
    const report = await h.coord.sweep()
    expect(report.queued).toHaveLength(1)
    expect(h.get('sf-1').freshness.overdue).toBe(true)
  })
})

describe('deadlines', () => {
  it('a passed dueAt exposes overdue for automatic, mark-stale, AND manual', async () => {
    for (const decl of [AUTOMATIC, MARK_STALE, MANUAL]) {
      const h = harness()
      await h.seed({
        content: {
          headline: 'Coverage', recipe: 'Re-run coverage.',
          refreshPolicy: { ...decl, triggers: [...decl.triggers, 'periodic'], intervalMs: 60_000 },
        },
      })
      // verifiedAt 5,000 + 60,000 = due at 65,000.
      h.clock.now = 70_000
      await h.coord.sweep()
      const s = h.get('sf-1')
      expect(s.freshness.dueAt).toBe(65_000)
      expect(s.freshness.overdue).toBe(true)
    }
  })

  it('only an AUTOMATIC overdue Surface gets a job', async () => {
    const outcomes: Record<string, number> = {}
    for (const decl of [AUTOMATIC, MARK_STALE, MANUAL]) {
      const h = harness()
      await h.seed({
        content: {
          headline: 'Coverage', recipe: 'Re-run coverage.',
          refreshPolicy: { ...decl, triggers: [...decl.triggers, 'periodic'], intervalMs: 60_000 },
        },
      })
      h.clock.now = 70_000
      await h.coord.sweep()
      outcomes[decl.policy] = h.jobs.list().length
    }
    expect(outcomes).toEqual({ automatic: 1, 'mark-stale': 0, manual: 0 })
  })

  it('one missed deadline raises one trigger, however many sweeps run', async () => {
    const h = harness()
    await h.seed({
      content: {
        headline: 'Coverage', recipe: 'Re-run coverage.',
        refreshPolicy: { policy: 'mark-stale', triggers: ['periodic'], intervalMs: 60_000 },
      },
    })
    h.clock.now = 70_000
    await h.coord.sweep()
    const rev = h.get('sf-1').rev
    await h.coord.sweep()
    await h.coord.sweep()
    expect(h.get('sf-1').rev).toBe(rev)
  })

  it('a successful barrier is the only thing that clears overdue', async () => {
    const h = harness()
    await h.seed({
      content: {
        headline: 'Coverage', recipe: 'Re-run coverage.',
        refreshPolicy: { policy: 'automatic', triggers: ['periodic'], intervalMs: 60_000 },
      },
    })
    h.clock.now = 70_000
    await h.coord.sweep()
    expect(h.get('sf-1').freshness.overdue).toBe(true)
    // Queued and then refreshing — still overdue.
    expect(h.get('sf-1').freshness.phase).toBe('refreshing')
    expect(h.get('sf-1').freshness.overdue).toBe(true)

    const job = h.jobFor('sf-1')!
    h.staged.set(job.stagingPath, workerJson({ headline: 'Coverage 92%' }))
    h.clock.now = 80_000
    await h.coord.sweep()
    expect(h.get('sf-1').freshness.overdue).toBe(false)
  })

  it('writes nothing on a sweep where no deadline moved', async () => {
    const h = harness()
    await h.seed(withPolicy(MARK_STALE))
    const rev = h.get('sf-1').rev
    await h.coord.sweep()
    await h.coord.sweep()
    expect(h.get('sf-1').rev).toBe(rev)
  })
})

describe('restart', () => {
  it('reconstructs queued work untouched and never claims current', async () => {
    const h = harness({ autonomousWorkers: false })
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    await h.coord.sweep() // held by the kill switch, stays queued
    const report = await h.coord.recover()
    expect(report.failed).toEqual([])
    expect(h.jobFor('sf-1')!.state).toBe('queued')
    expect(h.get('sf-1').freshness.phase).toBe('queued')
  })

  it('fails a running job whose worker did not survive, rather than claiming current', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    const job = h.jobFor('sf-1')!
    h.live.clear() // the restart took the tmux server with it
    const report = await h.coord.recover()
    expect(report.failed[0]?.reason).toMatch(/did not survive the restart/)
    expect(h.jobs.get(job.id)!.state).toBe('failed')
    const s = h.get('sf-1')
    expect(s.freshness.phase).toBe('failed')
    expect(s.freshness.verifiedAt).toBe(5_000) // untouched — nothing was verified
  })

  it('adopts ONLY a live matching incarnation', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    const job = h.jobFor('sf-1')!
    // The recorded session name is still live — adopt it and leave the harvest to
    // the ordinary sweep.
    const report = await h.coord.recover()
    expect(report.failed).toEqual([])
    expect(h.jobs.get(job.id)!.state).toBe('running')
    expect(h.get('sf-1').freshness.phase).toBe('refreshing')
  })

  it('refuses to adopt a session that is live but on a DIFFERENT incarnation', async () => {
    // The hazard the docstring has always claimed to close, and which nothing
    // implemented: a session name is reusable, so a live session sharing the name is
    // not evidence that THIS job's worker survived. The launcher built an
    // incarnation all along; the wiring discarded it, so the match was on the name.
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    const job = h.jobFor('sf-1')!
    const target = job.dispatch!.target!
    expect(job.dispatch?.incarnation).toBe(`conv-${job.id}`)

    // The name is live — but it is somebody else now.
    h.incarnations.set(target, 'conv-someone-else')
    const report = await h.coord.recover()
    expect(report.failed[0]?.reason).toMatch(/different incarnation/)
    expect(h.jobs.get(job.id)!.state).toBe('failed')
    expect(h.get('sf-1').freshness.phase).toBe('failed')
    expect(h.get('sf-1').freshness.verifiedAt).toBe(5_000) // nothing was verified
  })

  it('still adopts a job that recorded no incarnation, on liveness alone', async () => {
    // Jobs written before the incarnation was persisted must not be failed for
    // want of a field they never had.
    const h = harness()
    h.launchOutcome = job => ({ ok: true, sessionName: `refresh-${job.id}` })
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    const job = h.jobFor('sf-1')!
    expect(job.dispatch?.incarnation).toBeUndefined()
    const report = await h.coord.recover()
    expect(report.failed).toEqual([])
    expect(h.jobs.get(job.id)!.state).toBe('running')
  })

  it('cancels a job whose Surface is gone', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    await h.coord.sweep()
    h.hidden.add('sf-1')
    const report = await h.coord.recover()
    expect(report.failed[0]?.reason).toMatch(/no longer exists/)
  })
})

describe('the job table', () => {
  it('survives a reopen, so restart recovery has something to recover', async () => {
    const io = memoryIo()
    const a = SurfaceRefreshJobStore.open('/cfg', io)
    a.put({
      id: 'job-1', surfaceId: 'sf-1', spaceId: SPACE, state: 'running',
      reason: { kind: 'git-revision', key: 'k', detail: 'd', generation: 2, at: 1 },
      baseRev: 1, startGeneration: 1, targetGeneration: 2, attempts: 1,
      authorization: { principal: { kind: 'job', id: 'refresh-coordinator' } },
      stagingPath: '/cfg/refresh-staging/job-1.json', createdAt: 1, updatedAt: 1,
    })
    const b = SurfaceRefreshJobStore.open('/cfg', io)
    expect(b.get('job-1')?.state).toBe('running')
    expect(b.active('sf-1')?.id).toBe('job-1')
  })

  it('starts empty rather than throwing on a corrupt table', () => {
    const io = memoryIo()
    io.write('/cfg/surface-refresh-jobs.json', '{ not json')
    expect(SurfaceRefreshJobStore.open('/cfg', io).list()).toEqual([])
  })

  it('stages each job in its own file, outside any worktree', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const job = h.jobFor('sf-1')!
    expect(job.stagingPath).toBe('/cfg/refresh-staging/job-1.json')
    // The property that matters: nothing a worker writes lands where the Slate
    // watcher would find it and project it without passing the barrier.
    expect(job.stagingPath.includes('.tinstar/slate')).toBe(false)
    expect(job.stagingPath.startsWith(WORKTREE)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The shared revalidate step (plan U4, R9-R17, KTD3/KTD9).
//
// THE HEADLINE CLAIM HERE IS A NEGATIVE — "a matching revalidation does not wake an
// agent" — and a negative is satisfied by the bug and the fix alike: nothing is
// dispatched when the witness works, and nothing is dispatched when the scheduler
// never ran. So every test below that asserts an absence also asserts the POSITIVE
// that makes the absence mean something: that the witness actually ran, and that the
// Surface was actually stamped. `h.witnessRuns` and `h.launches`/`h.delivered` are
// read together for that reason.
// ---------------------------------------------------------------------------

describe('a trigger reaches the cheap check first', () => {
  it('revalidates a repo-locus claim on a commit, and schedules nothing when it matches', async () => {
    const h = harness()
    await h.seed(claiming({ stored: { u4: 'landed' } }))
    h.witness = () => sawValue('landed')

    const report = await h.coord.note(gitEvent())
    // The trigger MARKED it — the badge is honest, something did happen — and queued
    // nothing on the strength of the commit alone.
    expect(report.marked).toEqual(['sf-1'])
    expect(report.queued).toEqual([])

    const pass = await h.coord.witnessPass()
    expect(h.witnessRuns).toEqual([{ surfaceId: 'sf-1', claimId: 'u4' }])
    expect(pass.witnessed).toEqual(['sf-1'])
    // 110 of 121 completed refreshes changed nothing, and every one of them was a
    // background agent in the user's worktree. This is that case, ended.
    expect(h.jobs.list()).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.delivered).toEqual([])

    const s = h.get('sf-1')
    expect(s.freshness.phase).toBe('current')
    expect(s.freshness.witnessedAt).toBe(h.clock.now)
    expect(s.freshness).not.toHaveProperty('staleReason')
  })

  it('a Surface with NO claims takes the existing path, untouched', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    const report = await h.coord.note(gitEvent())
    await h.coord.witnessPass()
    // No claims, no narrowing, no witness — a commit still queues the rebuild it
    // always did. This is the regression guard for every Surface that exists today.
    expect(report.queued).toHaveLength(1)
    expect(h.witnessRuns).toEqual([])
  })

  it('does not run a witness for a trigger kind no claim on it observes', async () => {
    const h = harness()
    // `infra` is invalidated by time passing and nothing else, so a commit on the
    // worktree says nothing about whether this card is still right.
    await h.seed(claiming({ claims: [INFRA_CLAIM], stored: { up: 200 }, freshness: { witnessedAt: 9_000 } }))
    await h.coord.note(gitEvent())
    await h.coord.witnessPass()
    expect(h.witnessRuns).toEqual([])
    // The commit still REACHES this Surface and still queues a rebuild, because it
    // carries a recipe and a worktree and therefore the host's default `git-revision`
    // trigger. Narrowing that away is U5's job (a claim-locus predicate in
    // `matchTrigger`); U4's half is only that no witness was spent on a question this
    // Surface's claims cannot answer.
    expect(h.jobs.list()).toHaveLength(1)
  })
})

describe('deadlines a claim earns', () => {
  it('gives a claim-bearing Surface a deadline with no recipe and no periodic trigger', async () => {
    const h = harness()
    // Before this, `effectiveDeclaration` handed a recipe-less Surface an empty
    // trigger list, so `deriveDueAt` returned undefined, so `overdue` could never
    // rise and the phase stayed `current` forever. Nothing in the system could doubt
    // it — which is the hole this plan opened with.
    await h.seed(claiming({ claims: [INFRA_CLAIM], recipe: null, stored: { up: 200 } }))
    h.witness = () => ({ status: 'unresolved', detail: 'the host would not answer' })
    await h.coord.sweep()
    await h.coord.witnessPass()
    expect(h.get('sf-1').freshness.dueAt).toBe(1_000 + 10 * 60_000)

    // Past the deadline, with a witness that cannot answer — so `overdue` is observed
    // rising on its own rather than being read in a race with the pass that clears it.
    h.clock.now = 2_000_000
    await h.coord.sweep()
    await h.coord.witnessPass()
    expect(h.get('sf-1').freshness.overdue).toBe(true)
    expect(h.get('sf-1').freshness).not.toHaveProperty('witnessedAt')

    h.clock.now += 10 * 60_000
    h.witness = () => sawValue(200)
    await h.coord.sweep()
    const pass = await h.coord.witnessPass()
    // And the deadline it earned is answered by the cheap check, not by a job it has
    // no recipe to run.
    expect(pass.witnessed).toEqual(['sf-1'])
    expect(h.get('sf-1').freshness.overdue).toBe(false)
    expect(h.jobs.list()).toEqual([])
  })

  it('counts the deadline from witnessedAt, so an author saving the file cannot push it out', async () => {
    const h = harness()
    await h.seed(claiming({ stored: { u4: 'landed' }, freshness: { witnessedAt: 5_000 } }))
    await h.coord.sweep()
    expect(h.get('sf-1').freshness.dueAt).toBe(5_000 + 10 * 60_000)

    // What a file save does: `observeSource` writes `verifiedAt` on every save whose
    // watermark moved, and touches `witnessedAt` never (KTD7). If the deadline were
    // based on `verifiedAt`, the more actively a card was edited the less often
    // anything would check whether it was still TRUE.
    await h.seed(claiming({
      stored: { u4: 'landed' },
      freshness: { witnessedAt: 5_000, verifiedAt: 500_000 },
    }))
    await h.coord.sweep()
    expect(h.get('sf-1').freshness.dueAt).toBe(5_000 + 10 * 60_000)
  })

  it('stamps a due Surface witnessed without dispatching anything', async () => {
    const h = harness()
    await h.seed(claiming({ stored: { u4: 'landed' }, freshness: { witnessedAt: 5_000 } }))
    h.witness = () => sawValue('landed')
    h.clock.now = 5_000 + 10 * 60_000 + 1

    await h.coord.sweep()
    const pass = await h.coord.witnessPass()
    expect(h.witnessRuns).toEqual([{ surfaceId: 'sf-1', claimId: 'u4' }])
    expect(pass.witnessed).toEqual(['sf-1'])
    // The dispatch layer is stubbed precisely so "would have dispatched" is
    // observable, and the two sweeps below are what make the absence mean something:
    // a moved value records a debt that the NEXT sweep drains into a job and the one
    // after that dispatches. Inverting the comparison in `witnessMatches` turns this
    // Surface's match into a move and lights all four assertions up.
    const witnessedAt = h.clock.now
    for (const step of [5_000, 5_000]) {
      h.clock.now += step
      await h.coord.sweep()
    }
    expect(h.launches).toEqual([])
    expect(h.delivered).toEqual([])
    expect(h.jobs.list()).toEqual([])

    const s = h.get('sf-1')
    expect(s.freshness.witnessedAt).toBe(witnessedAt)
    expect(s.freshness.overdue).toBe(false)
    expect(s.freshness.phase).toBe('current')
  })
})

describe('witnesses run outside the lock', () => {
  it('does not delay harvest, dispatch, or a manual refresh press', async () => {
    const h = harness()
    await h.seed(claiming({ id: 'sf-claim', stored: { u4: 'landed' } }))
    await h.seed({ id: 'sf-plain', ...withPolicy(AUTOMATIC) })

    let started: () => void = () => {}
    const witnessStarted = new Promise<void>(resolve => { started = resolve })
    let finish: (o: WitnessOutcome) => void = () => {}
    const blocked = new Promise<WitnessOutcome>(resolve => { finish = resolve })
    h.witness = () => { started(); return blocked }

    await h.coord.sweep()
    await witnessStarted

    // THE WHOLE UNIT, IN THREE LINES. A witness is in flight and has not answered.
    // If it were awaited inside the coordinator's serialization key, neither of the
    // calls below could resolve — so the failure mode of this test is a TIMEOUT, not
    // an assertion, and that is the strongest form the guarantee has.
    const job = await h.coord.requestFor('sf-plain')
    expect(job).toBeDefined()
    const second = await h.coord.sweep()
    expect(second.dispatched).toEqual([job!.id])
    expect(h.launches).toHaveLength(1)

    finish(sawValue('landed'))
    const pass = await h.coord.witnessPass()
    expect(pass.witnessed).toEqual(['sf-claim'])
  })

  it('bounds how many Surfaces one pass looks at', async () => {
    const h = harness()
    for (let i = 0; i < WITNESS_BUDGET_PER_PASS + 4; i++) {
      await h.seed(claiming({ id: `sf-${i}` }))
    }
    h.witness = () => sawValue('landed')

    await h.coord.sweep()
    await h.coord.witnessPass()
    // A hundred Surfaces going due at once must not become a hundred subprocesses.
    expect(new Set(h.witnessRuns.map(r => r.surfaceId)).size).toBe(WITNESS_BUDGET_PER_PASS)

    // And the remainder is not lost — it is the next pass's work.
    h.clock.now += 5_000
    await h.coord.sweep()
    await h.coord.witnessPass()
    expect(new Set(h.witnessRuns.map(r => r.surfaceId)).size).toBe(WITNESS_BUDGET_PER_PASS + 4)
  })

  it('does not commit a result for a Surface deleted while its witness ran', async () => {
    const h = harness()
    await h.seed(claiming({ stored: { u4: 'landed' } }))
    // Captured at the instant of the deletion rather than before the sweep: the
    // locked pass legitimately writes (a schedule, a stale mark), and the claim under
    // test is that the COMMIT writes nothing after that.
    let revWhenDeleted = 0
    h.witness = () => {
      // Deleted between collect and commit, which is the window the re-check exists
      // for: `hidden` is how this harness expresses a Surface that is gone.
      h.hidden.add('sf-1')
      revWhenDeleted = h.docStore.getSurface('sf-1')!.rev
      return sawValue('pending')
    }

    h.clock.now = 5_000 + 10 * 60_000 + 1
    await h.coord.sweep()
    const pass = await h.coord.witnessPass()
    expect(h.witnessRuns).toHaveLength(1)
    expect(pass.moved).toEqual([])
    const s = h.docStore.getSurface('sf-1')!
    expect(s.rev).toBe(revWhenDeleted)
    expect(s.freshness).not.toHaveProperty('claimRebuild')
    expect(s.freshness.claimObservations).toEqual({ u4: { value: 'landed', at: 5_000 } })
  })

  it('does not store a result computed against a claim the author has since edited', async () => {
    const h = harness()
    await h.seed(claiming({ stored: { u4: 'landed' } }))
    h.witness = async () => {
      // The author retargets the claim at a different unit while the witness runs.
      // The answer in flight is about the OLD question.
      await h.seed(claiming({
        stored: { u4: 'landed' },
        claims: [{ ...REPO_CLAIM, params: { ...REPO_CLAIM.params, unit: 'U7' } }],
      }))
      return sawValue('pending')
    }

    h.clock.now = 5_000 + 10 * 60_000 + 1
    await h.coord.sweep()
    const pass = await h.coord.witnessPass()
    expect(pass.moved).toEqual([])
    // Storing it would have reported a value that moved when nothing in the world did.
    expect(h.get('sf-1').freshness.claimObservations).toEqual({ u4: { value: 'landed', at: 5_000 } })
  })

  it('backs a claim nobody can resolve off to the verification interval', async () => {
    const h = harness()
    await h.seed(claiming({ stored: { u4: 'landed' }, freshness: { witnessedAt: 5_000 } }))
    h.witness = () => ({ status: 'unresolved', detail: 'could not fetch origin/main' })
    h.clock.now = 5_000 + 10 * 60_000 + 1

    await h.coord.sweep()
    const first = await h.coord.witnessPass()
    expect(first.unresolved).toEqual([{ surfaceId: 'sf-1', claimId: 'u4' }])
    expect(first.witnessed).toEqual([])

    // An unresolved outcome never advances `witnessedAt`, so the deadline test says
    // "due" forever. Without a cooldown that is a `git fetch` every five seconds, on
    // the same one-interval-of-quiet rule a failed rebuild already gets.
    for (const step of [5_000, 5_000, 5_000]) {
      h.clock.now += step
      await h.coord.sweep()
      await h.coord.witnessPass()
    }
    expect(h.witnessRuns).toHaveLength(1)

    h.clock.now += 10 * 60_000
    await h.coord.sweep()
    await h.coord.witnessPass()
    expect(h.witnessRuns).toHaveLength(2)
    // And at no point did a claim nobody could check wake an agent.
    expect(h.jobs.list()).toEqual([])
    expect(h.get('sf-1').freshness.witnessedAt).toBe(5_000)
  })
})

describe('a moved value', () => {
  it('records the delta and queues exactly one rebuild when there is a recipe', async () => {
    const h = harness()
    await h.seed(claiming({ stored: { u4: 'landed' }, freshness: { witnessedAt: 5_000 } }))
    h.witness = () => sawValue('pending')
    h.clock.now = 5_000 + 10 * 60_000 + 1

    await h.coord.sweep()
    const pass = await h.coord.witnessPass()
    expect(pass.moved).toEqual([{ surfaceId: 'sf-1', claimId: 'u4' }])
    // R11: which claim moved and BOTH values, before any rebuild runs.
    expect(h.get('sf-1').freshness.claimRebuild).toEqual({
      moves: [{ claimId: 'u4', from: 'landed', to: 'pending' }],
      at: h.clock.now,
    })
    expect(h.get('sf-1').freshness.phase).toBe('possibly-stale')
    expect(h.get('sf-1').freshness.staleReason?.detail).toMatch(/no longer holds: u4 was landed, now pending/)

    h.clock.now += 5_000
    const drained = await h.coord.sweep()
    expect(drained.queued).toHaveLength(1)
    // And exactly one, however many sweeps run: the marker survives until the rebuild
    // lands, and the active job is what stops a second being made.
    h.clock.now += 5_000
    await h.coord.sweep()
    h.clock.now += 5_000
    await h.coord.sweep()
    expect(h.jobs.list()).toHaveLength(1)
  })

  it('marks a recipe-LESS Surface stale and queues nothing', async () => {
    const h = harness()
    await h.seed(claiming({ recipe: null, stored: { u4: 'landed' }, freshness: { witnessedAt: 5_000 } }))
    h.witness = () => sawValue('pending')
    h.clock.now = 5_000 + 10 * 60_000 + 1

    await h.coord.sweep()
    await h.coord.witnessPass()
    for (const step of [5_000, 5_000]) {
      h.clock.now += step
      await h.coord.sweep()
    }
    // `launchWorker` answers a recipe-less Surface with "this Surface declares no
    // refresh recipe", so a rebuild dispatched here would land it in `failed` and
    // retry forever. R12: the delta is recorded, the badge is honest, nothing runs.
    expect(h.jobs.list()).toEqual([])
    expect(h.launches).toEqual([])
    expect(h.delivered).toEqual([])
    const s = h.get('sf-1')
    expect(s.freshness.claimRebuild!.moves).toEqual([{ claimId: 'u4', from: 'landed', to: 'pending' }])
    expect(s.freshness.phase).toBe('possibly-stale')
  })

  it('still rebuilds after a restart between the delta and the job', async () => {
    const h = harness()
    // A record as it survived the crash: the delta and the marker committed together,
    // and no job was ever written. Two commits instead of one would have lost this.
    await h.seed(claiming({
      stored: { u4: 'pending' },
      freshness: {
        phase: 'possibly-stale',
        witnessedAt: 5_000,
        claimRebuild: { moves: [{ claimId: 'u4', from: 'landed', to: 'pending' }], at: 6_000 },
        staleReason: {
          kind: 'git-revision', key: 'claim-moved sf-1 u4=pending',
          detail: 'a claim it makes no longer holds: u4 was landed, now pending',
          generation: 1, at: 6_000,
        },
      },
    }))
    // The world now AGREES with the stored value, which is exactly why the marker has
    // to be durable: every look from here on matches, so nothing about the observation
    // could ever re-derive that a rebuild is owed.
    h.witness = () => sawValue('pending')

    await h.coord.recover()
    const report = await h.coord.sweep()
    expect(report.queued).toHaveLength(1)
    expect(h.jobFor('sf-1')!.state).toBe('running')
  })

  it('holds a debt whose last rebuild FAILED for one verification interval', async () => {
    const h = harness()
    await h.seed(claiming({
      stored: { u4: 'pending' },
      freshness: {
        phase: 'failed',
        witnessedAt: 5_000,
        failure: { message: 'the recipe exited 1', at: 9_000 },
        claimRebuild: { moves: [{ claimId: 'u4', from: 'landed', to: 'pending' }], at: 6_000 },
      },
    }))
    h.witness = () => sawValue('pending')

    // A debt that cannot be paid must not retry at sweep cadence: `claimRebuild` sits
    // there until a rebuild consumes it, so without this the same broken recipe would
    // launch a real background agent in the user's worktree every five seconds.
    for (const step of [5_000, 5_000, 5_000]) {
      h.clock.now += step
      await h.coord.sweep()
    }
    expect(h.jobs.list()).toEqual([])

    h.clock.now = 9_000 + 10 * 60_000
    const late = await h.coord.sweep()
    expect(late.queued).toHaveLength(1)
  })

  it('clears the rebuild debt only when the rebuild itself lands', async () => {
    const h = harness()
    await h.seed(claiming({
      stored: { u4: 'pending' },
      freshness: {
        phase: 'possibly-stale',
        witnessedAt: 5_000,
        claimRebuild: { moves: [{ claimId: 'u4', from: 'landed', to: 'pending' }], at: 6_000 },
      },
    }))
    h.witness = () => sawValue('pending')
    await h.coord.sweep()
    const job = h.jobFor('sf-1')!
    h.staged.set(job.stagingPath, workerJson({ headline: 'Roadmap', note: 'unit U4 is pending' }))
    h.clock.now += 5_000
    const done = await h.coord.sweep()

    expect(done.completed).toEqual([job.id])
    const s = h.get('sf-1')
    expect(s.freshness).not.toHaveProperty('claimRebuild')
    expect(s.freshness.phase).toBe('current')
    // The witness state SURVIVES the rebuild. Rebuilding freshness from scratch here
    // dropped both, so a just-rebuilt card reported no witness age and its claims went
    // back to never-observed — two more passes before anything could be verified again.
    expect(s.freshness.witnessedAt).toBe(5_000)
    expect(s.freshness.claimObservations).toEqual({ u4: { value: 'pending', at: 5_000 } })
    expect(s.content.claims).toEqual([REPO_CLAIM])
  })
})

describe('the owner-delivery budget (KTD9)', () => {
  it('bounds one pass, and drains the rest on the next', async () => {
    const h = harness()
    h.live.add(RUN)
    for (let i = 0; i < 10; i++) {
      await h.seed(claiming({
        id: `sf-${i}`,
        stored: { u4: 'pending' },
        freshness: {
          phase: 'possibly-stale',
          witnessedAt: 5_000,
          claimRebuild: { moves: [{ claimId: 'u4', from: 'landed', to: 'pending' }], at: 6_000 },
        },
      }))
    }
    h.witness = () => sawValue('pending')

    const first = await h.coord.sweep()
    expect(first.queued).toHaveLength(10)
    // `runningWorkerCount()` counts only worker dispatches and every one of the 175
    // jobs in the live table dispatched as `owner`, so the existing cap would have
    // gated against a constant zero. Ten Surfaces bound to one worktree became ten
    // prompts into one working session; this is the bound that stops that.
    expect(first.dispatched).toHaveLength(OWNER_DELIVERIES_PER_PASS)
    expect(h.delivered).toHaveLength(OWNER_DELIVERIES_PER_PASS)
    expect(first.heldByCap).toHaveLength(10 - OWNER_DELIVERIES_PER_PASS)

    // Held, not dropped: the queue is durable and the next sweep is five seconds away.
    h.clock.now += 5_000
    await h.coord.sweep()
    expect(h.delivered).toHaveLength(OWNER_DELIVERIES_PER_PASS * 2)
    // And no background worker was launched for any of them — owner delivery is still
    // the preferred path, it is just bounded now.
    expect(h.launches).toEqual([])
  })
})

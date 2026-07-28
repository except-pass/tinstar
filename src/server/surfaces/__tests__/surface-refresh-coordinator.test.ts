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
  SurfaceRefreshCoordinator,
  type RefreshCoordinatorConfig,
  type RefreshCoordinatorDeps,
  type StagedRefreshResult,
  type WorkerLaunch,
} from '../surface-refresh-coordinator'
import type { Surface, SurfaceRefreshDeclaration } from '../../../domain/types'
import type { SurfaceTriggerEvent } from '../surface-trigger-matcher'

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
  staged: Map<string, StagedRefreshResult>
  hidden: Set<string>
  launches: string[]
  retired: string[]
  delivered: { sessionName: string; prompt: string }[]
  launchOutcome: (job: SurfaceRefreshJob) => WorkerLaunch
  observe: (surface: Surface) => Promise<void>
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
    staged: new Map<string, StagedRefreshResult>(),
    hidden: new Set<string>(),
    launches: [],
    retired: [],
    delivered: [],
    launchOutcome: (job) => ({ ok: true, sessionName: `refresh-${job.id}` }),
    observe: async () => { /* the default barrier finds nothing new */ },
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
    launchWorker: async ({ job }) => {
      const outcome = h.launchOutcome!(job)
      if (outcome.ok) {
        h.launches!.push(outcome.sessionName)
        h.live!.add(outcome.sessionName)
      }
      return outcome
    },
    retireWorker: async name => { h.retired!.push(name); h.live!.delete(name) },
    readStaged: async path => h.staged!.get(path) ?? null,
    clearStaged: async path => { h.staged!.delete(path) },
    observeSources: s => h.observe!(s),
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

function gitEvent(over: Partial<SurfaceTriggerEvent> = {}): SurfaceTriggerEvent {
  return { kind: 'git-revision', sourceId: WORKTREE, worktree: WORKTREE, evidence: 'sha-1', at: 20_000, ...over }
}

const AUTOMATIC: SurfaceRefreshDeclaration = { policy: 'automatic', triggers: ['git-revision'] }
const MARK_STALE: SurfaceRefreshDeclaration = { policy: 'mark-stale', triggers: ['git-revision'] }
const MANUAL: SurfaceRefreshDeclaration = { policy: 'manual', triggers: ['git-revision'] }

function withPolicy(decl: SurfaceRefreshDeclaration): Partial<Surface> {
  return { content: { headline: 'Coverage', recipe: 'Re-run coverage.', refreshPolicy: decl } }
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

  it('two sweeps cannot both take one queued job', async () => {
    const h = harness()
    await h.seed(withPolicy(AUTOMATIC))
    await h.coord.note(gitEvent())
    const [a, b] = await Promise.all([h.coord.sweep(), h.coord.sweep()])
    // Exactly one dispatch across both passes: `beginRefresh` is a compare-and-swap
    // on the Surface revision, so the loser finds it no longer queued.
    expect(a.dispatched.length + b.dispatched.length).toBe(1)
    expect(h.launches).toHaveLength(1)
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
    h.staged.set(job.stagingPath, { content: { headline: 'Coverage 92%', recipe: 'Re-run coverage.' } })
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
    // The worker session was retired, and its staged artifact consumed.
    expect(h.retired).toEqual([`refresh-${job.id}`])
    expect(h.staged.size).toBe(0)
  })

  it('a newer event DURING execution supersedes the result and keeps the Surface pending', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    // The world moves while the worker runs.
    h.clock.now = 25_000
    await h.coord.note(gitEvent({ evidence: 'sha-2', at: 25_000 }))
    expect(h.get('sf-1').freshness.phase).toBe('refreshing')

    h.staged.set(job.stagingPath, { content: { headline: 'Coverage 92%' } })
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
    h.staged.set(job.stagingPath, { content: { headline: 'Coverage 92%' } })
    h.clock.now = 30_000
    const report = await h.coord.sweep()
    expect(report.superseded).toEqual([job.id])
    expect(h.get('sf-1').freshness.phase).not.toBe('current')
    expect(h.get('sf-1').content.headline).toBe('Coverage')
  })

  it('a byte-identical regeneration completes explicitly rather than spinning forever', async () => {
    const h = await dispatched()
    const job = h.jobFor('sf-1')!
    const before = h.get('sf-1').amendedAt
    // The worker looked and found nothing to change. That still has to COMPLETE:
    // "nothing changed" and "still running" look identical to a spinner.
    h.staged.set(job.stagingPath, { note: 'no change since the last run' })
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
    h.staged.set(job.stagingPath, { error: 'the coverage tool is not installed' })
    const report = await h.coord.sweep()
    expect(report.failed[0]?.reason).toMatch(/not installed/)
    expect(h.get('sf-1').freshness.phase).toBe('failed')
    expect(h.retired).toEqual([`refresh-${job.id}`])
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
    h.staged.set(job.stagingPath, { error: 'boom' })
    await h.coord.sweep()
    const s = h.get('sf-1')
    expect(s.freshness.overdue).toBe(true)
    expect(s.freshness.staleReason?.kind).toBe('git-revision')
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
    h.staged.set(job.stagingPath, { content: { headline: 'Coverage 92%' } })
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

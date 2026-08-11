// @vitest-environment node
//
// THE PROOF THAT THE RETIRED ARCHITECTURE CANNOT COME BACK UNNOTICED (plan U7, R19).
//
// Two halves, and both are needed. The STATIC half greps the shipped source for the
// symbols the removed design was made of: a name that reappears is a capability that
// reappeared, and no behavioural test can see that until something calls it. The
// BEHAVIOURAL half runs the real coordinator over a fleet of dirty Surfaces through
// repeated sweeps and asserts that nothing was delivered, no session seam exists to
// call, and no attempt was created.
//
// WHY A STRESS FIXTURE RATHER THAN ONE SURFACE. The failure this replaces was never
// visible on one card. It was linear in fleet size — a commit reached every Surface
// bound to that worktree — so the only fixture that would have caught it is one with
// a fleet in it. Fifty Surfaces, ten sweeps, twelve simulated hours.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DocumentStore } from '../../stores/document-store'
import { SurfaceService } from '../surface-service'
import { SurfaceRefreshJobStore, type JobStoreIo } from '../surface-refresh-jobs'
import { SurfaceRefreshCoordinator, type RefreshCoordinatorDeps } from '../surface-refresh-coordinator'
import { collectRefreshDiagnostics } from '../../stores/surface-diagnostics'
import type { Surface } from '../../../domain/types'

const SPACE = 'spc-storm'
const WORKTREE = '/tmp/wt/storm'
const RUN = 'run-storm'

// --- The static half ---------------------------------------------------------

/**
 * Symbols the removed autonomous-worker architecture was made of.
 *
 * A reappearance here is not a style violation — it is the capability itself. The
 * plan's own safety gate greps for exactly these, and encoding it as a test is what
 * makes it run on every CI instead of when somebody remembers.
 */
const RETIRED_SYMBOLS = [
  'launchRefreshWorker',
  'retireRefreshWorker',
  'refreshPortWindow',
  'runningWorkerCount',
  'maxConcurrentWorkers',
  'autonomousWorkers',
] as const

/** Every shipped `.ts`/`.tsx` under `src/`, excluding tests — a test naming a retired
 *  symbol to prove it is gone is the one legitimate mention. */
function shippedSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      shippedSources(path, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

/** Strip line and block comments. The retired design is DISCUSSED in several headers
 *  — deliberately, because "this used to exist and here is why it does not" is the
 *  most useful thing those files can say — and a check that could not tell a comment
 *  from a call would force those explanations out. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the retired worker architecture is gone from the shipped source (R19)', () => {
  const files = shippedSources('src')

  it.each(RETIRED_SYMBOLS)('no shipped code references %s', symbol => {
    const offenders = files.filter(f => codeOnly(readFileSync(f, 'utf8')).includes(symbol))
    expect(
      offenders,
      `"${symbol}" is back in shipped code. It belonged to the architecture that gave every `
      + 'automatic refresh a managed session, a tmux pane, and a ttyd port. If this is '
      + 'deliberate, the plan\'s no-session invariant needs revisiting first — not this test.',
    ).toEqual([])
  })

  it('the check can actually fail — it is looking at real files with real content', () => {
    // A grep over an empty file list passes forever. This is the guard on the guard.
    expect(files.length).toBeGreaterThan(200)
    expect(files.some(f => f.endsWith('surface-refresh-coordinator.ts'))).toBe(true)
    expect(files.some(f => codeOnly(readFileSync(f, 'utf8')).includes('deliverToOwner'))).toBe(true)
  })
})

// --- The behavioural half ----------------------------------------------------

function memoryIo(): JobStoreIo {
  const files = new Map<string, string>()
  return {
    read: p => files.get(p) ?? null,
    write: (p, d) => { files.set(p, d) },
    mkdir: () => { /* nothing to make in memory */ },
  }
}

function fleet(docStore: DocumentStore, count: number): void {
  const surfaces: Surface[] = Array.from({ length: count }, (_, i) => ({
    id: `sf-${i}`,
    spaceId: SPACE,
    home: { kind: 'canvas', spaceId: SPACE },
    content: {
      headline: `Card ${i}`,
      // AGENT recipes, every one. This is the population that used to become a
      // background session each; a host recipe would be answering a different question.
      recipe: { kind: 'agent', prompt: 'Re-derive this card from its sources.' },
      refreshPolicy: { policy: 'automatic', triggers: ['git-revision', 'periodic'], intervalMs: 60_000 },
    },
    contentAuthority: 'canonical-direct',
    author: 'agent',
    provenance: { runId: RUN, worktreeId: WORKTREE },
    source: { adapter: 'slate-file', locator: `file:c${i}.json#c`, worktree: WORKTREE, generation: 1 },
    thread: { replies: [], status: 'open' },
    freshness: {
      phase: 'current', overdue: false, observedGeneration: 1, verifiedAt: 1_000,
      lastKnownAt: 1_000, lastCheck: null,
    },
    rev: 1,
    homeRev: 1,
    createdAt: 1_000,
    amendedAt: 1_000,
  } as Surface))
  docStore.loadSurfaces(surfaces)
}

describe('a fleet of dirty agent Surfaces produces no work at all (AE3)', () => {
  it('fifty surfaces, twelve simulated hours, zero prompts and zero attempts', async () => {
    const docStore = new DocumentStore()
    const svc = new SurfaceService(docStore)
    const jobs = SurfaceRefreshJobStore.open('/cfg', memoryIo())
    const clock = { now: 10_000 }
    const delivered: string[] = []
    const hostRuns: string[] = []
    let n = 0

    const deps: RefreshCoordinatorDeps = {
      service: svc,
      jobs,
      surfaces: () => docStore.getAllSurfaces(),
      config: () => ({ attemptTimeoutMs: 60_000, defaultIntervalMs: 10 * 60_000 }),
      now: () => clock.now,
      newJobId: () => `job-${++n}`,
      deliverToOwner: async ({ sessionName }) => { delivered.push(sessionName); return true },
      // LIVE, deliberately. A negative that only holds because there was nobody to
      // talk to proves nothing — the agent is right there and is still not disturbed.
      isLiveSession: () => true,
      readStaged: async () => null,
      clearStaged: async () => {},
      observeSources: async () => {},
      buildPrompt: () => 'rebuild it',
      runWitness: async () => ({ status: 'unresolved', detail: 'no witnesses in this fixture' }),
      runHostRecipe: async ({ surface }) => { hostRuns.push(surface.id); return { status: 'unchanged' } },
    }
    const coord = new SurfaceRefreshCoordinator(deps)
    fleet(docStore, 50)

    // Twelve hours of everything the host can do on its own: the sweep timer, the git
    // poll, the periodic trigger, restart recovery.
    for (let hour = 0; hour < 12; hour++) {
      clock.now += 60 * 60_000
      await coord.sweep()
      await coord.note({ kind: 'git-revision', sourceId: WORKTREE, worktree: WORKTREE, evidence: `sha-${hour}`, at: clock.now })
      await coord.note({ kind: 'periodic', sourceId: 'clock', at: clock.now })
      await coord.witnessPass()
      if (hour === 6) await coord.recover()
    }

    // NOTHING WAS DELIVERED, NOTHING WAS RUN, AND NOTHING WAS EVEN QUEUED.
    expect(delivered).toEqual([])
    expect(hostRuns).toEqual([])
    expect(jobs.list()).toEqual([])

    // THE SURFACES ARE ALL HONESTLY DIRTY, which is the other half of the deal: the
    // host did no work AND did not pretend the cards were current.
    const all = docStore.getAllSurfaces()
    expect(all).toHaveLength(50)
    expect(all.every(s => s.freshness.phase === 'possibly-stale')).toBe(true)
    // …and every one still shows what it last knew (R4).
    expect(all.every(s => s.content.headline.startsWith('Card '))).toBe(true)

    // THE DIAGNOSTIC AGREES, which is what makes this observable to an operator
    // rather than only to this test.
    const d = collectRefreshDiagnostics({ surfaces: all, jobs: jobs.list(), now: clock.now })
    expect(d.corruption).toEqual([])
    expect(d.refreshCreatedSessions).toBe(0)
    expect(d.dirty).toBe(50)
    expect(d.dirtyAwaitingHuman).toBe(50)
    expect(d.activeOwnerAttempts).toBe(0)
    expect(d.activeHostAttempts).toBe(0)
  })

  it('one human opening one card produces exactly one prompt, for that card', async () => {
    // Without this the test above passes on a harness that cannot deliver at all.
    const docStore = new DocumentStore()
    const jobs = SurfaceRefreshJobStore.open('/cfg', memoryIo())
    const clock = { now: 10_000 }
    const delivered: string[] = []
    let n = 0
    const coord = new SurfaceRefreshCoordinator({
      service: new SurfaceService(docStore),
      jobs,
      surfaces: () => docStore.getAllSurfaces(),
      config: () => ({ attemptTimeoutMs: 60_000, defaultIntervalMs: 10 * 60_000 }),
      now: () => clock.now,
      newJobId: () => `job-${++n}`,
      deliverToOwner: async ({ sessionName }) => { delivered.push(sessionName); return true },
      isLiveSession: () => true,
      readStaged: async () => null,
      clearStaged: async () => {},
      observeSources: async () => {},
      buildPrompt: () => 'rebuild it',
      runWitness: async () => ({ status: 'unresolved', detail: 'none' }),
      runHostRecipe: async () => ({ status: 'unchanged' }),
    })
    fleet(docStore, 50)
    await coord.note({ kind: 'git-revision', sourceId: WORKTREE, worktree: WORKTREE, evidence: 'sha', at: clock.now })

    await coord.humanIntent('sf-7')
    await coord.sweep()

    expect(delivered).toEqual([RUN])
    expect(jobs.list()).toHaveLength(1)
    expect(jobs.list()[0]!.surfaceId).toBe('sf-7')
    // The other forty-nine are untouched, which is the property that used to fail.
    expect(docStore.getAllSurfaces().filter(s => s.freshness.phase === 'refreshing')).toHaveLength(1)
  })
})

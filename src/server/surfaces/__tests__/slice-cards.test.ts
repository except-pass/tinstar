// @vitest-environment jsdom
//
// The slice's own two surfaces, end to end (plan U8, R20/R21/R22/R23).
//
// EVERY LAYER HERE IS THE SHIPPED ONE. The two cards are written as `.tinstar/slate/
// *.json` files into a real temp worktree and travel the whole chain:
//
//   file → SlateWatcher (real fs) → reconcileSlateEpoch → SurfaceService
//        → DocumentStore → SurfaceRefreshCoordinator → runWitness (real `git`)
//        → recordWitnessResult → slateSurfaceFromCanonical → A2uiRenderer
//
// `slate-source.test.ts` states the reason in the file's own words — "an entry shaped
// by hand is a shape nothing upstream emits, so a test using one proves agreement
// with a contract that does not exist" — and the coordinator's harness repeats it for
// the staged-result parser. This file honours it at the WHOLE-CHAIN level: nothing in
// here hand-builds a `Surface`, a `SlateSourceEntry`, or a `WitnessOutcome`. The two
// exceptions are the two things that genuinely leave the process, and only one of
// them is stubbed: `git` runs for real against a local bare remote, and `fetch` is a
// counted stub, because a unit test may not make a network call and an http-status
// witness with no host to talk to would only ever be able to prove `unresolved`.
//
// THE REPOSITORY IS A FIXTURE, NOT THIS ONE. CI checks out at depth 1 with no usable
// `origin/main`, so a test reading the real repo would pass here and fail there. The
// fixture is built the way U2 built its own: a temp bare remote plus a clone, with
// commit subjects copied verbatim out of this repository's history — including the
// `(U1, part 1)` / `(U1e)` pair that falsifies subject-line matching. The backfill
// map the witness consults is the SHIPPED one, so the merge state these cards report
// is the merge state of the real plan.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { A2uiRenderer } from '../../../a2ui/A2uiRenderer'
import { SurfaceAge } from '../../../components/RunWorkspaceWidget/SurfaceAge'
import { DocumentStore } from '../../stores/document-store'
import { SlateWatcher, type SlateFs, type SlateTimers } from '../../sessions/slate-watcher'
import { execCommand } from '../../infra/execCommand'
import { SurfaceService, type SurfaceCallContext } from '../surface-service'
import { SurfaceRefreshJobStore, type JobStoreIo } from '../surface-refresh-jobs'
import {
  SurfaceRefreshCoordinator,
  type RefreshCoordinatorConfig,
  type RefreshCoordinatorDeps,
} from '../surface-refresh-coordinator'
import { refreshDispatchPrompt } from '../refresh-wiring'
import { reconcileSlateEpoch, type SlateSourceEpoch } from '../source-reconciler'
import { slateSourceAdapters } from '../slate-source'
import { claimLocusAdmits } from '../surface-trigger-matcher'
import { runWitness, type WitnessDeps } from '../witness-registry'
import type { SlateSurface, Surface } from '../../../domain/types'

// --- the two authored cards --------------------------------------------------

/**
 * The plan the roadmap card tracks, and why it is not the plan that ships this card.
 *
 * This branch's own plan is not pushed anywhere, and the `unit-landed` witness
 * ADVANCES a remote ref before reading it — so every unit of the plan being written
 * would read `unresolved` or `pending` and the card would demonstrate nothing. The
 * recursive-collaborative-surfaces plan is the honest subject: four of its eight
 * units are genuinely on `main` and four genuinely are not, so some rows say done
 * because they are and some say pending because they are.
 */
const TRACKED_PLAN = 'docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md'

/** The unit labels, in plan order, with what actually happened to each. Kept beside
 *  the card rather than inside it so the expectation is stated once. */
const UNITS: { unit: string; label: string; landed: boolean }[] = [
  { unit: 'U1', label: 'U1 · canonical Surface model + crash-safe sidecar', landed: true },
  { unit: 'U2', label: 'U2 · per-source reconciliation, Run.slate derives', landed: true },
  { unit: 'U3', label: 'U3 · mutation service, recoverable deletion, agent parity', landed: true },
  { unit: 'U4', label: 'U4 · recursive Canvas workspace + per-actor view state', landed: false },
  { unit: 'U5', label: 'U5 · contextual prompts and contributor drill-down', landed: false },
  { unit: 'U6', label: 'U6 · durable trigger and refresh engine', landed: true },
  { unit: 'U7', label: 'U7 · presence, bounded activity, the Attention Rail', landed: false },
  { unit: 'U8', label: 'U8 · promotion rollout and compatibility proof', landed: false },
]

/**
 * The roadmap card, exactly as an author writes it into `.tinstar/slate/`.
 *
 * ONE REPO-LOCUS CLAIM PER UNIT (R20), and every step's status is BOUND to one of
 * them by id (R22) — `claim` names the claim, `done` names the observed value that
 * means finished. Nothing in the body states a status; there is nothing for an agent
 * to keep up to date, and nothing it could get wrong.
 *
 * A `host` RECIPE, and that is what licenses the rail to correct itself (KTD7). The
 * host may write part of a card only when it owns that card's rebuild outright and
 * returns the whole thing — which is exactly what a machine-only `unit-landed` check
 * does. An AGENT recipe here would be the forbidden shape: the agent would own the
 * prose while the host silently edited the rail underneath it, leaving one card
 * saying two things with nothing marking which half was older.
 *
 * No agent is woken either way. A landing does not make this card false — the rail
 * re-derives itself from the new value — so there is nothing for a prompt to do.
 */
function roadmapCard(): Record<string, unknown> {
  return {
    id: 'recursive-surfaces-roadmap',
    headline: 'Recursive collaborative surfaces — what has actually landed',
    author: 'agent',
    refresh: { kind: 'host', handler: 'unit-landed' },
    claims: UNITS.map(u => ({
      id: u.unit.toLowerCase(),
      witness: 'unit-landed',
      locus: 'repo',
      params: { plan: TRACKED_PLAN, unit: u.unit },
    })),
    content: {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['title', 'rail', 'note'] },
        { id: 'title', component: 'Text', variant: 'h4', text: 'Recursive collaborative surfaces' },
        {
          id: 'rail',
          component: 'Stepper',
          steps: UNITS.map(u => ({ label: u.label, claim: u.unit.toLowerCase(), done: 'landed' })),
        },
        {
          id: 'note',
          component: 'Text',
          variant: 'caption',
          text: 'Each row is the host\'s own reading of the tracked remote ref. No agent writes these.',
        },
      ],
    },
  }
}

/**
 * The infra card: ONE http-status claim (R20), pointed at something local, stable,
 * and free to poll.
 *
 * The standalone's own API is the right target for a RECURRING UNATTENDED witness.
 * An external host would make a card on somebody's canvas into a periodic request
 * against a service that never agreed to it — and if this one is down, that is
 * genuinely worth knowing.
 */
function infraCard(url: string): Record<string, unknown> {
  return {
    id: 'standalone-api-reachable',
    headline: 'The standalone backend answers its own API',
    author: 'agent',
    claims: [{ id: 'api', witness: 'http-status', locus: 'infra', params: { url } }],
    content: {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['what'] },
        {
          id: 'what',
          component: 'Text',
          text: `A GET of ${url} answers 200. A different status code is a moved value, not an outage report.`,
        },
      ],
    },
  }
}

/** Where the infra card points. Loopback and the standalone's own port — never a
 *  host outside this machine. */
const LOCAL_API = 'http://127.0.0.1:5273/api/state'

// --- the fixture repository --------------------------------------------------

/** Verbatim subjects from this repository's `origin/main`. The `(U1, part 1)` /
 *  `(U1e)` pair is one unit that landed under two tags — the shape any subject-line
 *  `(U<n>)` match misses — and it is why the backfill map names PR numbers. */
const LANDED_SUBJECTS = [
  'feat(surfaces): canonical Surface model, crash-safe sidecar, and re-entrant migration (U1, part 1) (#158)',
  'feat(surfaces): wire the canonical Surface store into persistence, SSE, boot, and the lifecycle cascade (U1e) (#159)',
  'docs(plans): ratify incarnation retirement as KTD16 (#160)',
  'feat(surfaces): revision-safe mutation service, recoverable deletion, and agent parity (U3) (#161)',
  'feat(slate): Run.slate derives from canonical Surfaces (U2) (#162)',
  'feat(slate): durable freshness — surfaces that stay current without being nagged (U6) (#163)',
]

let root = ''
let worktree = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main',
    '-C', cwd, ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commit(cwd: string, message: string, file: string, contents: string): void {
  const path = join(cwd, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'slice-cards-'))
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  mkdirSync(remote); mkdirSync(seed)
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' })
  execFileSync('git', ['init', '-q', '--initial-branch=main', seed], { stdio: 'ignore' })

  // The plan document is a LOCAL fact the witness checks before it touches the
  // network, so it has to be a real blob.
  commit(seed, 'docs(plans): the recursive collaborative surfaces plan', TRACKED_PLAN, '# recursive\n')
  let n = 0
  for (const subject of LANDED_SUBJECTS) {
    commit(seed, subject, `src/landed-${++n}.ts`, `export const n = ${n}\n`)
  }
  git(seed, 'push', '-q', remote, 'main')

  worktree = join(root, 'wt')
  execFileSync('git', ['clone', '-q', remote, worktree], { stdio: 'ignore' })
  // On a FEATURE branch, like every worktree a run actually lives in. Anything that
  // read local HEAD instead of the tracked remote ref would still pass on `main`.
  git(worktree, 'checkout', '-q', '-b', 'feat/in-progress')
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

// --- the chain ---------------------------------------------------------------

const RUN = 'run-slice'
const SPACE = 'spc-slice'
const INCARNATION = 'inc-slice'
const ROOT_SURFACE = 'sf-run-root'

function ctx(at: number): SurfaceCallContext {
  return { actor: { kind: 'job', id: 'slate-watcher' }, at }
}

/** The real filesystem, with only the inotify and timer seams stubbed — every read
 *  hits the real temp dir. Copied in shape from `slate-source.test.ts`'s reader for
 *  the reason stated there. */
function realFs(): SlateFs {
  return {
    existsSync,
    watch: () => ({ close: () => {} }),
    readdir: d => readdir(d),
    lstat: async p => { const s = await lstat(p); return { size: s.size, isFile: s.isFile() } },
    readFile: p => readFile(p, 'utf8'),
  }
}

const noTimers: SlateTimers = {
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
}

/** Read the worktree's slate dir through the REAL watcher and hand back the epoch it
 *  would have applied. */
async function readEpoch(at: number): Promise<SlateSourceEpoch> {
  const epochs: SlateSourceEpoch[] = []
  const watcher = new SlateWatcher({
    listLiveRuns: () => [{ runId: RUN, workdir: worktree }],
    runContext: () => ({ spaceId: SPACE, incarnation: INCARNATION, rootSurfaceId: ROOT_SURFACE }),
    applyEpoch: async e => { epochs.push(e); return {} },
    fs: realFs(),
    timers: noTimers,
  })
  await watcher.pollOnce()
  watcher.stop()
  const epoch = epochs[epochs.length - 1]
  if (!epoch) throw new Error('the watcher produced no epoch')
  return { ...epoch, at }
}

function memoryIo(): JobStoreIo {
  const files = new Map<string, string>()
  return { read: p => files.get(p) ?? null, write: (p, d) => { files.set(p, d) }, mkdir: () => {} }
}

interface Chain {
  docStore: DocumentStore
  svc: SurfaceService
  coord: SurfaceRefreshCoordinator
  clock: { now: number }
  /** Every URL the http-status witness was asked to fetch, in order. */
  fetched: string[]
  /** What the stubbed fetch answers next. */
  httpStatus: number
  /** Every dispatch the coordinator attempted — the negative claim's evidence.
   *  There is exactly one dispatch seam now (plan U1): a prompt to a session that
   *  already exists. An empty list therefore means no agent work of ANY kind. */
  delivered: { sessionName: string; prompt: string }[]
  slate(): SlateSurface[]
  card(localId: string): SlateSurface
  surface(localId: string): Surface
  /** The live rebuild job for a card, if the coordinator queued one. */
  jobFor(localId: string): unknown
}

/**
 * Build the whole server-side chain over the fixture worktree.
 *
 * The witness deps are REAL for `exec` — a genuine `git fetch` against the local bare
 * remote — and stubbed for `fetch`, which is the one thing a unit test may not do for
 * real. Everything else (service, store, job store, coordinator) is the shipped code.
 */
function chain(): Chain {
  const docStore = new DocumentStore()
  const svc = new SurfaceService(docStore, { sourceAdapters: slateSourceAdapters() })
  const clock = { now: 1_000_000 }
  const cfg: RefreshCoordinatorConfig = {
    attemptTimeoutMs: 60_000,
    defaultIntervalMs: 10 * 60_000,
  }
  const state: Pick<Chain, 'fetched' | 'httpStatus' | 'delivered'> = {
    fetched: [], httpStatus: 200, delivered: [],
  }
  const witnessDeps: WitnessDeps = {
    exec: (argv, opts) => execCommand(argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs }),
    fetch: async url => { state.fetched.push(url); return { status: state.httpStatus } },
  }
  let n = 0
  const jobs = SurfaceRefreshJobStore.open('/cfg', memoryIo())
  const deps: RefreshCoordinatorDeps = {
    service: svc,
    jobs,
    surfaces: () => docStore.getAllSurfaces(),
    config: () => cfg,
    now: () => clock.now,
    newJobId: () => `job-${++n}`,
    // THE DISPATCH SEAM ACCEPTS, and that is deliberate. A refused dispatch fails its
    // job, and a failed job leaves `jobs.active` on the same sweep — so "this surface
    // has no rebuild job" would be equally true of a surface whose rebuild was
    // dispatched and broke, which is the opposite of what R12 asserts. Nothing is
    // ever staged, so the dispatched work simply sits there.
    //
    // There is only one seam to accept on (plan U1): these Surfaces carry the run's
    // provenance, so the run's own live session is their foreground owner and the
    // coordinator hands it the work. Nothing here could create a session.
    deliverToOwner: async d => { state.delivered.push(d); return true },
    isLiveSession: () => true,
    readStaged: async () => null,
    clearStaged: async () => {},
    observeSources: async () => {},
    // THE SHIPPED PROMPT BUILDER, not a stand-in. A test that asserts which card a
    // dispatch was about has to read the text production would actually deliver.
    buildPrompt: ({ surface, stagingPath }) => refreshDispatchPrompt(surface, stagingPath),
    // THE REGISTRY'S OWN RUNNER, not a stub of it. `unit-landed` shells out to the
    // real `git` in the fixture worktree; the three-valued outcome is produced by the
    // shipped code rather than asserted into existence.
    runWitness: ({ surface, claim }) => runWitness({
      claim,
      ...(surface.source?.worktree ? { worktree: surface.source.worktree } : {}),
      deps: witnessDeps,
    }),
  }
  const coord = new SurfaceRefreshCoordinator(deps)
  return {
    docStore, svc, coord, clock,
    get fetched() { return state.fetched },
    get httpStatus() { return state.httpStatus },
    set httpStatus(v: number) { state.httpStatus = v },
    get delivered() { return state.delivered },
    slate: () => docStore.getRun(RUN)?.slate ?? [],
    card(localId) {
      const found = (docStore.getRun(RUN)?.slate ?? []).find(s => s.id === localId)
      if (!found) throw new Error(`no projected surface ${localId}`)
      return found
    },
    surface(localId) {
      const found = docStore.surfaceForRunAlias(RUN, localId)
      if (!found) throw new Error(`no canonical surface for ${localId}`)
      return found
    },
    jobFor(localId) {
      const found = docStore.surfaceForRunAlias(RUN, localId)
      return found ? jobs.active(found.id) : undefined
    },
  } as Chain
}

/** Put the run in the store, write both cards to disk, and reconcile one epoch. */
async function authorBothCards(c: Chain, at: number): Promise<void> {
  c.docStore.upsertRun(RUN, {
    id: RUN, sessionId: RUN, spaceId: SPACE, status: 'running',
    createdAt: '2026-07-29T00:00:00.000Z',
  } as unknown as Parameters<DocumentStore['upsertRun']>[1])

  const dir = join(worktree, '.tinstar', 'slate')
  // Written fresh each time: a previous test's extra card must not leak into this
  // one's `slate()`, and the epoch is the WHOLE directory.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'roadmap.json'), JSON.stringify(roadmapCard(), null, 2))
  writeFileSync(join(dir, 'infra.json'), JSON.stringify(infraCard(LOCAL_API), null, 2))
  // A THIRD CARD THAT CAN DISPATCH, and it is here for the negative claim rather than
  // for the slice. "No agent was woken" is worth nothing if nothing in the harness
  // could have woken one — the plan's own execution note for U4 names that shape:
  // "a test satisfied by 'nothing dispatched because nothing ran' proves nothing."
  // This card carries a recipe, so a moved value on it DOES queue a rebuild, and the
  // last test in the file watches it happen through the same seams the other tests
  // assert are silent.
  writeFileSync(join(dir, 'rebuildable.json'), JSON.stringify({
    id: 'rebuildable-infra',
    headline: 'A card whose prose a moved value would invalidate',
    author: 'agent',
    refresh: 'Re-derive this card from the health endpoint and rewrite its prose.',
    claims: [{ id: 'api', witness: 'http-status', locus: 'infra', params: { url: LOCAL_API } }],
    content: {
      root: 'root',
      components: [{ id: 'root', component: 'Text', text: 'The API answered 200 when this was written.' }],
    },
  }, null, 2))

  await reconcileSlateEpoch(c.svc, await readEpoch(at), ctx(at))
}

/** One full witness pass, awaited. The coordinator fires the pass and returns; the
 *  production caller never waits, so the test has to. */
async function sweepAndWait(c: Chain): Promise<void> {
  await c.coord.sweep()
  await c.coord.witnessPass()
}

/** Every step row the renderer draws for a projected surface, as label → status.
 *  Through the REAL `A2uiRenderer` and the real catalog — the projection could carry
 *  a status the renderer never draws and every server assertion would still pass. */
function renderedSteps(card: SlateSurface): Record<string, string> {
  cleanup()
  render(createElement(A2uiRenderer, { content: card.body! }))
  const out: Record<string, string> = {}
  for (const row of screen.getAllByTestId('stepper-step')) {
    const label = row.querySelector('[data-testid="stepper-label"]')?.textContent ?? ''
    out[label] = row.getAttribute('data-status') ?? ''
  }
  return out
}

describe('the two slice surfaces, over the real chain', () => {
  it('reports the repository\'s actual merge state, witnessed, with no agent woken', async () => {
    const c = chain()
    const at = c.clock.now
    await authorBothCards(c, at)

    // The cards arrived as claim-bearing Surfaces, and nothing refused a claim: both
    // witness kinds are in the shipped registry and both sets of params conform.
    expect(c.surface('recursive-surfaces-roadmap').content.claims).toHaveLength(UNITS.length)
    expect(c.surface('recursive-surfaces-roadmap').freshness.claimRefusals).toBeUndefined()
    expect(c.surface('standalone-api-reachable').content.claims).toHaveLength(1)
    // R23's convention, from the only side a test can check it: every surface this
    // slice ships declares at least one claim, so neither projects `unwitnessed`.
    for (const card of c.slate()) expect(card.unwitnessed).toBeUndefined()

    // THE FIRST LOOK. A value the host invented a moment ago has agreed with nothing,
    // so this pass records values and stamps nothing (U3's finding). The rail is
    // nevertheless already correct — the statuses come from the observed values, not
    // from the verification stamp.
    await sweepAndWait(c)
    const firstLook = c.card('recursive-surfaces-roadmap')
    expect(firstLook.freshness!.witnessedAt).toBeUndefined()
    expect(renderedSteps(firstLook)).toEqual(
      Object.fromEntries(UNITS.map(u => [u.label, u.landed ? 'done' : 'pending'])),
    )

    // THE SECOND LOOK, one minimum gap later — the shortest wait the coordinator's
    // own rate limit allows, which is what makes "a witnessed card takes two runs" a
    // property of the engine rather than of this test's clock.
    c.clock.now += 61_000
    await sweepAndWait(c)

    const roadmap = c.card('recursive-surfaces-roadmap')
    expect(roadmap.freshness!.witnessedAt).toBe(c.clock.now)
    // Scenario 1, at the render layer: what the browser draws matches what actually
    // merged. U1, U2, U3 and U6 are on the fixture's ref; U4, U5, U7 and U8 are not.
    expect(renderedSteps(roadmap)).toEqual(
      Object.fromEntries(UNITS.map(u => [u.label, u.landed ? 'done' : 'pending'])),
    )

    // Scenario 2 / AE1. A unit that has NOT landed is witnessed AND pending. The
    // absence is an answer a completed lookup returned, not an unknown: the claim
    // carries a value, carries no problem, and the card wears a witness age.
    const u4 = roadmap.freshness!.claimObservations!.u4!
    expect(u4.value).toBe('pending')
    expect(u4.problem).toBeUndefined()
    cleanup()
    render(createElement(SurfaceAge, {
      witnessedAt: roadmap.freshness!.witnessedAt,
      unwitnessed: roadmap.unwitnessed,
      now: c.clock.now,
    }))
    expect(screen.getByTestId('surface-age').getAttribute('data-witness')).toBe('witnessed')

    // The infra card is witnessed off the same pass, against its own stubbed host.
    const infra = c.card('standalone-api-reachable')
    expect(infra.freshness!.witnessedAt).toBe(c.clock.now)
    expect(infra.freshness!.claimObservations!.api!.value).toBe(200)
    // TWO http-status cards (the slice's, and the dispatch-positive one the last
    // test uses) across TWO passes, and every request went to the loopback URL and
    // nowhere else — a unit test that reached a real host would show up right here.
    expect(c.fetched).toEqual(Array(4).fill(LOCAL_API))

    // THE HEADLINE NEGATIVE. Ten claims across the two slice cards, two full passes,
    // and not one agent prompt. Observable rather than vacuous: `delivered` is the
    // only dispatch seam there is, and the next test watches it fire on a card that
    // differs only by carrying a recipe.
    expect(c.delivered).toEqual([])
  })

  // THE POSITIVE THAT MAKES THE NEGATIVE MEAN SOMETHING. Every other test in this
  // file asserts `delivered` is empty. That assertion is worth nothing unless this
  // harness can produce a dispatch at all — "nothing dispatched because nothing ran"
  // and "nothing dispatched because nothing needed to" are indistinguishable
  // otherwise. Same chain, same seams, same moved value; the only difference is a
  // recipe, which is what R12 says the difference is.
  it('a moved value DOES wake a rebuild when the surface carries a recipe', async () => {
    const c = chain()
    await authorBothCards(c, c.clock.now)
    await sweepAndWait(c)
    c.clock.now += 61_000
    await sweepAndWait(c)
    expect(c.delivered).toEqual([])

    c.httpStatus = 503
    c.clock.now += 11 * 60_000
    await sweepAndWait(c)
    // The pass that records the delta queues nothing; the next sweep drains the
    // marker into a job, and the one after dispatches it.
    await sweepAndWait(c)
    await sweepAndWait(c)

    // Exactly one, and only for the card with a recipe — the two slice cards took the
    // same 503 and queued nothing.
    // Exactly one delivery, naming the card that carries the recipe — and the two
    // slice cards took the same 503 and produced nothing.
    expect(c.delivered).toHaveLength(1)
    expect(c.delivered[0]!.prompt).toContain('A card whose prose a moved value would invalidate')
    expect(c.jobFor('rebuildable-infra')).toBeDefined()
    expect(c.jobFor('standalone-api-reachable')).toBeUndefined()
    expect(c.surface('rebuildable-infra').freshness.claimRebuild!.moves)
      .toEqual([{ claimId: 'api', from: 200, to: 503 }])
    expect(c.surface('standalone-api-reachable').freshness.claimRebuild!.moves)
      .toEqual([{ claimId: 'api', from: 200, to: 503 }])
  })

  it('the infra card ignores a commit and revalidates on its own deadline', async () => {
    const c = chain()
    await authorBothCards(c, c.clock.now)
    await sweepAndWait(c)
    c.clock.now += 61_000
    await sweepAndWait(c)
    const beforeFetches = c.fetched.length

    // THE INVARIANT ITSELF, asserted before the behaviour — because the behavioural
    // half below is satisfied by two DIFFERENT facts and only one of them is R5.
    // Removing the locus predicate entirely leaves the assertions further down green:
    // the infra card declares no recipe, so `effectiveDeclaration` gives it only the
    // trigger kinds its own claims earn (`periodic`), and the declaration filter
    // rejects a commit before the locus predicate is ever consulted. That is defence
    // in depth on the shipped card, not a reason to leave a test that passes for the
    // wrong reason — `docs/solutions/conventions/verify-a-guard-by-breaking-it.md`
    // names exactly this shape. So the predicate is read directly, on the two records
    // this slice actually ships.
    expect(claimLocusAdmits(c.surface('standalone-api-reachable'), 'git-revision')).toBe(false)
    expect(claimLocusAdmits(c.surface('recursive-surfaces-roadmap'), 'git-revision')).toBe(true)
    // And `periodic` reaches BOTH, which is what makes the line above narrowing
    // rather than an infra card nothing can ever check.
    expect(claimLocusAdmits(c.surface('standalone-api-reachable'), 'periodic')).toBe(true)

    // A commit on the bound worktree. Its locus is `repo`, which the roadmap's claims
    // observe and the infra card's does not (R5) — so it reaches exactly one of them.
    await c.coord.note({
      kind: 'git-revision', sourceId: worktree, worktree, runId: RUN,
      evidence: 'deadbeef', at: c.clock.now,
    })
    await c.coord.witnessPass()

    // The infra card was not marked, not re-fetched, and not queued.
    expect(c.fetched.length).toBe(beforeFetches)
    expect(c.surface('standalone-api-reachable').freshness.staleReason).toBeUndefined()
    expect(c.surface('standalone-api-reachable').freshness.phase).toBe('current')
    expect(c.delivered).toEqual([])

    // …and it still revalidates when its OWN deadline comes round, which is what
    // makes the line above narrowing rather than muting.
    c.clock.now += 11 * 60_000
    await sweepAndWait(c)
    expect(c.fetched.length).toBeGreaterThan(beforeFetches)
    expect(c.surface('standalone-api-reachable').freshness.witnessedAt).toBe(c.clock.now)
  })

  it('a moved infra status is recorded as a delta rather than swallowed', async () => {
    const c = chain()
    await authorBothCards(c, c.clock.now)
    await sweepAndWait(c)
    c.clock.now += 61_000
    await sweepAndWait(c)
    expect(c.surface('standalone-api-reachable').freshness.witnessedAt).toBe(c.clock.now)

    // The standalone starts answering 503. That IS the claim moving.
    c.httpStatus = 503
    c.clock.now += 11 * 60_000
    await sweepAndWait(c)

    const infra = c.surface('standalone-api-reachable')
    expect(infra.freshness.claimRebuild!.moves).toEqual([{ claimId: 'api', from: 200, to: 503 }])
    expect(infra.freshness.phase).toBe('possibly-stale')

    // R12: no recipe, so the delta is recorded and marked and NOTHING is queued for
    // it — not now and not on any later sweep, because `drainRebuilds` keeps the
    // recipe-less arm intact rather than dispatching a rebuild with no instruction.
    // Asserted on THIS surface rather than on a global zero: the same fixture holds a
    // card that does carry a recipe, and it gets a job off this very 503.
    await sweepAndWait(c)
    await sweepAndWait(c)
    expect(c.jobFor('standalone-api-reachable')).toBeUndefined()
    expect(c.jobFor('rebuildable-infra')).toBeDefined()
    // AND IT IS STILL `possibly-stale`, which is the assertion that survives the
    // interesting mutations. "No active job" alone is too weak: a job that WAS
    // dispatched and then failed for want of a recipe also leaves `jobs.active`, so a
    // recipe-less Surface churning through a failing rebuild every deadline would
    // satisfy it. `failed` is exactly what R12's intact arm exists to prevent, and it
    // is what this card shows the moment that arm is removed.
    expect(c.surface('standalone-api-reachable').freshness.phase).toBe('possibly-stale')
    expect(c.surface('standalone-api-reachable').freshness.failure).toBeUndefined()
    // The dispatch that did happen was about the OTHER card. Stated as a property of
    // the delivered text rather than as a global zero, because a global zero here
    // would be satisfied by a harness that cannot dispatch at all.
    expect(c.delivered.some(d => d.prompt.includes('The standalone backend answers its own API')))
      .toBe(false)
  })

  it('a landing moves the roadmap and nothing else', async () => {
    const c = chain()
    await authorBothCards(c, c.clock.now)
    await sweepAndWait(c)
    c.clock.now += 61_000
    await sweepAndWait(c)
    expect(renderedSteps(c.card('recursive-surfaces-roadmap'))[UNITS[3]!.label]).toBe('pending')

    // U4 lands on the tracked ref, under the `Plan:` trailer convention.
    const pusher = join(root, 'pusher')
    if (!existsSync(pusher)) {
      execFileSync('git', ['clone', '-q', join(root, 'remote.git'), pusher], { stdio: 'ignore' })
    }
    commit(
      pusher,
      `feat(surfaces): recursive Canvas workspace (#170)\n\nPlan: ${TRACKED_PLAN}#U4\n`,
      'src/u4.ts', 'export const u4 = 4\n',
    )
    git(pusher, 'push', '-q', 'origin', 'main')

    c.clock.now += 11 * 60_000
    await sweepAndWait(c)

    // The rail corrected itself with no agent involved (R22) …
    expect(renderedSteps(c.card('recursive-surfaces-roadmap'))[UNITS[3]!.label]).toBe('done')
    expect(c.delivered).toEqual([])
    // … the delta is on the record …
    expect(c.surface('recursive-surfaces-roadmap').freshness.claimRebuild!.moves)
      .toEqual([{ claimId: 'u4', from: 'pending', to: 'landed' }])
    // … and the infra card, which asserts nothing about the repository, did not move.
    expect(c.surface('standalone-api-reachable').freshness.claimRebuild).toBeUndefined()
  })
})

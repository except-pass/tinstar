// @vitest-environment node
//
// The witness registry (plan U2, R2/R6/R7/R21, KTD8).
//
// THE PROPERTY UNDER TEST IS THE THREE-VALUED OUTCOME. A witness that could not
// look returns `unresolved`, never an absence — because a two-valued contract makes
// a broken fetch indistinguishable from "the thing genuinely is not there", and a
// Surface would then match its own stored absence and stamp itself verified while
// nothing checked anything.
//
// The `unit-landed` half runs against REAL GIT. Not a mock of git, and not this
// repository either: a temp bare "remote" plus two clones, built with the real
// binary, carrying commit messages copied verbatim out of this repository's history
// — including the two shapes that falsify the naive implementations:
//
//   · `(U1, part 1)` (#158) and `(U1e)` (#159) — one unit that landed under two
//     different tags, which any subject-line `(U<n>)` match misses.
//   · five unrelated squashes whose BODIES each contain `(U4)` from five different
//     plans, which any whole-message grep for `(U4)` matches.
//
// Reading this repository directly would have been the other option and is worse:
// CI checks out at depth 1 with no `origin/main`, so those tests would pass here
// and fail there. The fixture is hermetic and needs no network — its remote is a
// local bare repo, so a real `git fetch` runs and is really exercised.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { SurfaceClaim } from '../../../domain/types'
import {
  runWitness,
  validateClaim,
  witnessKinds,
  witnessLookupIdentity,
  witnessMatches,
  type WitnessDeps,
  type WitnessExecResult,
  type WitnessOutcome,
} from '../witness-registry'
import { execCommand } from '../../infra/execCommand'
import { defaultWitnessDeps } from '../witness-runtime'

// --- the fixture repository -------------------------------------------------

const RECURSIVE_PLAN = 'docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md'
const CLAIMS_PLAN = 'docs/plans/2026-07-29-001-feat-slate-claims-and-witnesses-plan.md'

/** Verbatim subjects from this repository's `origin/main`. The `(U1, part 1)` /
 *  `(U1e)` pair is the falsifying shape; keep them exactly as they are. */
const BACKFILLED_SUBJECTS = [
  'feat(surfaces): canonical Surface model, crash-safe sidecar, and re-entrant migration (U1, part 1) (#158)',
  'feat(surfaces): wire the canonical Surface store into persistence, SSE, boot, and the lifecycle cascade (U1e) (#159)',
  'docs(plans): ratify incarnation retirement as KTD16 (#160)',
  'feat(surfaces): revision-safe mutation service, recoverable deletion, and agent parity (U3) (#161)',
  'feat(slate): Run.slate derives from canonical Surfaces (U2) (#162)',
  'feat(slate): durable freshness — surfaces that stay current without being nagged (U6) (#163)',
]

/** Five squashes from five DIFFERENT plans, each carrying `(U4)` in its body.
 *  Subjects and body lines copied from this repository's history. */
const U4_DECOYS: { subject: string; body: string }[] = [
  {
    subject: 'feat(slate): code-spawned surface authors (a cheap, kill-switchable spike) (#133)',
    body: "* feat(slate): create-time recipe capture (U4) + teach the vacuum test (U5)",
  },
  {
    subject: 'feat: The Slate — per-run A2UI surfaces (#126)',
    body: '* feat(slate): watch .tinstar/slate and project surfaces onto the run (U4)',
  },
  {
    subject: 'feat(roundup): answer notices from the widget (interactivity) (#119)',
    body: '- Dissent (U4): every FYI shows a Disagree affordance that submits via the widget.',
  },
  {
    subject: 'feat(sessions): hidden-by-default background sessions (#104)',
    body: '* feat(background): PATCH /api/runs/:id background mutation with attention re-derive (U4)',
  },
  {
    subject: 'feat: The Graveyard — necro dead sessions to ask them questions (#100)',
    body: '* feat(graveyard): reviveFromTombstone necro core, best-effort by convId (U4)',
  },
]

let root = ''
let remote = ''
/** The clone the witness reads. Deliberately left on a FEATURE branch. */
let wt = ''
/** A second clone, used to push landings the first one has not fetched. */
let pusher = ''

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
  root = mkdtempSync(join(tmpdir(), 'witness-fixture-'))
  remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  mkdirSync(remote); mkdirSync(seed)
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' })
  execFileSync('git', ['init', '-q', '--initial-branch=main', seed], { stdio: 'ignore' })

  // The plan documents themselves. `unit-landed` refuses to answer about a plan
  // path that does not exist, so these have to be real blobs.
  commit(seed, 'docs(plans): the recursive collaborative surfaces plan', RECURSIVE_PLAN, '# recursive\n')
  commit(seed, 'docs(plans): claims and witnesses', CLAIMS_PLAN, '# claims\n')

  // The pre-convention landings — no `Plan:` trailer anywhere, which is exactly
  // why the backfill map exists.
  let n = 0
  for (const subject of BACKFILLED_SUBJECTS) {
    commit(seed, subject, `src/landed-${++n}.ts`, `export const n = ${n}\n`)
  }
  // The five `(U4)`-in-the-body decoys from five unrelated plans.
  for (const d of U4_DECOYS) {
    commit(seed, `${d.subject}\n\n${d.body}\n`, `src/decoy-${++n}.ts`, `export const n = ${n}\n`)
  }
  // One landing under the NEW convention, for the claims plan. Its presence is
  // what makes an absent sibling unit a real absence rather than an unknown.
  commit(
    seed,
    `feat(slate): a surface can declare what would prove it wrong (#164)\n\nBody text.\n\nPlan: ${CLAIMS_PLAN}#U1\n`,
    'src/claims-u1.ts', 'export const u1 = 1\n',
  )
  git(seed, 'push', '-q', remote, 'main')

  wt = join(root, 'wt')
  pusher = join(root, 'pusher')
  execFileSync('git', ['clone', '-q', remote, wt], { stdio: 'ignore' })
  execFileSync('git', ['clone', '-q', remote, pusher], { stdio: 'ignore' })

  // The reading clone sits on a feature branch carrying a landing that was NEVER
  // pushed. Anything reading local HEAD calls U7 landed; the ref says otherwise.
  git(wt, 'checkout', '-q', '-b', 'feat/not-merged')
  commit(
    wt,
    `feat(slate): the shared revalidate step\n\nPlan: ${CLAIMS_PLAN}#U7\n`,
    'src/claims-u7.ts', 'export const u7 = 7\n',
  )
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

// --- deps -------------------------------------------------------------------

const NO_FETCH: WitnessDeps['fetch'] = async () => {
  throw new Error('a unit test must not reach the network')
}

/** Real `git` in the fixture worktree — including a real `git fetch`, which costs
 *  nothing because the remote is a path on disk. */
function realGitDeps(over: Partial<WitnessDeps> = {}): WitnessDeps {
  return {
    exec: async (argv, opts) => execCommand(argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs }),
    fetch: NO_FETCH,
    ...over,
  }
}

/** Records every argv and answers from a table. Used for the failure modes real
 *  git cannot be made to produce deterministically (auth, hangs). */
function stubExec(
  answer: (argv: string[]) => WitnessExecResult | Promise<WitnessExecResult>,
): { deps: WitnessDeps; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    deps: {
      exec: async argv => { calls.push(argv); return answer(argv) },
      fetch: NO_FETCH,
    },
  }
}

const OK = (stdout = ''): WitnessExecResult => ({ stdout, stderr: '', code: 0 })

function unitClaim(over: Partial<SurfaceClaim> = {}): SurfaceClaim {
  return {
    id: 'unit',
    witness: 'unit-landed',
    locus: 'repo',
    params: { plan: RECURSIVE_PLAN, unit: 'U1' },
    ...over,
  }
}

function run(claim: SurfaceClaim, deps: WitnessDeps, timeoutMs?: number): Promise<WitnessOutcome> {
  return runWitness({ claim, worktree: wt, deps, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
}

// --- the registry itself ----------------------------------------------------

describe('the registry', () => {
  it('ships two kinds and no others (R21)', () => {
    expect([...witnessKinds()].sort()).toEqual(['http-status', 'unit-landed'])
  })

  it('refuses an unknown witness kind, naming it', () => {
    const refusal = validateClaim({ id: 'c', witness: 'run-the-tests', locus: 'repo' })
    expect(refusal).toContain('run-the-tests')
  })
})

// --- unit-landed, against real git ------------------------------------------

describe('unit-landed', () => {
  it('reports landed for a merged unit and pending for one that is not (scenario 1)', async () => {
    const landed = await run(unitClaim({ params: { plan: CLAIMS_PLAN, unit: 'U1' } }), realGitDeps())
    expect(landed).toEqual({ status: 'value', value: 'landed' })

    // U2 of the same plan: the convention is demonstrably live for this plan (U1
    // carries a trailer on the ref), so its absence is an absence, not an unknown.
    const pending = await run(unitClaim({ params: { plan: CLAIMS_PLAN, unit: 'U2' } }), realGitDeps())
    expect(pending).toEqual({ status: 'value', value: 'pending' })
  })

  it('reports landed for a unit that landed across two commits under differing tags (scenario 2)', async () => {
    // The falsifying precondition, ASSERTED rather than assumed: `(U1, part 1)` in
    // #158 and `(U1e)` in #159, and no bare `(U1)` anywhere on the ref. A
    // subject-line matcher therefore reports this unit pending forever.
    const subjects = git(wt, 'log', 'origin/main', '--format=%s')
    expect(subjects).toContain('(U1, part 1)')
    expect(subjects).toContain('(U1e)')
    expect(subjects).not.toContain('(U1)')

    const out = await run(unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U1' } }), realGitDeps())
    expect(out).toEqual({ status: 'value', value: 'landed' })
  })

  it('does not report landed from a unit id appearing in an unrelated plan (scenario 3)', async () => {
    // The falsifying precondition: five squashes on the ref carry `(U4)` in their
    // bodies, from five DIFFERENT plans, none of them this one. A whole-message grep
    // calls this unit landed on the strength of somebody else's U4.
    const messages = git(wt, 'log', 'origin/main', '--format=%B%x1e').split('\x1e')
    expect(messages.filter(m => m.includes('(U4)'))).toHaveLength(5)

    const out = await run(unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U4' } }), realGitDeps())
    expect(out).toEqual({ status: 'value', value: 'pending' })
  })

  it('reads the named remote ref, not local HEAD, on a feature branch (scenario 4)', async () => {
    // The reading clone's HEAD carries `Plan: <claims plan>#U7`, never pushed.
    expect(git(wt, 'log', '-1', '--format=%B')).toContain('#U7')
    const out = await run(unitClaim({ params: { plan: CLAIMS_PLAN, unit: 'U7' } }), realGitDeps())
    expect(out).toEqual({ status: 'value', value: 'pending' })
  })

  it('advances the ref before reading it', async () => {
    // Nothing in the host fetches, and feature PRs squash-merge remotely: a landing
    // pushed by somebody else is invisible until the witness fetches it itself.
    commit(
      pusher,
      `feat(slate): host-owned observation state (#165)\n\nPlan: ${CLAIMS_PLAN}#U3\n`,
      'src/claims-u3.ts', 'export const u3 = 3\n',
    )
    git(pusher, 'push', '-q', 'origin', 'main')
    // The reading clone has not seen #165 and will not unless the witness fetches.
    expect(git(wt, 'log', 'origin/main', '--format=%s')).not.toContain('(#165)')

    const out = await run(unitClaim({ params: { plan: CLAIMS_PLAN, unit: 'U3' } }), realGitDeps())
    expect(out).toEqual({ status: 'value', value: 'landed' })
  })

  it('is stable across repeated runs against unchanged inputs', async () => {
    const claim = unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U3' } })
    const a = await run(claim, realGitDeps())
    const b = await run(claim, realGitDeps())
    const c = await run(claim, realGitDeps())
    expect(a).toEqual({ status: 'value', value: 'landed' })
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it('reports unresolved for an unknown plan path — never pending (scenario 5)', async () => {
    const out = await run(unitClaim({ params: { plan: 'docs/plans/never-written-plan.md', unit: 'U1' } }), realGitDeps())
    expect(out.status).toBe('unresolved')
  })

  it('reports unresolved when the fetch fails (scenario 5)', async () => {
    // A real failure: the ref names a remote this clone does not have.
    const out = await run(
      unitClaim({ params: { plan: CLAIMS_PLAN, unit: 'U1', ref: 'upstream/main' } }),
      realGitDeps(),
    )
    expect(out.status).toBe('unresolved')
  })

  it('reports unresolved when the fetch is unauthenticated — never pending (scenario 5)', async () => {
    const { deps } = stubExec(argv => {
      if (argv.includes('fetch')) {
        return { stdout: '', stderr: 'fatal: Authentication failed for https://github.com/…', code: 128 }
      }
      return OK() // `cat-file -e` succeeds; the plan document is right there.
    })
    const out = await run(unitClaim(), deps)
    expect(out.status).toBe('unresolved')
    if (out.status === 'unresolved') expect(out.detail.toLowerCase()).toContain('fetch')
  })

  it('reports unresolved for a plan it can link to nothing — never pending', async () => {
    // No `Plan:` trailer anywhere for this plan and no backfill entry: the lookup
    // did not complete, so it may not report an absence (R7).
    const out = await run(
      unitClaim({ params: { plan: 'docs/plans/2026-07-13-001-feat-run-friendly-names-plan.md', unit: 'U2' } }),
      realGitDeps(),
    )
    expect(out.status).toBe('unresolved')
  })

  it('reports unresolved when the ref shows none of a backfilled plan\'s PRs', async () => {
    // The shallow-clone / wrong-ref case: the backfill asserts landings the ref
    // cannot corroborate, so coverage may not be trusted into a `pending`.
    const { deps } = stubExec(argv => {
      if (argv.includes('log')) return OK('') // an empty history
      return OK()
    })
    const out = await run(unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U4' } }), deps)
    expect(out.status).toBe('unresolved')
  })

  // FOUND BY U8's end-to-end pass, against the card this slice actually ships.
  //
  // The recursive-collaborative-surfaces plan is half backfilled and half not: four
  // units merged before the `Plan:` trailer convention existed, and the four that
  // have not merged will carry trailers when they do. With the trailer rung above
  // the backfill rung, the FIRST trailered landing made the other four report
  // `pending` — a false "not landed" about merges sitting in the log the witness had
  // just read, on the one plan the backfill map covers. Ordered last in this block
  // because it pushes a trailer for this plan that the tests above are written
  // against the absence of.
  it('keeps a backfilled unit landed once a sibling unit lands under the trailer convention', async () => {
    commit(
      pusher,
      `feat(surfaces): contextual prompts and contributor drill-down (#171)\n\nPlan: ${RECURSIVE_PLAN}#U5\n`,
      'src/recursive-u5.ts', 'export const u5 = 5\n',
    )
    git(pusher, 'push', '-q', 'origin', 'main')

    // The new trailer is read: its own unit is landed …
    expect(await run(unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U5' } }), realGitDeps()))
      .toEqual({ status: 'value', value: 'landed' })
    // … the backfilled two-commit unit is STILL landed …
    expect(await run(unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U1' } }), realGitDeps()))
      .toEqual({ status: 'value', value: 'landed' })
    expect(await run(unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U6' } }), realGitDeps()))
      .toEqual({ status: 'value', value: 'landed' })
    // … and a unit in neither channel is pending, which is the rung the trailer's
    // presence legitimately buys.
    expect(await run(unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U4' } }), realGitDeps()))
      .toEqual({ status: 'value', value: 'pending' })
  })

  it('never lets an author-supplied parameter reach git as an option', async () => {
    // Claim parameters arrive from an agent-authored file — the same untrusted
    // channel the prompt-delivery guardrail exists for. Nothing derived from one
    // may end up in an argv slot git reads as a flag.
    const { deps, calls } = stubExec(() => OK(''))
    await run(unitClaim({ params: { plan: RECURSIVE_PLAN, unit: 'U1', ref: 'origin/main' } }), deps)
    expect(calls.length).toBeGreaterThan(0)
    for (const argv of calls) {
      expect(argv[0]).toBe('git')
      for (const arg of argv.slice(1)) {
        if (!arg.startsWith('-')) continue
        expect(arg).not.toContain(RECURSIVE_PLAN)
        expect(arg).not.toContain('origin')
        expect(arg).not.toContain('U1')
      }
    }
  })
})

// --- http-status ------------------------------------------------------------

describe('http-status', () => {
  const claim: SurfaceClaim = {
    id: 'api', witness: 'http-status', locus: 'infra',
    params: { url: 'https://example.invalid/health' },
  }

  it('returns the status code (scenario 6)', async () => {
    const deps: WitnessDeps = {
      exec: async () => OK(),
      fetch: async () => ({ status: 204 }),
    }
    expect(await run(claim, deps)).toEqual({ status: 'value', value: 204 })
  })

  it('returns a 500 as a value — a reachable host that answered is a completed lookup', async () => {
    const deps: WitnessDeps = { exec: async () => OK(), fetch: async () => ({ status: 500 }) }
    expect(await run(claim, deps)).toEqual({ status: 'value', value: 500 })
  })

  it('reports unresolved when the host is unreachable (scenario 6)', async () => {
    const deps: WitnessDeps = {
      exec: async () => OK(),
      fetch: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }) },
    }
    const out = await run(claim, deps)
    expect(out.status).toBe('unresolved')
  })

  it('is stable across repeated runs against an unchanged host', async () => {
    const deps: WitnessDeps = { exec: async () => OK(), fetch: async () => ({ status: 200 }) }
    const seen = [await run(claim, deps), await run(claim, deps), await run(claim, deps)]
    expect(seen).toEqual([
      { status: 'value', value: 200 },
      { status: 'value', value: 200 },
      { status: 'value', value: 200 },
    ])
  })
})

// --- parameter schemas ------------------------------------------------------

describe('parameter schemas (scenario 7)', () => {
  const cases: { why: string; claim: SurfaceClaim }[] = [
    { why: 'no params at all', claim: { id: 'c', witness: 'unit-landed', locus: 'repo' } },
    { why: 'no unit', claim: { id: 'c', witness: 'unit-landed', locus: 'repo', params: { plan: RECURSIVE_PLAN } } },
    {
      why: 'a unit id that is not U<n>',
      claim: { id: 'c', witness: 'unit-landed', locus: 'repo', params: { plan: RECURSIVE_PLAN, unit: 'the first one' } },
    },
    {
      why: 'a plan path outside docs/plans',
      claim: { id: 'c', witness: 'unit-landed', locus: 'repo', params: { plan: '../../etc/passwd', unit: 'U1' } },
    },
    {
      why: 'a ref that could be read as a git option',
      claim: { id: 'c', witness: 'unit-landed', locus: 'repo', params: { plan: RECURSIVE_PLAN, unit: 'U1', ref: '--upload-pack=sh' } },
    },
    {
      why: 'a ref naming no remote',
      claim: { id: 'c', witness: 'unit-landed', locus: 'repo', params: { plan: RECURSIVE_PLAN, unit: 'U1', ref: 'main' } },
    },
    { why: 'a url that is not a url', claim: { id: 'c', witness: 'http-status', locus: 'infra', params: { url: 'nope' } } },
    {
      why: 'a non-http scheme',
      claim: { id: 'c', witness: 'http-status', locus: 'infra', params: { url: 'file:///etc/passwd' } },
    },
    {
      why: 'a repo witness declared at the infra locus',
      claim: { id: 'c', witness: 'unit-landed', locus: 'infra', params: { plan: RECURSIVE_PLAN, unit: 'U1' } },
    },
  ]

  for (const { why, claim } of cases) {
    it(`refuses ${why}, naming the kind`, () => {
      const refusal = validateClaim(claim)
      expect(refusal, `${why} should have been refused`).toBeTruthy()
      expect(refusal).toContain(claim.witness)
      expect(refusal).toContain('c')
    })
  }

  it('accepts the two well-formed shapes', () => {
    expect(validateClaim(unitClaim())).toBeNull()
    expect(validateClaim({ id: 'c', witness: 'http-status', locus: 'infra', params: { url: 'http://localhost:5273/api/state' } })).toBeNull()
  })

  it('refuses to RUN a claim its schema rejects rather than running it anyway', async () => {
    const { deps, calls } = stubExec(() => OK())
    const out = await run({ id: 'c', witness: 'unit-landed', locus: 'repo', params: { plan: 'x', unit: 'U1' } }, deps)
    expect(out.status).toBe('failed')
    expect(calls).toEqual([])
  })
})

// --- timeouts ---------------------------------------------------------------

describe('timeouts (scenario 8)', () => {
  it('reports failed — not unresolved, and not a value — when git hangs', async () => {
    const never = new Promise<WitnessExecResult>(() => { /* deliberately never settles */ })
    const { deps } = stubExec(() => never)
    const out = await run(unitClaim(), deps, 20)
    expect(out.status).toBe('failed')
  })

  it('reports failed when the host never answers', async () => {
    const deps: WitnessDeps = {
      exec: async () => OK(),
      fetch: () => new Promise(() => { /* never settles */ }),
    }
    const out = await run(
      { id: 'api', witness: 'http-status', locus: 'infra', params: { url: 'https://example.invalid/' } },
      deps, 20,
    )
    expect(out.status).toBe('failed')
  })

  it('a timeout is distinguishable from an unresolved and from a moved value', async () => {
    const never = new Promise<WitnessExecResult>(() => { /* never */ })
    const timedOut = await run(unitClaim(), stubExec(() => never).deps, 20)
    const unresolved = await run(unitClaim({ params: { plan: 'docs/plans/nope.md', unit: 'U1' } }), realGitDeps())
    expect(timedOut.status).toBe('failed')
    expect(unresolved.status).toBe('unresolved')
    expect(timedOut.status).not.toBe(unresolved.status)
  })
})

// --- what counts as a match -------------------------------------------------

describe('witnessMatches', () => {
  it('matches a value against the same stored value', () => {
    expect(witnessMatches('landed', { status: 'value', value: 'landed' })).toBe(true)
    expect(witnessMatches(200, { status: 'value', value: 200 })).toBe(true)
  })

  it('does not match a moved value', () => {
    expect(witnessMatches('landed', { status: 'value', value: 'pending' })).toBe(false)
    expect(witnessMatches(200, { status: 'value', value: 503 })).toBe(false)
  })

  it('matches a stored ABSENCE re-observed as an absence by a completed lookup (R7)', () => {
    expect(witnessMatches(null, { status: 'value', value: null })).toBe(true)
  })

  it('NEVER matches an unresolved outcome, whatever was stored (KTD8)', () => {
    expect(witnessMatches(null, { status: 'unresolved', detail: 'x' })).toBe(false)
    expect(witnessMatches('landed', { status: 'unresolved', detail: 'x' })).toBe(false)
    expect(witnessMatches(undefined, { status: 'unresolved', detail: 'x' })).toBe(false)
  })

  it('never matches a failed outcome', () => {
    expect(witnessMatches(null, { status: 'failed', detail: 'x' })).toBe(false)
    expect(witnessMatches('landed', { status: 'failed', detail: 'x' })).toBe(false)
  })

  it('does not match when nothing was ever stored', () => {
    expect(witnessMatches(undefined, { status: 'value', value: 'landed' })).toBe(false)
  })
})

// --- the seam that keeps the registry importable from a pure module -----------

describe('import purity', () => {
  it('the registry imports nothing at runtime', () => {
    // The design constraint U1 left for this unit: `surface-trigger-matcher.ts` is a
    // PURE module, and importing a registry that pulls in subprocess spawns and HTTP
    // would end that. The registry therefore takes every effect as an injected dep,
    // and this is the guard — break it by adding one runtime import and this test
    // names the line.
    const source = readFileSync(new URL('../witness-registry.ts', import.meta.url), 'utf8')
    const imports = source.split('\n').filter(l => /^import\b/.test(l))
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter(l => !l.startsWith('import type '))).toEqual([])
  })
})

describe('witness-runtime', () => {
  it('narrows a real Response to its status and passes the method, redirect and signal through', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return { status: 418 } as Response
    })
    try {
      const controller = new AbortController()
      const res = await defaultWitnessDeps().fetch(
        'https://example.invalid/health',
        { method: 'GET', redirect: 'manual', signal: controller.signal },
      )
      // Exactly `{ status }`: nothing downstream may hold a response body open.
      expect(res).toEqual({ status: 418 })
      expect(seen).toHaveLength(1)
      expect(seen[0]!.init.method).toBe('GET')
      // A 301 IS the claimed status; following it would report the destination's 200.
      expect(seen[0]!.init.redirect).toBe('manual')
      expect(seen[0]!.init.signal).toBe(controller.signal)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ---------------------------------------------------------------------------
// The broker's coalescing identity (R8, KTD6).
//
// Derived HERE because this is where the schema lives. A caller guessing a key from
// raw `claim.params` would miss the defaults the schema applies — `origin/main` is
// the one that bites — and a key that disagreed with the work would either coalesce
// two different questions onto one answer (the worst failure available) or fail to
// coalesce two identical ones.
// ---------------------------------------------------------------------------

describe('witnessLookupIdentity', () => {
  it('keys http-status on the URL, so two cards watching one endpoint share a lookup', () => {
    const a = witnessLookupIdentity({ id: 'a', witness: 'http-status', locus: 'infra', params: { url: 'https://x/health' } })
    const b = witnessLookupIdentity({ id: 'b', witness: 'http-status', locus: 'infra', params: { url: 'https://x/health' } })
    expect(a?.provider).toBe('http')
    expect(a).toEqual(b)
  })

  it('applies the schema\'s own default ref, so an explicit origin/main coalesces with an omitted one', () => {
    // The trap a caller reading `claim.params` raw would fall into: these are the
    // same question, and keying them apart would double the fetches for nothing.
    const plan = 'docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md'
    const implicit = witnessLookupIdentity({ id: 'a', witness: 'unit-landed', locus: 'repo', params: { plan, unit: 'U6' } }, '/wt')
    const explicit = witnessLookupIdentity(
      { id: 'b', witness: 'unit-landed', locus: 'repo', params: { plan, unit: 'U6', ref: 'origin/main' } }, '/wt',
    )
    expect(implicit?.provider).toBe('git')
    expect(implicit).toEqual(explicit)
  })

  it('separates different worktrees — the same ref in two repositories is two questions', () => {
    const plan = 'docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md'
    const claim = { id: 'a', witness: 'unit-landed' as const, locus: 'repo' as const, params: { plan, unit: 'U6' } }
    expect(witnessLookupIdentity(claim, '/wt/a')).not.toEqual(witnessLookupIdentity(claim, '/wt/b'))
  })

  it('has no identity for a claim no schema accepts — there is no question to ask', () => {
    expect(witnessLookupIdentity({ id: 'a', witness: 'no-such-kind', locus: 'repo' })).toBeUndefined()
    expect(witnessLookupIdentity({ id: 'a', witness: 'http-status', locus: 'infra', params: { url: 'not a url' } }))
      .toBeUndefined()
  })

  it('gives every registered kind an identity, so none can slip past the broker', () => {
    // A kind added to the registry without an identity here would run UNBROKERED,
    // which is exactly the ungoverned provider access the broker exists to stop.
    const samples: Record<string, SurfaceClaim> = {
      'http-status': { id: 'a', witness: 'http-status', locus: 'infra', params: { url: 'https://x/y' } },
      'unit-landed': {
        id: 'b', witness: 'unit-landed', locus: 'repo',
        params: { plan: 'docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md', unit: 'U6' },
      },
    }
    for (const kind of witnessKinds()) {
      const sample = samples[kind]
      expect(sample, `no sample claim for witness kind "${kind}" — add one when the kind ships`).toBeDefined()
      expect(witnessLookupIdentity(sample!, '/wt'), `witness kind "${kind}" has no broker identity`).toBeDefined()
    }
  })
})

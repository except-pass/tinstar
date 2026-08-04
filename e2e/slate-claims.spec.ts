// The two slice cards on a LIVE Slate (plan U8, R20/R21/R22/R23).
//
// THE SESSION-ENABLED FIXTURE, and it is not a preference. The default `test`
// fixture spawns the standalone with `TINSTAR_NO_SESSIONS=1`, under which the whole
// session-scoped route block — including `/api/surfaces` and the refresh engine that
// runs witnesses — is never mounted. Requests fall through to the SPA catch-all and
// `r.json()` throws `SyntaxError: Unexpected token '<'`. See
// `docs/solutions/test-failures/e2e-session-scoped-api-routes-return-spa-html.md`.
//
// WHAT THIS PROVES that the unit tests cannot: a real backend process, its real sweep
// timer, its real witness runner and a real browser, with nobody driving the clock.
// The rail's statuses arrive because the host went and looked.
//
// NO NETWORK. The repo witness reads a temp bare remote created by this file (a real
// `git fetch`, over a path on disk), and the infra witness polls the standalone the
// fixture just started, on loopback.
import { pluginTest as test } from './fixtures'
import { expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const TRACKED_PLAN = 'docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md'

/** Plan order, with what actually happened on `main`. Four landed, four did not — a
 *  card where every row said the same thing would demonstrate nothing. */
const UNITS: { unit: string; label: string; landed: boolean }[] = [
  { unit: 'U1', label: 'U1 canonical Surface model', landed: true },
  { unit: 'U2', label: 'U2 per-source reconciliation', landed: true },
  { unit: 'U3', label: 'U3 mutation service and agent parity', landed: true },
  { unit: 'U4', label: 'U4 recursive Canvas workspace', landed: false },
  { unit: 'U5', label: 'U5 contextual prompts', landed: false },
  { unit: 'U6', label: 'U6 durable trigger and refresh engine', landed: true },
  { unit: 'U7', label: 'U7 presence and the Attention Rail', landed: false },
  { unit: 'U8', label: 'U8 promotion rollout', landed: false },
]

/** Verbatim subjects from this repository's `origin/main`, including the
 *  `(U1, part 1)` / `(U1e)` pair — one unit that landed under two tags. */
const LANDED_SUBJECTS = [
  'feat(surfaces): canonical Surface model, crash-safe sidecar, and re-entrant migration (U1, part 1) (#158)',
  'feat(surfaces): wire the canonical Surface store into persistence, SSE, boot, and the lifecycle cascade (U1e) (#159)',
  'feat(surfaces): revision-safe mutation service, recoverable deletion, and agent parity (U3) (#161)',
  'feat(slate): Run.slate derives from canonical Surfaces (U2) (#162)',
  'feat(slate): durable freshness — surfaces that stay current without being nagged (U6) (#163)',
]

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main',
    '-C', cwd, ...args,
  ], { stdio: 'ignore' })
}

/** A temp bare remote plus a clone parked on a feature branch — the shape a run's
 *  worktree actually has. Returns the clone the witness will read. */
function buildFixtureRepo(root: string): string {
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  mkdirSync(remote); mkdirSync(seed)
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' })
  execFileSync('git', ['init', '-q', '--initial-branch=main', seed], { stdio: 'ignore' })

  const write = (file: string, contents: string) => {
    const path = join(seed, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  // The plan document is checked locally before the witness touches the network.
  write(TRACKED_PLAN, '# recursive collaborative surfaces\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'docs(plans): the recursive collaborative surfaces plan')
  LANDED_SUBJECTS.forEach((subject, i) => {
    write(`src/landed-${i}.ts`, `export const n = ${i}\n`)
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', subject)
  })
  git(seed, 'push', '-q', remote, 'main')

  const worktree = join(root, 'wt')
  execFileSync('git', ['clone', '-q', remote, worktree], { stdio: 'ignore' })
  git(worktree, 'checkout', '-q', '-b', 'feat/in-progress')
  return worktree
}

test('both slice cards report their real state on a live Slate', async ({ page }) => {
  // A real `git clone` plus two full witness passes on a five-second sweep.
  test.setTimeout(120_000)

  const root = mkdtempSync(join(tmpdir(), 'slate-claims-e2e-'))
  try {
    const worktree = buildFixtureRepo(root)

    await page.goto('/')
    await resetAndWaitForData(page)

    const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
    await widget.waitFor({ timeout: 15_000 })
    const runId = ((await widget.getAttribute('data-testid')) ?? '').replace('canvas-widget-run-', '')
    expect(runId, 'no run to host the cards').toBeTruthy()

    const seeded = await page.evaluate(async (input) => {
      // THE URL THE INFRA CLAIM POLLS, taken from the page rather than from a
      // `baseURL` fixture. Playwright's `baseURL` comes from the config's `use`
      // block, which this project leaves empty — the port is chosen per worker
      // inside the fixture and only ever reaches the browser context. Reading it
      // from a fixture parameter yields `undefined`, and a fallback constant points
      // at a port nothing is listening on, which the witness correctly reports as
      // unresolved. `location.origin` is the one value that cannot be wrong.
      const apiUrl = `${location.origin}/api/state`
      const state = await (await fetch('/api/state')).json()
      const run = (state.runs ?? []).find((r: { id: string }) => r.id === input.runId)
      const spaceId: string = run?.spaceId || 'default'

      const post = async (body: unknown) => {
        const r = await fetch('/api/surfaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        // An HTML body on an /api path means the handler was never registered.
        const text = await r.text()
        try { return { ok: r.ok, data: JSON.parse(text) } } catch { return { ok: false, data: text.slice(0, 80) } }
      }

      const roadmap = await post({
        spaceId,
        home: { kind: 'canvas', spaceId },
        provenance: { runId: input.runId, worktreeId: input.worktree },
        content: {
          headline: 'Recursive collaborative surfaces — what has actually landed',
          claims: input.units.map((u: { unit: string }) => ({
            id: u.unit.toLowerCase(),
            witness: 'unit-landed',
            locus: 'repo',
            params: { plan: input.plan, unit: u.unit },
          })),
          body: {
            root: 'root',
            components: [
              { id: 'root', component: 'Column', children: ['rail'] },
              {
                id: 'rail',
                component: 'Stepper',
                steps: input.units.map((u: { unit: string; label: string }) => ({
                  label: u.label, claim: u.unit.toLowerCase(), done: 'landed',
                })),
              },
            ],
          },
        },
      })

      const infra = await post({
        spaceId,
        home: { kind: 'canvas', spaceId },
        provenance: { runId: input.runId },
        content: {
          headline: 'The standalone backend answers its own API',
          claims: [{ id: 'api', witness: 'http-status', locus: 'infra', params: { url: apiUrl } }],
          body: {
            root: 'root',
            components: [{ id: 'root', component: 'Text', text: 'A GET of /api/state answers 200.' }],
          },
        },
      })

      // The control: a surface that declares nothing. It must look different.
      const silent = await post({
        spaceId,
        home: { kind: 'canvas', spaceId },
        provenance: { runId: input.runId },
        content: { headline: 'A card that declares nothing' },
      })

      return {
        roadmap: roadmap.ok ? roadmap.data?.data?.surfaces?.[0]?.surface?.id : `FAILED: ${JSON.stringify(roadmap.data)}`,
        infra: infra.ok ? infra.data?.data?.surfaces?.[0]?.surface?.id : `FAILED: ${JSON.stringify(infra.data)}`,
        silent: silent.ok ? silent.data?.data?.surfaces?.[0]?.surface?.id : `FAILED: ${JSON.stringify(silent.data)}`,
      }
    }, { runId, worktree, plan: TRACKED_PLAN, units: UNITS })

    expect(seeded.roadmap, 'roadmap card was not created').not.toContain('FAILED')
    expect(seeded.infra, 'infra card was not created').not.toContain('FAILED')
    expect(seeded.silent, 'control card was not created').not.toContain('FAILED')

    // The cards reach the browser over SSE.
    const rail = widget.locator(`[data-testid="point-${seeded.roadmap}"] [data-testid="stepper"]`)
    await expect(rail).toBeVisible({ timeout: 20_000 })

    // THE ASSERTION THIS SPEC EXISTS FOR. Nobody wrote these statuses: the host
    // fetched the fixture's ref, read the trailers and the backfill, and the
    // projection filled the rail in from what it saw. Polled because the first sweep
    // is on a five-second timer and a `git fetch` is a real subprocess.
    await expect.poll(
      async () => rail.locator('[data-testid="stepper-step"]').evaluateAll(
        rows => rows.map(r => `${r.querySelector('[data-testid="stepper-label"]')?.textContent}=${r.getAttribute('data-status')}`),
      ),
      { timeout: 60_000, message: 'the rail never settled on the repository\'s real merge state' },
    ).toEqual(UNITS.map(u => `${u.label}=${u.landed ? 'done' : 'pending'}`))

    // Honest reporting, three ways, on one canvas. A claim-bearing card is either
    // never-checked or checked; a claimless one says there is nothing to check.
    const age = (id: string) => widget.locator(`[data-testid="point-${id}"] [data-testid="surface-age"]`)
    await expect(age(seeded.silent)).toHaveAttribute('data-witness', 'unwitnessed')
    expect(['never', 'witnessed']).toContain(await age(seeded.roadmap).getAttribute('data-witness'))
    expect(['never', 'witnessed']).toContain(await age(seeded.infra).getAttribute('data-witness'))

    // The infra card got a real answer from the standalone it points at — 200,
    // recorded as a value rather than an unresolved shrug.
    await expect.poll(
      async () => page.evaluate(async (id: string) => {
        const r = await fetch(`/api/surfaces/${id}`)
        const j = await r.json()
        return j?.data?.surface?.freshness?.claimObservations?.api?.value ?? null
      }, seeded.infra),
      { timeout: 60_000, message: 'the http-status witness never recorded a value' },
    ).toBe(200)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

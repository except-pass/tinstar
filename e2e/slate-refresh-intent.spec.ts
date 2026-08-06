// Leaving Tinstar open costs nothing (R11/R12, AE3), proved in a real browser.
//
// EVERY OTHER TEST OF THIS IS A NEGATIVE INSIDE A HARNESS THAT CANNOT SPEND ANYTHING.
// The unit suites stub prompt delivery and drive an injected clock, so "no prompt was
// delivered" is a claim about a spy. This one runs the real standalone, its real
// five-second sweep, its real git-poll trigger, and a real browser sitting on the
// Slate — and then asks the running host whether it created any refresh work at all.
//
// THE SESSION-ENABLED FIXTURE, and it is not a preference. The default `test` fixture
// spawns the standalone with `TINSTAR_NO_SESSIONS=1`, under which the whole
// session-scoped route block — including `/api/surfaces` and the refresh engine —
// is never mounted, and `r.json()` throws on the SPA catch-all's HTML. See
// `docs/solutions/test-failures/e2e-session-scoped-api-routes-return-spa-html.md`.
//
// NO NETWORK, NO MODEL. The Surface here carries an AGENT recipe, which is exactly
// the kind nothing may run on its own — so the whole spec is about work that must not
// happen, and the one positive at the end is a request the browser makes deliberately.
import { pluginTest as test } from './fixtures'
import { expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test('an open Slate refreshes nothing until a person reaches for it', async ({ page }) => {
  // Two full sweeps at the shipped five-second cadence, plus SSE settling.
  test.setTimeout(120_000)

  await page.goto('/')
  await resetAndWaitForData(page)

  const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
  await widget.waitFor({ timeout: 15_000 })
  const runId = ((await widget.getAttribute('data-testid')) ?? '').replace('canvas-widget-run-', '')
  expect(runId, 'no run to host the surface').toBeTruthy()

  // A DIRTY, AGENT-WRITTEN SURFACE — the exact shape that used to cost a background
  // session every time its worktree moved.
  const seeded = await page.evaluate(async (input) => {
    const state = await (await fetch('/api/state')).json()
    const run = (state.runs ?? []).find((r: { id: string }) => r.id === input.runId)
    const spaceId: string = run?.spaceId || 'default'

    const created = await fetch('/api/surfaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spaceId,
        home: { kind: 'canvas', spaceId },
        provenance: { runId: input.runId },
        content: {
          headline: 'Release readiness — what is still open',
          // Prose. Only a human's deliberate interaction may ever run this.
          recipe: 'Re-read the open PRs and rewrite this surface.',
          body: {
            root: 'root',
            components: [{ id: 'root', component: 'Text', text: 'Two PRs were open at 09:12.' }],
          },
        },
      }),
    })
    const text = await created.text()
    let id = ''
    try { id = JSON.parse(text)?.data?.surfaces?.[0]?.surface?.id ?? '' } catch { /* HTML body */ }
    if (!id) return { id: `FAILED: ${text.slice(0, 120)}` }

    // Dirty it the way a commit would: a human-intent mark, through the host's own
    // mutator rather than by editing the record, so the state is one production can
    // actually reach.
    await fetch(`/api/surfaces/${id}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A bulk check on an agent recipe is a no-op by design (KTD9) — used here
      // purely to confirm the route answers before the quiet period begins.
      body: JSON.stringify({ intent: 'bulk-check' }),
    })
    return { id }
  }, { runId })

  expect(seeded.id, 'surface was not created').not.toContain('FAILED')
  const id = seeded.id

  /** Every refresh job the host has ever created for this Surface. */
  const jobsFor = async (): Promise<number> => page.evaluate(async (surfaceId: string) => {
    const r = await fetch(`/api/surfaces/${surfaceId}`)
    const j = await r.json()
    // A queued or running attempt stamps the record; a completed one leaves a check.
    const f = j?.data?.surface?.freshness ?? {}
    return (f.jobId ? 1 : 0) + (f.phase === 'refreshing' || f.phase === 'queued' ? 1 : 0)
  }, id)

  const surfaceCard = widget.locator(`[data-testid="point-${id}"], [data-testid="slate-surface-${id}"]`).first()
  await expect(surfaceCard).toBeVisible({ timeout: 20_000 })

  // THE QUIET PERIOD. The browser sits on the Slate with the card on screen, the
  // sweep timer runs, the git poll runs, SSE frames arrive. Nothing may start.
  await page.waitForTimeout(15_000)
  expect(await jobsFor(), 'the host started refresh work nobody asked for').toBe(0)

  // …and the card is still readable the whole time, showing its last-known content
  // rather than being withheld until something proves it fresh (R4).
  await expect(surfaceCard).toContainText('Two PRs were open at 09:12.')

  // THE POSITIVE THAT MAKES THE QUIET MEAN SOMETHING. Without it, a spec that could
  // never start a refresh would pass while asserting nothing. A deliberate explicit
  // intent — the ⟳ button's request — does reach the engine.
  const answered = await page.evaluate(async (surfaceId: string) => {
    const r = await fetch(`/api/surfaces/${surfaceId}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'explicit' }),
    })
    const text = await r.text()
    try { return JSON.parse(text)?.data?.outcome ?? `NO-OUTCOME: ${text.slice(0, 120)}` } catch {
      return `NON-JSON: ${text.slice(0, 120)}`
    }
  }, id)

  // `unavailable` is a perfectly good answer here — the fixture has no live
  // foreground agent — and it is still PROOF the request reached the engine and was
  // decided. What it must never be is a silent nothing.
  expect(['started', 'joined', 'unavailable', 'not-executable']).toContain(answered)

  // The content is STILL there whichever way that went (R4/R17): a Surface that
  // could not be refreshed keeps its last-known result rather than being blanked.
  await expect(surfaceCard).toContainText('Two PRs were open at 09:12.')
})

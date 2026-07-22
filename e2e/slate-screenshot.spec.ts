// Screenshot-QA capture for The Slate. Not an assertion test — it seeds a run's
// Slate with varied surfaces and captures PNGs for independent visual review.
// Run: TINSTAR_FAST_SIM=1 npx playwright test e2e/slate-screenshot.spec.ts
import { pluginTest as test } from './fixtures'
import { expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

const DIAGRAM = {
  root: 'root',
  components: [
    { id: 'root', component: 'Column', children: ['h', 'p', 'list'] },
    { id: 'h', component: 'Text', variant: 'h3', text: 'Deploy dataflow' },
    { id: 'p', component: 'Text', variant: 'body', text: 'The auth change ships behind a feature flag (off by default).' },
    { id: 'list', component: 'List', listStyle: 'unordered', children: ['a', 'b'] },
    { id: 'a', component: 'Text', text: 'Migration is not reversible.' },
    { id: 'b', component: 'Text', text: 'Staging gets it in ~5 minutes.' },
  ],
}
const CHOICE = {
  root: 'root',
  components: [
    { id: 'root', component: 'Column', children: ['q', 'pick', 'go'] },
    { id: 'q', component: 'Text', variant: 'body', text: 'Which rollback path should I take?' },
    { id: 'pick', component: 'Choice', mode: 'single', options: [
      { id: 'revert', label: 'Revert the commit' },
      { id: 'forward', label: 'Roll forward with a hotfix' },
    ] },
    { id: 'go', component: 'Submit', label: 'Send answer' },
  ],
}

test('capture Slate surfaces for QA', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1680, height: 1040 })
  await page.goto('/')
  await resetAndWaitForData(page)

  const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
  await widget.waitFor({ timeout: 15_000 })
  const tid = await widget.getAttribute('data-testid')
  const runId = (tid || '').replace('canvas-widget-run-', '')
  expect(runId).toBeTruthy()

  // Seed a spread of surfaces via same-origin fetch (sessions enabled → routes live).
  const seedResult = await page.evaluate(async ({ runId, DIAGRAM, CHOICE }) => {
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const jpost = async (url: string, body: unknown) => (await post(url, body)).json().catch(() => null)

    // 1) plain open point
    const a = await jpost(`/api/runs/${runId}/slate/points`, { headline: 'Deploy to staging, or wait for the migration review?' })
    // 2) point with a thread → status waiting
    const b = await jpost(`/api/runs/${runId}/slate/points`, { headline: 'Which rollback path should I take?' })
    const bid = b?.data?.point?.id
    if (bid) await post(`/api/runs/${runId}/slate/points/${bid}/replies`, { text: 'Check the staging logs first.', author: 'user' })
    // 3) resolved point
    const c = await jpost(`/api/runs/${runId}/slate/points`, { headline: 'Skipped the flaky e2e test on CI' })
    const cid = c?.data?.point?.id
    if (cid) await post(`/api/runs/${runId}/slate/points/${cid}/resolve`, {})
    // 4) diagram surface (A2UI body)
    await jpost(`/api/runs/${runId}/slate/points`, { headline: 'Deploy dataflow', anchor: { kind: 'surface' }, content: DIAGRAM })
    // 5) interactive choice
    await jpost(`/api/runs/${runId}/slate/points`, { headline: 'Pick a rollback path', content: CHOICE })

    // did the first POST return JSON (route live) or SPA HTML (route gated)?
    return { firstOk: !!a?.ok, firstShape: a ? Object.keys(a).join(',') : 'null' }
  }, { runId, DIAGRAM, CHOICE })

  // Fail loudly if the route was gated (SPA HTML → a is null / not ok).
  expect(seedResult.firstOk, `seed POST did not return ok JSON (shape: ${seedResult.firstShape}) — route gated?`).toBeTruthy()

  // Slate column appears once run.slate is populated (SSE).
  const slate = widget.getByTestId('focus-zone-slate')
  await slate.waitFor({ timeout: 15_000 })

  // Pixel-independent layout check: do the card's OWN slate + telemetry columns
  // overlap, and does slate content overflow its column horizontally (→ clip)?
  const layout = await page.evaluate((tid) => {
    const card = document.querySelector(`[data-testid="${tid}"]`)!
    const slate = card.querySelector('[data-testid="focus-zone-slate"]') as HTMLElement | null
    const right = card.querySelector('[data-testid="focus-zone-right-panel"]') as HTMLElement | null
    const scroll = slate?.querySelector('[data-scrollable]') as HTMLElement | null
    const rectOf = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width) } }
    const sr = slate?.getBoundingClientRect(); const rr = right?.getBoundingClientRect()
    return {
      slate: rectOf(slate), telemetry: rectOf(right),
      columnsOverlapPx: sr && rr ? Math.round(Math.max(0, Math.min(sr.right, rr.right) - Math.max(sr.x, rr.x))) : null,
      slateContentOverflowX: scroll ? scroll.scrollWidth - scroll.clientWidth : null,
    }
  }, tid)
  console.log('SLATE_LAYOUT ' + JSON.stringify(layout))
  // Regression guards (this is why the spec earns its place in CI): the added
  // Slate column must sit cleanly between session and telemetry and never bleed.
  expect(layout.columnsOverlapPx, 'Slate and telemetry columns must not overlap').toBe(0)
  expect(layout.slateContentOverflowX ?? 0, 'Slate content must not overflow its column').toBeLessThan(4)

  // Hide every OTHER canvas widget so a sibling HUD can't occlude the run card,
  // then crop just the Slate column. Injected stylesheet (inline hides get wiped
  // by SSE re-renders — the documented canvas-screenshot technique).
  await page.addStyleTag({ content: `[data-testid^="canvas-widget-"]:not([data-testid="${tid}"]){ display:none !important; }` })
  await page.waitForTimeout(300)

  // Clean crop of JUST the Slate column using its measured screen rect.
  const box = await slate.boundingBox()
  if (box) {
    await page.screenshot({
      path: 'screenshots/slate-00-column-clean.png',
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 1000) },
    })
  }

  // Zoom-to-fit the run card so its columns are legible.
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('widget:flash-focus', { detail: { widgetId: id, source: 'run' } }))
  }, runId)
  await page.waitForTimeout(900)

  await page.screenshot({ path: 'screenshots/slate-01-run-card.png' })
  await widget.screenshot({ path: 'screenshots/slate-02-run-card-focused.png' })
  await slate.screenshot({ path: 'screenshots/slate-03-column.png' })

  // Expand the first thread toggle (▸) if present, then reshoot the column.
  const toggle = slate.locator('button', { hasText: /thread/i }).first()
  if (await toggle.count()) {
    await toggle.click().catch(() => {})
    await page.waitForTimeout(400)
    await slate.screenshot({ path: 'screenshots/slate-04-thread-open.png' })
  }
})

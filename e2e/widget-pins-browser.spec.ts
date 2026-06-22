// Runtime verification of Widget Pins on a BROWSER widget — the path the
// MOCKED unit/integration tests can't exercise: real iframe rendering and the
// scroll-GLUE that keeps a pin stuck to page content as it scrolls.
//
// Why a live page is needed: the browser widget self-renders its pins
// (registration.rendersOwnPinMarkers) at `top: docY - scroll.y`. To observe the
// glue we need a real, same-origin, *scrollable* document inside the iframe. The
// tinstar browser widget proxies its target through `/api/proxy/<nodeId>/…`,
// serving it from tinstar's own origin (allow-same-origin) so
// `iframe.contentWindow.scrollTo()` and the widget's scroll listener both work.
//
// We host a tiny TALL static page (3000px, three 1000px colour blocks) on
// 127.0.0.1 from inside the test process; the FAST_SIM backend (same machine)
// reaches it server-side via the proxy. Confirmed reachable before writing this
// (proxy returns 200 + the page HTML with the runtime shim injected).
//
// Topology facts (verified at runtime, not assumed):
//   - A BrowserWidget created via POST /api/browser-widgets gets id `browser-…`.
//     That id IS the canvas node id (WorkspaceShell maps w.id → node.id), so the
//     widget testid is `canvas-widget-browser-…` and pins target nodeId=`browser-…`.
//   - Browser widgets surface in /api/state under `browserWidgets`.
//   - A pin renders on the current page iff `pin.context.url === widget.url`
//     (BrowserPinLayer.onCurrentPage) — this drives the URL-scoping test.
//   - Pins persist via PUT /api/pins/<space> (revision-gated; stamp rev+1).
//
// Covers: (1) marker renders over the page near its doc point, (2) SCROLL-GLUE —
// marker top decreases by ~scrollY when the iframe scrolls, (3) URL-scoping —
// pin hides after navigating away and reappears on return, (4) bubble opens on a
// browser pin. Submit-to-session is SKIPPED with a note (no session is attached
// to a standalone browser widget here; the integration test already covers the
// submit endpoint/body, and making a browser widget session-backed requires a
// run sharing its constellation slot — out of scope for glue verification).
import { test, expect, type Page } from './fixtures'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

const SHOT_DIR = '/tmp/pin-verify-browser'
mkdirSync(SHOT_DIR, { recursive: true })

// A tall, scrollable page with three distinct 1000px anchors. 3000px total so
// there is real scroll room below the iframe fold.
const TALL_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TALL TEST PAGE</title>
<style>body{margin:0;font:16px system-ui}.block{height:1000px;display:flex;align-items:center;justify-content:center;font-size:40px}#a{background:#fca}#b{background:#cfa}#c{background:#acf}</style></head>
<body>
<div class="block" id="a">TOP ANCHOR A</div>
<div class="block" id="b">MIDDLE ANCHOR B</div>
<div class="block" id="c">BOTTOM ANCHOR C</div>
</body></html>`

// A second, visually-distinct page used to prove URL-scoping (pin hides on it).
const OTHER_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OTHER PAGE</title>
<style>body{margin:0;font:16px system-ui;background:#211;color:#eee}.block{height:1200px;display:flex;align-items:center;justify-content:center;font-size:40px}</style></head>
<body><div class="block">OTHER PAGE (no pins here)</div></body></html>`

const PIN_ID = 'pin-browser-1'

let staticServer: Server
let pageUrlA = ''
let pageUrlB = ''

test.beforeAll(async () => {
  // Bind on 127.0.0.1 so only the loopback backend (same host) reaches it.
  staticServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(req.url?.startsWith('/other') ? OTHER_PAGE : TALL_PAGE)
  })
  await new Promise<void>(resolve => staticServer.listen(0, '127.0.0.1', resolve))
  const port = (staticServer.address() as AddressInfo).port
  pageUrlA = `http://127.0.0.1:${port}/`
  pageUrlB = `http://127.0.0.1:${port}/other`
})

test.afterAll(async () => {
  await new Promise<void>(resolve => staticServer.close(() => resolve()))
})

/** Read the active space id straight from the server snapshot. */
async function activeSpaceId(page: Page): Promise<string> {
  const id = await page.evaluate(async () => (await (await fetch('/api/state')).json()).activeSpaceId as string)
  expect(id, 'FAST_SIM should expose an active space id').toBeTruthy()
  return id
}

/** Create a browser widget pointing at `url` and return its node id (== widget.id). */
async function createBrowserWidget(page: Page, spaceId: string, url: string): Promise<string> {
  const id = await page.evaluate(async ({ sid, u }: { sid: string; u: string }) => {
    const r = await fetch('/api/browser-widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: u, spaceId: sid }),
    })
    const j = await r.json()
    return j.data?.id as string
  }, { sid: spaceId, u: url })
  expect(id, 'POST /api/browser-widgets should return a widget id').toBeTruthy()
  return id
}

/** PATCH a browser widget's url (used to drive a same-tab navigation for scoping). */
async function navigateWidget(page: Page, widgetId: string, url: string) {
  await page.evaluate(async ({ id, u }: { id: string; u: string }) => {
    await fetch(`/api/browser-widgets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: u }),
    })
  }, { id: widgetId, u: url })
}

async function getPinSet(page: Page, spaceId: string) {
  return page.evaluate(async (sid: string) => {
    const s = await (await fetch('/api/state')).json()
    return s.pinSets.find((p: { spaceId: string }) => p.spaceId === sid) ?? null
  }, spaceId)
}

/** PUT a pin set, stamping rev+1 over the current stored rev (revision gate). */
async function putPinSet(page: Page, spaceId: string, pins: unknown[]) {
  const status = await page.evaluate(async ({ sid, p }: { sid: string; p: unknown[] }) => {
    const cur = await (await fetch('/api/state')).json()
    const existing = cur.pinSets.find((s: { spaceId: string }) => s.spaceId === sid)
    const rev = ((existing?.rev as number) ?? 0) + 1
    const r = await fetch(`/api/pins/${encodeURIComponent(sid)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId: sid, rev, pins: p }),
    })
    return r.status
  }, { sid: spaceId, p: pins })
  expect(status, 'PUT /api/pins should succeed').toBe(200)
}

function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  return errors
}

function assertNoPinErrors(errors: string[]) {
  const pinErrors = errors.filter(e =>
    /pin|usePinSet|PinLayer|PinMarker|PinBubble|BrowserPinLayer|BrowserPrimitive/i.test(e),
  )
  expect(pinErrors, `pins/browser console/page errors: ${pinErrors.join(' | ')}`).toHaveLength(0)
}

/** Bring a freshly-POSTed browser widget into view. Essential for the browser-pin
 *  tests: a new browser widget lands off the initial camera (its content/affordance
 *  sit "outside of the viewport"). Dispatch the canvas `focus` viewport event (the
 *  same one the inbox/sidebar use) to centerOn the widget's layout — panning it in.
 *  (The layout map is keyed by the bare node id == widget.id.) Does NOT force a zoom
 *  level — the canvas auto-zoom (<1) is read separately and factored into the glue
 *  delta, which keeps the glue assertion honest at any zoom. */
async function focusWidget(page: Page, widgetId: string) {
  const widget = page.getByTestId(`canvas-widget-${widgetId}`)
  await expect(widget).toBeVisible({ timeout: 10000 })
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('tinstar:canvas:viewport', {
      detail: { action: 'focus', nodeId: id, padding: 80 },
    }))
  }, widgetId)
  await page.waitForTimeout(350) // let the centerOn animation settle
}

/** Read the current canvas zoom factor (0..n) from the zoom-indicator ("93%" → 0.93). */
async function canvasZoom(page: Page): Promise<number> {
  const txt = await page.getByTestId('zoom-indicator').textContent()
  const pct = parseInt((txt ?? '100').replace('%', ''), 10)
  return pct / 100
}

/** Wait for the proxied page to load inside the widget's iframe and become
 *  same-origin-readable (the proxy serves a self-refreshing 404 placeholder
 *  until the target resolves). Returns the Playwright Frame for the iframe. */
async function waitForIframePage(page: Page, widgetId: string, expectText: string) {
  const widget = page.getByTestId(`canvas-widget-${widgetId}`)
  await expect(widget).toBeVisible({ timeout: 10000 })
  const iframeEl = widget.locator('iframe')
  await expect(iframeEl).toBeVisible({ timeout: 10000 })
  // Poll the frame's body text until the real page (not the "Connecting…"
  // placeholder) is present. The proxy placeholder auto-refreshes every 2s.
  await expect.poll(async () => {
    const frame = page.frames().find(f => f.url().includes(`/api/proxy/${widgetId}`))
    if (!frame) return ''
    try { return await frame.evaluate(() => document.body?.innerText ?? '') } catch { return '' }
  }, { timeout: 15000 }).toContain(expectText)
  const frame = page.frames().find(f => f.url().includes(`/api/proxy/${widgetId}`))!
  return frame
}

test.describe('Widget Pins (browser widget — live iframe render + scroll glue)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('tinstar-layouts-v3'))
    await page.reload()
    await page.waitForTimeout(300)
    await expect(page.getByTestId('infinite-canvas')).toBeVisible({ timeout: 10000 })
    // Reset SERVER pins for the active space so tests don't share state. Without
    // this, each test PUTs a pin with the SAME PIN_ID and leaves a stale pin at
    // index 0 — which the affordance-drag test would then assert against (passing
    // even if place→enrich→render is broken). Clear to an empty set (rev+1).
    const spaceId = await activeSpaceId(page)
    await putPinSet(page, spaceId, [])
  })

  // 1. A pin injected at known document coords renders a marker over the page,
  //    positioned at docY - scrollY (scrollY=0 here ⇒ marker top ≈ iframe-top + docY).
  // 2. SCROLL-GLUE: scrolling the proxied document moves the marker WITH content —
  //    its screen `top` decreases by ~the scroll delta.
  test('marker renders over the page and glues to content on scroll', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    const widgetId = await createBrowserWidget(page, spaceId, pageUrlA)
    const frame = await waitForIframePage(page, widgetId, 'TOP ANCHOR A')
    await focusWidget(page, widgetId) // pan the widget into view
    const zoom = await canvasZoom(page) // canvas auto-zoom (<1) scales screen deltas

    // Inject a pin glued to a doc point that stays on-screen at scroll 0 and after
    // a modest scroll (the overlay is overflow-hidden, so an off-fold marker clips).
    const DOC_X = 120
    const DOC_Y = 250
    await putPinSet(page, spaceId, [
      {
        id: PIN_ID, nodeId: widgetId, nx: 0.1, ny: 0.3, comment: 'glue me',
        createdAt: Date.now(),
        context: { url: pageUrlA, docX: DOC_X, docY: DOC_Y },
      },
    ])

    const marker = page.getByTestId(`pin-marker-${PIN_ID}`)
    await expect(marker).toBeVisible({ timeout: 6000 })

    // Marker sits inside the iframe bounds (it's an overlay over the iframe).
    const iframeEl = page.getByTestId(`canvas-widget-${widgetId}`).locator('iframe')
    const ib0 = await iframeEl.boundingBox()
    const mb0 = await marker.boundingBox()
    if (!ib0 || !mb0) throw new Error('iframe/marker not visible')
    expect(mb0.x + mb0.width / 2).toBeGreaterThan(ib0.x)
    expect(mb0.x + mb0.width / 2).toBeLessThan(ib0.x + ib0.width)
    // At scroll 0, the marker's doc point docY=900 maps to viewport offset 900
    // from the iframe top. The marker top should sit ~900px below the iframe top
    // (within the iframe if it's tall enough; if the iframe is shorter than 900
    // the marker can be clipped by the overlay's overflow-hidden — so we only
    // assert the precise glue *delta* below, which is layout-independent).
    await page.screenshot({ path: `${SHOT_DIR}/01-browser-marker-rendered.png` })

    const topBefore = mb0.y

    // SCROLL the proxied document. Same-origin via the proxy ⇒ scrollTo works and
    // the widget's scroll listener updates `iframeScroll`, re-positioning the marker
    // at (docY - scrollY). The marker lives inside the canvas transform, so a
    // SCROLL-px content move shows up on screen as SCROLL × canvasZoom pixels.
    const SCROLL = 300
    await frame.evaluate((y) => window.scrollTo(0, y), SCROLL)
    // Wait for the listener's rAF-debounced state update to land and re-layout.
    await expect.poll(async () => {
      const mb = await marker.boundingBox()
      return mb ? Math.round(mb.y) : null
    }, { timeout: 4000 }).not.toBe(Math.round(topBefore))

    const mb1 = await marker.boundingBox()
    if (!mb1) throw new Error('marker vanished after scroll')
    const delta = topBefore - mb1.y
    const expected = SCROLL * zoom
    // Glue: the marker top should drop by ~(SCROLL × zoom) — proving the marker is
    // anchored at docY and re-rendered at docY-scrollY (content-glued), not fixed
    // to the widget frame. Tolerance covers sub-pixel rounding + rAF coalescing.
    expect(
      delta,
      `marker should move with content: top drop ${Math.round(delta)}px vs expected ~${Math.round(expected)}px ` +
      `(scroll ${SCROLL}px × zoom ${zoom}); was ${Math.round(topBefore)} → ${Math.round(mb1.y)}`,
    ).toBeGreaterThan(expected - 12)
    expect(delta).toBeLessThan(expected + 12)
    await page.screenshot({ path: `${SHOT_DIR}/02-browser-marker-scrolled.png` })
    assertNoPinErrors(errors)
  })

  // 3. URL-scoping: a pin scoped to page A is hidden once the widget navigates to
  //    page B (different url), and reappears on returning to A.
  test('pin is scoped to its page url (hidden after navigating away)', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    const widgetId = await createBrowserWidget(page, spaceId, pageUrlA)
    await waitForIframePage(page, widgetId, 'TOP ANCHOR A')
    await focusWidget(page, widgetId)

    await putPinSet(page, spaceId, [
      {
        id: PIN_ID, nodeId: widgetId, nx: 0.1, ny: 0.2, comment: 'page-A pin',
        createdAt: Date.now(),
        context: { url: pageUrlA, docX: 100, docY: 200 },
      },
    ])
    const marker = page.getByTestId(`pin-marker-${PIN_ID}`)
    await expect(marker).toBeVisible({ timeout: 6000 })

    // Navigate the widget to page B. BrowserPinLayer.onCurrentPage compares
    // pin.context.url (pageUrlA) against the widget's loaded url (now pageUrlB) →
    // pin filtered out.
    await navigateWidget(page, widgetId, pageUrlB)
    await waitForIframePage(page, widgetId, 'OTHER PAGE')
    await expect(marker, 'pin should hide on a different page url').toHaveCount(0, { timeout: 6000 })
    await page.screenshot({ path: `${SHOT_DIR}/03-browser-pin-scoped-hidden.png` })

    // Return to page A → pin reappears.
    await navigateWidget(page, widgetId, pageUrlA)
    await waitForIframePage(page, widgetId, 'TOP ANCHOR A')
    await expect(marker, 'pin should reappear on returning to its page').toBeVisible({ timeout: 6000 })
    assertNoPinErrors(errors)
  })

  // 4. Bubble opens when the browser pin marker is clicked. (Send/submit is
  //    SKIPPED — a standalone browser widget has no backing session, so Send is
  //    disabled by design; the integration test covers the submit endpoint/body.)
  test('clicking a browser pin opens its bubble', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    const widgetId = await createBrowserWidget(page, spaceId, pageUrlA)
    await waitForIframePage(page, widgetId, 'TOP ANCHOR A')
    await focusWidget(page, widgetId)

    await putPinSet(page, spaceId, [
      {
        id: PIN_ID, nodeId: widgetId, nx: 0.1, ny: 0.2, comment: 'open me',
        createdAt: Date.now(),
        context: { url: pageUrlA, docX: 100, docY: 150 },
      },
    ])
    const marker = page.getByTestId(`pin-marker-${PIN_ID}`)
    await expect(marker).toBeVisible({ timeout: 6000 })

    const bubble = page.getByTestId(`pin-bubble-${PIN_ID}`)
    await expect(bubble).toHaveCount(0)
    await marker.click()
    await expect(bubble).toBeVisible({ timeout: 3000 })

    // Standalone browser widget ⇒ no session ⇒ Send disabled (canSubmit=false).
    const submit = page.getByTestId(`pin-submit-${PIN_ID}`)
    await expect(submit).toBeVisible()
    await expect(submit, 'Send disabled for a session-less browser widget').toBeDisabled()
    await page.screenshot({ path: `${SHOT_DIR}/04-browser-pin-bubble-open.png` })

    await marker.click()
    await expect(bubble).toHaveCount(0)
    assertNoPinErrors(errors)
  })

  // Item 1 (placement gesture): drive a real affordance drag-place on the browser
  // widget so the placement→enrich→render path runs end-to-end (not just an
  // API-injected pin). The drop point should produce a marker glued to content.
  test('affordance drag-place drops a content-glued pin on the page', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    const widgetId = await createBrowserWidget(page, spaceId, pageUrlA)
    await waitForIframePage(page, widgetId, 'TOP ANCHOR A')
    await focusWidget(page, widgetId) // bring the widget + its affordance into view

    const widget = page.getByTestId(`canvas-widget-${widgetId}`)
    const before = (await getPinSet(page, spaceId))?.pins?.length ?? 0

    await widget.hover()
    const affordance = page.getByTestId('pin-drop-affordance')
    await expect(affordance).toBeVisible({ timeout: 3000 })
    const canvas = page.getByTestId('infinite-canvas')

    // pointerdown on the affordance → canvas guard raises (iframe pointer-events off).
    await affordance.evaluate(el => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        button: 0, pointerId: 1, bubbles: true, composed: true,
      }))
    })
    await expect(canvas).toHaveAttribute('data-pin-dragging', 'true', { timeout: 2000 })

    // Drop ~40% into the widget body (over the iframe page, below the URL toolbar).
    const wb = await widget.boundingBox()
    if (!wb) throw new Error('widget not visible')
    const dropX = wb.x + wb.width * 0.4
    const dropY = wb.y + wb.height * 0.5
    await affordance.evaluate((el, { x, y }) => {
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, pointerId: 1, bubbles: true, composed: true }))
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, pointerId: 1, bubbles: true, composed: true }))
    }, { x: dropX, y: dropY })

    await expect(canvas).not.toHaveAttribute('data-pin-dragging', 'true', { timeout: 2000 })

    // A new pin landed and persisted.
    await expect.poll(async () => (await getPinSet(page, spaceId))?.pins?.length ?? 0, { timeout: 5000 }).toBe(before + 1)

    // Identify the NEWLY-created pin (the one on this widget), not pins[0] — a
    // stale leftover at index 0 would let a broken place→enrich path pass.
    await expect.poll(async () => {
      const ps = await getPinSet(page, spaceId)
      return (ps?.pins as { nodeId: string }[] | undefined)?.some(x => x.nodeId === widgetId) ?? false
    }, { timeout: 6000 }).toBe(true)
    const ps = await getPinSet(page, spaceId)
    const newPinId = (ps!.pins as { id: string; nodeId: string }[]).find(x => x.nodeId === widgetId)!.id

    // The freshly-placed pin gets enriched by BrowserPrimitive (nx/ny → docX/docY,
    // context.url=pageUrlA). Assert on THAT pin specifically.
    await expect.poll(async () => {
      const cur = await getPinSet(page, spaceId)
      const p = (cur?.pins as { id: string; context?: { url?: string } }[] | undefined)?.find(x => x.id === newPinId)
      return p?.context?.url
    }, { timeout: 6000 }).toBe(pageUrlA)
    // Scope the marker assertion to the new pin's id (not .first()).
    const placed = page.getByTestId(`pin-marker-${newPinId}`)
    await expect(placed).toBeVisible({ timeout: 6000 })
    await page.screenshot({ path: `${SHOT_DIR}/05-browser-affordance-placed.png` })
    assertNoPinErrors(errors)
  })
})

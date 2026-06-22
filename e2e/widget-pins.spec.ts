// Runtime verification of the Widget Pins feature (host-owned widget capability)
// on a NON-browser widget — the run-workspace widget `run-R-241` seeded by
// FAST_SIM. Covers: hover affordance, marker render from the store (reliable
// API-inject path), bubble toggle, comment persistence round-trip, the
// drag-place iframe guard (`data-pin-dragging`), and Send gating.
//
// FAST_SIM topology (discovered via /api/state at runtime):
//   - one space, id is dynamic (e.g. `spc-...`) — read from /api/state.
//   - runs R-241.. each have a sessionId, so every run widget is session-backed
//     → resolveBackingSession('run-R-241') is non-null → pin Send is ENABLED.
//   - no editor/image/browser widgets are seeded by default, so the non-browser
//     widget under test is the run widget `run-R-241` (testid
//     `canvas-widget-run-R-241`). It uses the default PinLayer + affordance
//     (run-workspace registration sets neither pinnable:false nor
//     rendersOwnPinMarkers).
import { test, expect, type Page } from './fixtures'
import { mkdirSync } from 'node:fs'

const SHOT_DIR = '/tmp/pin-verify'
mkdirSync(SHOT_DIR, { recursive: true })

const NODE_ID = 'run-R-241'
const WIDGET_TESTID = `canvas-widget-${NODE_ID}` // canvas-widget-run-R-241
const PIN_ID = 'pin-e2e-1'

// The run-workspace widget is large (1320×1230); at default zoom its center can sit
// below the fold. Anchor injected pins near the top-left so the marker lands inside
// the viewport and is clickable. (The marker still renders correctly anywhere — see
// the "marker renders from the store" test, which only asserts visibility/position.)
const NX = 0.05
const NY = 0.04

/** Read the active space id straight from the server snapshot. */
async function activeSpaceId(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const r = await fetch('/api/state')
    return (await r.json()).activeSpaceId as string
  })
  expect(id, 'FAST_SIM should expose an active space id').toBeTruthy()
  return id
}

/** Read the persisted pin set for a space from /api/state (no GET /api/pins route). */
async function getPinSet(page: Page, spaceId: string) {
  return page.evaluate(async (sid: string) => {
    const r = await fetch('/api/state')
    const s = await r.json()
    return s.pinSets.find((p: { spaceId: string }) => p.spaceId === sid) ?? null
  }, spaceId)
}

/**
 * PUT a pin set via the real persistence route. The docstore lives for the whole
 * worker (the fixture is worker-scoped), so pins persist across tests in a worker
 * and the route's revision gate rejects any write whose rev is <= the stored rev
 * with 409 CONFLICT. To stay isolated, read the current rev and stamp rev+1.
 */
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

// Collect console + page errors per test so a pins-related runtime error fails loudly.
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  return errors
}

function assertNoPinErrors(errors: string[]) {
  const pinErrors = errors.filter(e =>
    /pin|usePinSet|PinLayer|PinMarker|PinBubble|CanvasWidgetShell/i.test(e),
  )
  expect(pinErrors, `pins-related console/page errors: ${pinErrors.join(' | ')}`).toHaveLength(0)
}

test.describe('Widget Pins (run-workspace, non-browser)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('tinstar-layouts-v3'))
    await page.reload()
    await page.waitForTimeout(500)
    await expect(page.getByTestId(WIDGET_TESTID)).toBeVisible({ timeout: 10000 })
  })

  // 1. Affordance appears on hover over a non-browser widget.
  test('hover reveals pin-drop affordance', async ({ page }) => {
    const errors = trackErrors(page)
    const widget = page.getByTestId(WIDGET_TESTID)
    await widget.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOT_DIR}/01-initial-canvas.png` })

    // Affordance is hover-gated — not present before hover.
    await expect(page.getByTestId('pin-drop-affordance')).toHaveCount(0)
    await widget.hover()
    await expect(page.getByTestId('pin-drop-affordance')).toBeVisible({ timeout: 3000 })
    await page.screenshot({ path: `${SHOT_DIR}/02-affordance-on-hover.png` })
    assertNoPinErrors(errors)
  })

  // 2. Marker renders from the store (reliable API-inject path), positioned over the widget.
  test('marker renders from the store via SSE after PUT', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    await putPinSet(page, spaceId, [
      { id: PIN_ID, nodeId: NODE_ID, nx: NX, ny: NY, comment: 'hello pin', createdAt: Date.now() },
    ])

    const marker = page.getByTestId(`pin-marker-${PIN_ID}`)
    // SSE should push the new pin set live (no reload needed).
    await expect(marker).toBeVisible({ timeout: 5000 })

    // Marker sits within the widget's bounds at the injected (nx, ny).
    const wb = await page.getByTestId(WIDGET_TESTID).boundingBox()
    const mb = await marker.boundingBox()
    if (!wb || !mb) throw new Error('widget/marker not visible')
    const mcx = mb.x + mb.width / 2
    const mcy = mb.y + mb.height / 2
    expect(mcx).toBeGreaterThan(wb.x)
    expect(mcx).toBeLessThan(wb.x + wb.width)
    expect(mcy).toBeGreaterThan(wb.y)
    expect(mcy).toBeLessThan(wb.y + wb.height)
    await page.screenshot({ path: `${SHOT_DIR}/03-marker-rendered.png` })
    assertNoPinErrors(errors)
  })

  // 3. Clicking the marker toggles its bubble open/closed.
  test('click toggles bubble open and closed', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    await putPinSet(page, spaceId, [
      { id: PIN_ID, nodeId: NODE_ID, nx: NX, ny: NY, comment: 'hello pin', createdAt: Date.now() },
    ])

    const marker = page.getByTestId(`pin-marker-${PIN_ID}`)
    await expect(marker).toBeVisible({ timeout: 5000 })
    const bubble = page.getByTestId(`pin-bubble-${PIN_ID}`)

    await expect(bubble).toHaveCount(0)
    await marker.click()
    await expect(bubble).toBeVisible({ timeout: 3000 })
    await page.screenshot({ path: `${SHOT_DIR}/04-bubble-open.png` })

    await marker.click()
    await expect(bubble).toHaveCount(0)
    assertNoPinErrors(errors)
  })

  // 4. Typing a comment + blur persists through the optimistic→PUT round-trip.
  test('comment edit persists to the server', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    await putPinSet(page, spaceId, [
      { id: PIN_ID, nodeId: NODE_ID, nx: NX, ny: NY, comment: '', createdAt: Date.now() },
    ])

    const marker = page.getByTestId(`pin-marker-${PIN_ID}`)
    await expect(marker).toBeVisible({ timeout: 5000 })
    await marker.click()

    const textarea = page.getByTestId(`pin-comment-${PIN_ID}`)
    await expect(textarea).toBeVisible({ timeout: 3000 })
    await textarea.fill('reviewed this region')
    await textarea.blur() // onBlur commits the draft → optimistic update + PUT

    // Poll the server snapshot until the persisted comment reflects the edit.
    await expect.poll(async () => {
      const ps = await getPinSet(page, spaceId)
      return ps?.pins?.find((p: { id: string }) => p.id === PIN_ID)?.comment
    }, { timeout: 5000 }).toBe('reviewed this region')
    assertNoPinErrors(errors)
  })

  // 5. Drag-to-place: a pointerdown on the affordance raises the canvas iframe guard
  //    (`data-pin-dragging='true'`); a pointermove into the widget body + pointerup
  //    drops a pin there and lowers the guard.
  //
  //    The gesture is driven by dispatched PointerEvents rather than Playwright's
  //    page.mouse. This is the same mechanism canvas-interactions.spec.ts uses for
  //    every drag: synthetic page.mouse events don't fire React's onPointerDown on
  //    these capture-based handles (verified directly — page.mouse.down() leaves
  //    data-pin-dragging null, while a dispatched PointerEvent sets it to "true").
  //    It exercises the real handlePinPlaceDown → onPinDragActive → guard path and
  //    the real handlePinPlaceUp → onCreatePin → PUT path; nothing is stubbed.
  test('drag-place sets/clears the canvas pin-dragging guard and drops a pin', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    const before = (await getPinSet(page, spaceId))?.pins?.length ?? 0

    const widget = page.getByTestId(WIDGET_TESTID)
    await widget.scrollIntoViewIfNeeded()
    await widget.hover()
    const affordance = page.getByTestId('pin-drop-affordance')
    await expect(affordance).toBeVisible({ timeout: 3000 })
    const canvas = page.getByTestId('infinite-canvas')

    // pointerdown on the affordance → guard raises.
    await affordance.evaluate(el => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        button: 0, pointerId: 1, bubbles: true, composed: true,
      }))
    })
    await expect(canvas).toHaveAttribute('data-pin-dragging', 'true', { timeout: 2000 })

    // pointermove to a point ~40% into the widget body, then pointerup → place + lower.
    // setPointerCapture keeps the stream on the affordance, so the move/up are
    // dispatched on it (mirroring the real capture behavior).
    const wb = await widget.boundingBox()
    if (!wb) throw new Error('widget not visible')
    const dropX = wb.x + wb.width * 0.4
    const dropY = wb.y + wb.height * 0.4
    await affordance.evaluate((el, { x, y }) => {
      el.dispatchEvent(new PointerEvent('pointermove', {
        clientX: x, clientY: y, pointerId: 1, bubbles: true, composed: true,
      }))
      el.dispatchEvent(new PointerEvent('pointerup', {
        clientX: x, clientY: y, pointerId: 1, bubbles: true, composed: true,
      }))
    }, { x: dropX, y: dropY })

    // Guard clears after release.
    await expect(canvas).not.toHaveAttribute('data-pin-dragging', 'true', { timeout: 2000 })

    // A new pin landed and persisted through the create → PUT round-trip.
    await expect.poll(async () => (await getPinSet(page, spaceId))?.pins?.length ?? 0, {
      timeout: 5000,
    }).toBe(before + 1)
    assertNoPinErrors(errors)
  })

  // 6. Send gating: run widgets are session-backed in FAST_SIM, so Send is ENABLED.
  //    (No session-less widget is seeded by default to assert the disabled case.)
  test('Send is enabled for a session-backed run widget and marks the pin sent', async ({ page }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)
    await putPinSet(page, spaceId, [
      { id: PIN_ID, nodeId: NODE_ID, nx: NX, ny: NY, comment: 'send me', createdAt: Date.now() },
    ])

    const marker = page.getByTestId(`pin-marker-${PIN_ID}`)
    await expect(marker).toBeVisible({ timeout: 5000 })
    await expect(marker).toHaveAttribute('data-sent', 'false')
    await marker.click()

    const submit = page.getByTestId(`pin-submit-${PIN_ID}`)
    await expect(submit).toBeVisible({ timeout: 3000 })
    // run-R-241 resolves to session R-241 → canSubmit true → Send enabled.
    await expect(submit).toBeEnabled()

    await submit.click()
    // After submit, sentAt is stamped and the marker flips to the sent state.
    await expect(marker).toHaveAttribute('data-sent', 'true', { timeout: 5000 })
    assertNoPinErrors(errors)
  })
})

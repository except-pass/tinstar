// E2E round-trip test for the note-reply thread feature.
//
// Exercises: drop a pin → type comment → Send → awaiting shimmer → agent reply
// via POST /api/notes/:id/replies → reply renders + shimmer gone → user follow-up
// reply → resolve → thread locked.
//
// Uses the same run-workspace widget (run-R-241) and harness helpers as
// widget-pins.spec.ts — the FAST_SIM backend is session-backed so Send is enabled.
import { test, expect, type Page } from './fixtures'
import { mkdirSync } from 'node:fs'

const SHOT_DIR = '/tmp/note-replies-verify'
mkdirSync(SHOT_DIR, { recursive: true })

const NODE_ID = 'run-R-241'
const WIDGET_TESTID = `canvas-widget-${NODE_ID}`

// Near top-left so the marker lands in-viewport after drop.
const NX = 0.05
const NY = 0.04

/** Read the active space id from the server snapshot (same pattern as widget-pins.spec.ts). */
async function activeSpaceId(page: Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const r = await fetch('/api/state')
    return (await r.json()).activeSpaceId as string
  })
  expect(id, 'FAST_SIM should expose an active space id').toBeTruthy()
  return id
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

/** Read persisted pin set for a space from the server snapshot. */
async function getPinSet(page: Page, spaceId: string) {
  return page.evaluate(async (sid: string) => {
    const r = await fetch('/api/state')
    const s = await r.json()
    return s.pinSets.find((p: { spaceId: string }) => p.spaceId === sid) ?? null
  }, spaceId)
}

// Collect console + page errors per test so a reply-related runtime error fails loudly.
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  return errors
}

function assertNoReplyErrors(errors: string[]) {
  const replyErrors = errors.filter(e =>
    /pin|note|reply|PinBubble|PinLayer|PinMarker|usePinSet/i.test(e),
  )
  expect(replyErrors, `reply-related console/page errors: ${replyErrors.join(' | ')}`).toHaveLength(0)
}

test.describe('Note Replies — thread round-trip', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('tinstar-layouts-v3'))
    await page.reload()
    await page.waitForTimeout(500)
    await expect(page.getByTestId(WIDGET_TESTID)).toBeVisible({ timeout: 10000 })
  })

  test('full thread round-trip: send → agent reply → follow-up → resolve', async ({ page, serverUrl }) => {
    const errors = trackErrors(page)
    const spaceId = await activeSpaceId(page)

    // ── Step 1: inject a pin via API (same reliable path as widget-pins.spec.ts) ──
    // We inject directly rather than driving the affordance drag so we control the
    // id and can reliably reference testids. The drag-place path is already covered
    // by widget-pins.spec.ts test 5. Use a fresh id to avoid collisions with other
    // workers sharing the same FAST_SIM seed.
    const PIN_ID = `note-reply-e2e-${Date.now()}`
    await putPinSet(page, spaceId, [
      { id: PIN_ID, nodeId: NODE_ID, nx: NX, ny: NY, comment: 'what is this?', createdAt: Date.now() },
    ])

    const marker = page.getByTestId(`pin-marker-${PIN_ID}`)
    await expect(marker).toBeVisible({ timeout: 5000 })

    // ── Step 2: open the bubble and Send the comment ──
    await expect(marker).toHaveAttribute('data-sent', 'false')
    await marker.click()

    const submit = page.getByTestId(`pin-submit-${PIN_ID}`)
    await expect(submit).toBeVisible({ timeout: 3000 })
    await expect(submit).toBeEnabled()  // run-R-241 is session-backed → canSubmit=true
    await submit.click()

    await page.screenshot({ path: `${SHOT_DIR}/01-after-send.png` })

    // ── Step 3: marker flips to sent; bubble shows awaiting shimmer ──
    await expect(marker).toHaveAttribute('data-sent', 'true', { timeout: 5000 })

    // Re-open the bubble (it may have closed after send, or may stay open — click the
    // marker to ensure the bubble is open either way).
    const bubble = page.getByTestId(`pin-bubble-${PIN_ID}`)
    if (await bubble.count() === 0) {
      await marker.click()
    }
    await expect(bubble).toBeVisible({ timeout: 3000 })
    const awaiting = page.getByTestId(`pin-awaiting-${PIN_ID}`)
    await expect(awaiting).toBeVisible({ timeout: 3000 })

    await page.screenshot({ path: `${SHOT_DIR}/02-awaiting-shimmer.png` })

    // ── Step 4: agent replies via POST /api/notes/:id/replies ──
    // Playwright's `request` fixture uses its own base URL, so construct the full URL
    // from the same serverUrl the page fixture wired into the browser context.
    const replyRes = await page.request.post(`${serverUrl}/api/notes/${PIN_ID}/replies`, {
      data: { text: 'agent answer' },
    })
    expect(replyRes.status(), 'POST /api/notes/:id/replies should succeed').toBe(200)

    await page.screenshot({ path: `${SHOT_DIR}/03-after-agent-reply-post.png` })

    // ── Step 5: reply text renders in the thread; shimmer gone ──
    // SSE pushes the updated pin set live — no page reload needed.
    await expect(page.getByText('agent answer')).toBeVisible({ timeout: 6000 })
    await expect(awaiting).toHaveCount(0, { timeout: 3000 })

    await page.screenshot({ path: `${SHOT_DIR}/04-agent-reply-rendered.png` })

    // ── Step 6: user sends a follow-up reply ──
    const replyInput = page.getByTestId(`pin-reply-input-${PIN_ID}`)
    await expect(replyInput).toBeVisible({ timeout: 3000 })
    await replyInput.fill('follow-up question')

    const replySend = page.getByTestId(`pin-reply-send-${PIN_ID}`)
    await expect(replySend).toBeEnabled()
    await replySend.click()

    // The follow-up should appear in the thread.
    await expect(page.getByText('follow-up question')).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: `${SHOT_DIR}/05-after-followup.png` })

    // ── Step 7: verify follow-up was written to the server ──
    await expect.poll(async () => {
      const ps = await getPinSet(page, spaceId)
      const pin = (ps?.pins as { id: string; replies?: { text: string }[] }[] | undefined)?.find(p => p.id === PIN_ID)
      return pin?.replies?.some(r => r.text === 'follow-up question') ?? false
    }, { timeout: 5000 }).toBe(true)

    // ── Step 8: resolve the note ──
    const resolveBtn = page.getByTestId(`pin-resolve-${PIN_ID}`)
    await expect(resolveBtn).toBeVisible({ timeout: 3000 })
    await resolveBtn.click()

    // Marker gains data-resolved="true".
    await expect(marker).toHaveAttribute('data-resolved', 'true', { timeout: 5000 })

    await page.screenshot({ path: `${SHOT_DIR}/06-resolved.png` })

    // Re-open bubble to verify reply input is gone (thread locked on resolve).
    if (await bubble.count() === 0) {
      await marker.click()
    }
    await expect(bubble).toBeVisible({ timeout: 3000 })
    await expect(page.getByTestId(`pin-reply-input-${PIN_ID}`)).toHaveCount(0)

    await page.screenshot({ path: `${SHOT_DIR}/07-resolved-bubble.png` })

    assertNoReplyErrors(errors)
  })
})

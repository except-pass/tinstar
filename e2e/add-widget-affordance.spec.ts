// pluginTest boots the server WITHOUT TINSTAR_NO_SESSIONS so ctx.sessionConfig is
// populated and /api/plugin-widgets/registry returns the browser-widget entry from
// the bundled browser plugin's package.json. This is required for the add-widget picker
// to list browser-widget as a spawnable option.
import { pluginTest as test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Add-widget ghost [+] affordance', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  // True when the locator's bounding box lies fully within the viewport — i.e. a
  // real user could actually click it. The old test used dispatchEvent to bypass
  // this check, so it passed even when the affordance rendered off-screen.
  async function isInViewport(page: import('@playwright/test').Page, locator: import('@playwright/test').Locator): Promise<boolean> {
    const box = await locator.boundingBox()
    const vp = page.viewportSize()
    if (!box || !vp) return false
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height
  }

  test('ghost [+] grows a constellation', async ({ page }) => {
    // R-241 is a run-workspace widget (non-container) seeded by FAST_SIM.
    // run-workspace is isContainer:false so the ghost [+] buttons render on hover/select.
    const widget = page.getByTestId('canvas-widget-run-R-241')
    await expect(widget).toBeVisible()

    // run-workspace (1320×1230) is larger than the test viewport, so at 100% zoom
    // none of its edge buttons are on-screen. Zoom out (Ctrl+wheel, like a real
    // user) until the whole widget — and thus its edge affordances — fits, so the
    // interaction below can use genuine clicks instead of dispatchEvent.
    const canvas = page.getByTestId('infinite-canvas')
    const cbox = await canvas.boundingBox()
    expect(cbox).not.toBeNull()
    await page.mouse.move(cbox!.x + cbox!.width / 2, cbox!.y + cbox!.height / 2)
    await page.keyboard.down('Control')
    for (let i = 0; i < 3 && (await widget.boundingBox())!.width > cbox!.width * 0.6; i++) {
      await page.mouse.wheel(0, 200)  // deltaY>0 → zoom out toward cursor
      await page.waitForTimeout(100)
    }
    await page.keyboard.up('Control')
    // Confirm the zoom actually dropped below 100% (the wheel gesture took effect).
    await expect(page.getByTestId('zoom-indicator')).not.toHaveText('100%')

    // Hover the widget near a corner (clear of the edge-centered [+] buttons,
    // which would otherwise intercept a center hover on the now-small widget) to
    // trigger onPointerEnter and reveal the ghost [+] buttons.
    await widget.hover({ position: { x: 24, y: 24 } })
    // Brief pause so React's onPointerEnter state update flushes and the buttons are rendered.
    await page.waitForTimeout(200)

    // run-workspace is larger than the viewport, so not every edge button is
    // on-screen — and some overlap the canvas sidebar. Pick an edge whose button
    // is genuinely actionable (in viewport, unobscured, stable) via a trial click,
    // then drive a real user click (no dispatchEvent escape hatch). Requiring at
    // least one such edge proves the affordance is actually usable; a positioning
    // regression that pushed every button off-screen or under chrome would fail.
    let clicked = false
    for (const edge of ['top', 'left', 'bottom', 'right'] as const) {
      const btn = widget.locator(`[data-testid="add-widget-btn-${edge}"]`)
      if ((await btn.count()) === 0) continue
      if (!(await isInViewport(page, btn))) continue
      try {
        await btn.click({ trial: true, timeout: 1000 })  // actionability check only
      } catch {
        continue  // off-screen or obscured by canvas chrome — not a real-user target
      }
      await btn.click()
      clicked = true
      break
    }
    expect(clicked, 'at least one add-widget [+] edge button must be reachable and clickable').toBe(true)

    // Picker opens listing spawnable widget types
    const picker = page.locator('[data-testid="add-widget-picker"]')
    await expect(picker).toBeVisible()
    expect(await isInViewport(page, picker), 'add-widget picker must render inside the viewport').toBe(true)

    // browser-widget is contributed by the bundled browser plugin with capabilities:["spawnable"]
    const browserOption = picker.locator('[data-testid="add-widget-option-browser-widget"]')
    await expect(browserOption).toBeVisible()
    expect(await isInViewport(page, browserOption), 'browser-widget option must be clickable in the viewport').toBe(true)
    await browserOption.click()

    // FAST_SIM does not seed any browser widgets, so exactly one should now exist
    const browserWidget = page.locator('[data-widget-type="browser-widget"]')
    await expect(browserWidget).toHaveCount(1)

    // The affordance must actually GROW A CONSTELLATION, not merely create a widget.
    // R-241 starts unslotted, so adding next to it forms a new constellation holding
    // both the source run and the new widget in one slot, plus a snap edge between
    // them. Assert that persisted state directly (poll until the optimistic write
    // echoes back to the server).
    const sourceNode = 'run-R-241'
    await expect.poll(async () => {
      const state = await page.request.get('/api/state').then(r => r.json())
      const spaceId: string = state.activeSpaceId ?? state.spaces?.[0]?.id
      const graph = (state.constellationGraphs ?? []).find((g: { spaceId: string }) => g.spaceId === spaceId)
      if (!graph) return null
      const sourceSlots = graph.members.filter((m: { widget: string }) => m.widget === sourceNode).map((m: { slot: string }) => m.slot)
      if (sourceSlots.length !== 1) return null
      const slot = sourceSlots[0]
      const slotMembers: string[] = graph.members.filter((m: { slot: string }) => m.slot === slot).map((m: { widget: string }) => m.widget)
      const partner = slotMembers.find((w) => w !== sourceNode)
      const snapped = (graph.snapped ?? []).some(([a, b]: [string, string]) => (a === sourceNode || b === sourceNode))
      return { memberCount: slotMembers.length, hasPartner: Boolean(partner), snapped }
    }, { timeout: 5000 }).toEqual({ memberCount: 2, hasPartner: true, snapped: true })
  })
})

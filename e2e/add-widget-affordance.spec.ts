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

  test('ghost [+] grows a constellation', async ({ page }) => {
    // R-241 is a run-workspace widget (non-container) seeded by FAST_SIM.
    // run-workspace is isContainer:false so the ghost [+] buttons render on hover/select.
    const widget = page.getByTestId('canvas-widget-run-R-241')
    await expect(widget).toBeVisible()

    // Hover the widget header (drag handle) to trigger onPointerEnter and reveal the ghost [+] buttons.
    // Using the .widget-drag-handle avoids sub-controls and is consistent with run-interactions.spec.ts.
    const header = widget.locator('.widget-drag-handle').first()
    await expect(header).toBeVisible()
    await header.hover()
    // Brief pause so React's onPointerEnter state update flushes and the buttons are rendered.
    await page.waitForTimeout(200)

    const addRight = widget.locator('[data-testid="add-widget-btn-right"]')
    await expect(addRight).toBeVisible()

    // The right-edge button extends 50% outside the widget's right edge via CSS translate.
    // dispatchEvent bypasses Playwright's viewport-clip check (same pattern used in plugin-widget-spawn.spec.ts).
    await addRight.dispatchEvent('click')

    // Picker opens listing spawnable widget types
    const picker = page.locator('[data-testid="add-widget-picker"]')
    await expect(picker).toBeVisible()

    // browser-widget is contributed by the bundled browser plugin with capabilities:["spawnable"]
    const browserOption = picker.locator('[data-testid="add-widget-option-browser-widget"]')
    await expect(browserOption).toBeVisible()
    // Picker is rendered at the button's off-screen position (fixed, CSS-transformed canvas).
    // dispatchEvent bypasses Playwright's viewport-clip check.
    await browserOption.dispatchEvent('click')

    // FAST_SIM does not seed any browser widgets, so exactly one should now exist
    await expect(page.locator('[data-widget-type="browser-widget"]')).toHaveCount(1)
  })
})

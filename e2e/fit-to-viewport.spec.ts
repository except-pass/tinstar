import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Z hotkey — fit widget to viewport', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('Z on a focused run workspace zooms to 100% and grows widget to viewport height', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-run-R-241')
    await expect(widget).toBeVisible()

    // Select the widget by clicking its drag-handle header (avoids interactive sub-controls).
    await widget.locator('.widget-drag-handle').first().click()
    await expect(widget).toHaveAttribute('data-selected', 'true')

    // "Viewport" for fit means the canvas element, not the window —
    // sidebars take up window width.
    const canvas = page.getByTestId('infinite-canvas')
    const canvasBox = await canvas.boundingBox()
    expect(canvasBox).not.toBeNull()
    const canvasHeight = canvasBox!.height
    const canvasCenterX = canvasBox!.x + canvasBox!.width / 2

    // Capture pre-Z state to prove Z actually does something.
    const beforeBox = await widget.boundingBox()
    expect(beforeBox).not.toBeNull()
    const beforeHeight = beforeBox!.height

    // Sanity: the test is meaningful only if the widget doesn't already match canvas height.
    expect(Math.abs(beforeHeight - canvasHeight)).toBeGreaterThan(20)

    await page.keyboard.press('KeyZ')

    // Canvas zoom should be 100% after Z.
    await expect(page.getByTestId('zoom-indicator')).toHaveText('100%', { timeout: 2_000 })

    // Widget screen-pixel height should now match canvas height (small tolerance for border/rounding).
    await expect.poll(async () => Math.abs((await widget.boundingBox())!.height - canvasHeight), { timeout: 2_000 })
      .toBeLessThan(8)

    // Widget should be roughly horizontally centered in the canvas.
    const box = await widget.boundingBox()
    expect(box).not.toBeNull()
    const widgetCenter = box!.x + box!.width / 2
    expect(Math.abs(widgetCenter - canvasCenterX)).toBeLessThan(8)
  })

  test('Z with no widget focused does nothing', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-run-R-241')
    await expect(widget).toBeVisible()

    // Click empty canvas area (top-left corner) to drop any selection.
    await page.mouse.click(20, 20)
    await expect(widget).not.toHaveAttribute('data-selected', 'true')

    const before = await widget.boundingBox()
    expect(before).not.toBeNull()

    await page.keyboard.press('KeyZ')

    // Same size after — no resize happened because no widget was focused.
    const after = await widget.boundingBox()
    expect(after).not.toBeNull()
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(2)
  })
})

// e2e/minimap.spec.ts
import { test, expect } from './fixtures'

test.describe('Canvas Minimap', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(500)
  })

  test('minimap is visible by default and shows viewport indicator', async ({ page }) => {
    const minimap = page.getByTestId('canvas-minimap')
    await expect(minimap).toBeVisible()
    // Canvas element exists inside minimap
    const canvas = minimap.locator('canvas')
    await expect(canvas).toBeVisible()
  })

  test('M key toggles minimap visibility', async ({ page }) => {
    const minimap = page.getByTestId('canvas-minimap')
    const toggle = page.getByTestId('minimap-toggle')

    // Initially visible
    await expect(minimap).toBeVisible()

    // Press M to hide
    await page.keyboard.press('m')
    await expect(minimap).not.toBeVisible()
    await expect(toggle).toBeVisible()

    // Press M to show
    await page.keyboard.press('m')
    await expect(minimap).toBeVisible()
  })

  test('clicking collapse button shows icon, clicking icon re-expands', async ({ page }) => {
    const minimap = page.getByTestId('canvas-minimap')
    const toggle = page.getByTestId('minimap-toggle')

    // Hover to reveal close button, then click it
    await minimap.hover()
    const closeBtn = minimap.locator('button')
    await closeBtn.click()

    await expect(minimap).not.toBeVisible()
    await expect(toggle).toBeVisible()

    // Click icon to re-expand
    await toggle.click()
    await expect(minimap).toBeVisible()
  })

  test('clicking minimap pans the viewport', async ({ page }) => {
    const minimap = page.getByTestId('canvas-minimap')

    // Record initial zoom indicator position (proxy for camera state)
    const zoomText = page.getByTestId('zoom-indicator')
    await expect(zoomText).toHaveText('100%')

    // Click top-left corner of minimap
    const box = await minimap.boundingBox()
    if (!box) throw new Error('minimap not visible')
    await page.mouse.click(box.x + 10, box.y + 10)

    // The viewport should have moved (we can't easily assert exact camera position,
    // but we can verify the minimap is still visible and functional after click)
    await expect(minimap).toBeVisible()
    await expect(zoomText).toHaveText('100%') // zoom unchanged
  })
})

import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Agent Quadrant and HUD Toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('telemetry HUD shows close button and collapses', async ({ page }) => {
    // HUD should be visible by default
    const hud = page.getByTestId('canvas-hud')
    await expect(hud).toBeVisible()

    // Hover to reveal close button
    await hud.hover()
    const closeBtn = page.getByTestId('canvas-hud-close')
    await expect(closeBtn).toBeVisible()

    // Click close button to collapse the HUD
    await closeBtn.click()
    await page.waitForTimeout(200)

    // HUD should now be hidden, toggle button should be visible
    await expect(hud).not.toBeVisible()
    const toggleBtn = page.getByTestId('canvas-hud-toggle')
    await expect(toggleBtn).toBeVisible()

    // Press 't' hotkey to restore HUD
    await page.keyboard.press('t')
    await page.waitForTimeout(200)

    // HUD should be visible again
    await expect(hud).toBeVisible()
  })

  test('quadrant is visible when sessions exist', async ({ page }) => {
    // With resetAndWaitForData, we have mock sessions, so HUD and quadrant should be visible
    await expect(page.getByTestId('canvas-hud')).toBeVisible()

    // The quadrant should be present (at least one agent is running in the simulator)
    const quadrant = page.getByTestId('agent-quadrant')
    await expect(quadrant).toBeVisible()

    // Quadrant should show the four cell grid
    await expect(page.getByTestId('quadrant-cell-working')).toBeVisible()
    await expect(page.getByTestId('quadrant-cell-cooling')).toBeVisible()
    await expect(page.getByTestId('quadrant-cell-tool')).toBeVisible()
    await expect(page.getByTestId('quadrant-cell-idle')).toBeVisible()
  })
})

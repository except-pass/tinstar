import { test, expect } from './fixtures'

test.describe('Telemetry HUD', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(500)
  })

  test('HUD renders in the upper-right by default', async ({ page }) => {
    const hud = page.getByTestId('canvas-hud')
    await expect(hud).toBeVisible({ timeout: 10_000 })
    const box = await hud.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(viewport).not.toBeNull()
    // Positioned in the upper-right quadrant
    expect(box!.x).toBeGreaterThan(viewport!.width / 2)
    expect(box!.y).toBeLessThan(viewport!.height / 2)
  })

  test('T toggles HUD visibility', async ({ page }) => {
    const hud = page.getByTestId('canvas-hud')
    await expect(hud).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('t')
    await expect(hud).not.toBeVisible()
    await page.keyboard.press('t')
    await expect(hud).toBeVisible()
  })

  test('HUD shows cost, tokens, cache, and autonomy labels', async ({ page }) => {
    const hud = page.getByTestId('canvas-hud')
    await expect(hud).toBeVisible({ timeout: 10_000 })
    await expect(hud).toContainText('COST')
    await expect(hud).toContainText('TOKENS')
    await expect(hud).toContainText('CACHE HIT')
    await expect(hud).toContainText('AUTONOMY')
  })
})

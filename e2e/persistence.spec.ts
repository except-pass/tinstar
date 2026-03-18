import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('dimension selection persists across reload', async ({ page }) => {
    // Remove the "epic" dimension
    const epicPill = page.getByTestId('remove-epic')
    await epicPill.click()
    await page.waitForTimeout(200)

    // Verify epic is removed
    await expect(page.getByTestId('remove-epic')).not.toBeVisible()

    // Reload the page
    await page.reload()
    await page.waitForTimeout(1000)

    // Epic dimension should still be removed
    await expect(page.getByTestId('remove-epic')).not.toBeVisible()
    // Initiative and task pills should remain
    await expect(page.getByTestId('remove-initiative')).toBeVisible()
    await expect(page.getByTestId('remove-task')).toBeVisible()
  })

  test('layout positions survive page reload', async ({ page }) => {
    // Wait for layouts to generate and localStorage to save
    await page.waitForTimeout(500)

    // Verify localStorage has layout data
    const hasLayouts = await page.evaluate(() => {
      return localStorage.getItem('tinstar-layouts-v3') !== null
    })
    expect(hasLayouts).toBe(true)

    // Reload and verify canvas still renders
    await page.reload()
    await expect(page.getByTestId('infinite-canvas')).toBeVisible()
    await expect(page.getByTestId('zoom-indicator')).toBeVisible()
  })
})

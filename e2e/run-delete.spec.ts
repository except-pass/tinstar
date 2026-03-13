import { test, expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test.describe('Run Deletion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('deleting a run via API removes it from sidebar and canvas', async ({ page }) => {
    // Expand the hierarchy to see runs
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.getByTestId('chevron-epic-epic-1').click()
    await page.getByTestId('chevron-task-task-1').click()
    await page.waitForTimeout(300)

    // R-251 (CLD-4102) is under task-1; verify it's visible
    const sidebar = page.getByTestId('hierarchy-sidebar')
    const runNode = sidebar.getByTestId('sidebar-node-run-R-251')
    await expect(runNode).toBeVisible({ timeout: 3000 })

    // Also verify the canvas widget exists
    const widget = page.getByTestId('canvas-widget-R-251')
    await expect(widget).toBeVisible()

    // Delete the run via API (simulates what handleDelete does)
    await page.evaluate(() => fetch('/api/sessions/R-251', { method: 'DELETE' }))
    await page.waitForTimeout(500)

    // Run should be gone from sidebar
    await expect(runNode).not.toBeVisible()

    // Run should be gone from canvas
    await expect(widget).not.toBeVisible()
  })

  test('deleting a non-existent session still removes the run from UI', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')

    // Expand to see R-251 (session CLD-4102 doesn't exist on disk)
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.getByTestId('chevron-epic-epic-1').click()
    await page.getByTestId('chevron-task-task-1').click()
    await page.waitForTimeout(300)

    const runNode = sidebar.getByTestId('sidebar-node-run-R-251')
    await expect(runNode).toBeVisible({ timeout: 3000 })

    // Count runs before
    const widgetsBefore = await page.locator('[data-testid^="canvas-widget-"]').count()

    // Delete via API — session file doesn't exist, should still succeed
    const res = await page.evaluate(() =>
      fetch('/api/sessions/R-251', { method: 'DELETE' }).then(r => r.json())
    )
    expect(res.ok).toBe(true)

    await page.waitForTimeout(500)

    // Run removed from sidebar
    await expect(runNode).not.toBeVisible()

    // One fewer widget on canvas
    const widgetsAfter = await page.locator('[data-testid^="canvas-widget-"]').count()
    expect(widgetsAfter).toBe(widgetsBefore - 1)
  })
})

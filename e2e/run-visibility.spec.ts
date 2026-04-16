import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

/**
 * Per-run visibility ("eyeball") — hidden runs stay in the sidebar (dimmed) but
 * are pruned from the canvas and skipped by Ctrl+[ / Ctrl+] cycling, like Figma
 * layer visibility.
 */
test.describe('Run visibility eyeball', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Clear any hidden-run state from a prior test in this worker (same context
    // shares localStorage).
    await page.evaluate(() => localStorage.removeItem('tinstar-hidden-runs'))
    await resetAndWaitForData(page)

    // Expand the tree so R-241's sidebar row is visible.
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.getByTestId('chevron-epic-epic-1').click()
    await page.getByTestId('chevron-task-task-1').click()
    await expect(page.getByTestId('sidebar-node-run-R-241')).toBeVisible()
  })

  test('clicking the eyeball hides the run from the canvas and keeps it in the sidebar', async ({ page }) => {
    const sidebarRow = page.getByTestId('sidebar-node-run-R-241')
    const widget = page.getByTestId('canvas-widget-run-R-241')
    const eyeball = page.getByTestId('run-visibility-run-R-241')

    await expect(widget).toBeVisible()

    // Hover to reveal the eyeball, then click it.
    await sidebarRow.hover()
    await expect(eyeball).toBeVisible()
    await eyeball.click()

    // Canvas widget is gone; sidebar row remains.
    await expect(widget).toHaveCount(0)
    await expect(sidebarRow).toBeVisible()

    // Eyeball stays visible (closed state) so the user can restore.
    await expect(eyeball).toBeVisible()

    // Toggle again to show.
    await eyeball.click()
    await expect(widget).toBeVisible()
  })

  test('Ctrl+] does not land on a hidden run', async ({ page }) => {
    // Hide R-241 via its sidebar eyeball.
    const row241 = page.getByTestId('sidebar-node-run-R-241')
    await row241.hover()
    await page.getByTestId('run-visibility-run-R-241').click()
    await expect(page.getByTestId('canvas-widget-run-R-241')).toHaveCount(0)

    // Select a different run as the starting point for cycling.
    const otherRun = page.locator('[data-testid^="canvas-widget-run-"]').first()
    await otherRun.click()

    // Cycle forward through sessions several times; we should never select R-241.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Control+BracketRight')
      await expect(page.getByTestId('sidebar-node-run-R-241')).not.toHaveClass(/bg-primary/)
    }
  })

  test('hidden state persists across reload', async ({ page }) => {
    const row = page.getByTestId('sidebar-node-run-R-241')
    await row.hover()
    await page.getByTestId('run-visibility-run-R-241').click()
    await expect(page.getByTestId('canvas-widget-run-R-241')).toHaveCount(0)

    await page.reload()

    // Re-expand the tree after reload to see the sidebar row.
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.getByTestId('chevron-epic-epic-1').click()
    await page.getByTestId('chevron-task-task-1').click()

    // Sidebar row is still there (dimmed); widget is not.
    await expect(page.getByTestId('sidebar-node-run-R-241')).toBeVisible()
    await expect(page.getByTestId('canvas-widget-run-R-241')).toHaveCount(0)
    // Closed eyeball is visible (without hover) to hint at the hidden state.
    await expect(page.getByTestId('run-visibility-run-R-241')).toBeVisible()
  })
})

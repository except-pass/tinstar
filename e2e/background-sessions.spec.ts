import { test, expect, type Page } from './fixtures'
import { resetAndWaitForData } from './helpers'

/**
 * Background sessions — server-persisted `background` flag that prunes a run
 * from the canvas, hierarchy sidebar, session cycling, and passive inbox rows
 * (unlike the eyeball, which keeps the row dimmed in the sidebar). A reveal
 * toggle in the hierarchy header shows them marked; needs-attention state
 * breaks through everywhere until handled.
 */

/** PATCH /api/runs/:id through the app origin; throws on a non-2xx response. */
async function patchRun(page: Page, id: string, body: Record<string, unknown>) {
  const status = await page.evaluate(async ({ id, body }) => {
    const res = await fetch(`/api/runs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.status
  }, { id, body })
  if (status < 200 || status >= 300) throw new Error(`PATCH /api/runs/${id} failed: ${status}`)
}

test.describe('Background sessions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Clear per-browser view state from a prior test in this worker (same
    // context shares localStorage): eyeball hides and the uiPrefs singleton
    // that carries the showBackgroundSessions toggle.
    await page.evaluate(() => {
      localStorage.removeItem('tinstar-hidden-runs')
      localStorage.removeItem('tinstar-ui-prefs')
    })
    await resetAndWaitForData(page)

    // Expand the tree so R-241's sidebar row is visible.
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.getByTestId('chevron-epic-epic-1').click()
    await page.getByTestId('chevron-task-task-1').click()
    await expect(page.getByTestId('sidebar-node-run-R-241')).toBeVisible()
  })

  test('demoting a run to background removes it from canvas, sidebar, and passive inbox', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-run-R-241')
    const sidebarRow = page.getByTestId('sidebar-node-run-R-241')

    await expect(widget).toBeVisible()

    // Passive inbox row exists while the run is visible.
    await page.getByTestId('sidebar-tab-inbox').click()
    await expect(page.getByTestId('inbox-row-R-241')).toBeVisible()
    await page.getByTestId('sidebar-tab-hierarchy').click()

    await patchRun(page, 'R-241', { background: true })

    // Canvas widget AND sidebar row are gone — unlike eyeball-hidden runs,
    // which keep a dimmed sidebar row.
    await expect(widget).toHaveCount(0, { timeout: 5000 })
    await expect(sidebarRow).toHaveCount(0)

    // Sibling run under the same task is untouched (the prune is per-run,
    // not a collapsed container).
    await expect(page.getByTestId('sidebar-node-run-R-251')).toBeVisible()

    // No passive inbox row either; the inbox itself still lists other runs.
    await page.getByTestId('sidebar-tab-inbox').click()
    await expect(page.getByTestId('inbox-list')).toBeVisible()
    await expect(page.getByTestId('inbox-row-R-242')).toBeVisible()
    await expect(page.getByTestId('inbox-row-R-241')).toHaveCount(0)
  })

  test('Ctrl+] cycling never lands on a hidden background run', async ({ page }) => {
    // Expand task-2 so R-242 (idle → in the ready queue) is cycle-visible.
    await page.getByTestId('chevron-task-task-2').click()
    const row242 = page.getByTestId('sidebar-node-run-R-242')
    await expect(row242).toBeVisible()

    // Positive control: while visible, cycling CAN land on R-242 (it is the
    // only ready-queue run whose task is expanded). Select the starting run
    // via its sidebar row — canvas cards can drift outside the viewport after
    // camera moves, and the infinite canvas isn't scrollable by locator click.
    await page.getByTestId('sidebar-node-run-R-241').click()
    await page.keyboard.press('Control+BracketRight')
    await expect(row242).toHaveClass(/bg-primary/)

    await patchRun(page, 'R-242', { background: true })
    await expect(page.getByTestId('canvas-widget-run-R-242')).toHaveCount(0, { timeout: 5000 })
    await expect(row242).toHaveCount(0)

    // Re-select a visible run as the cycling starting point.
    await page.getByTestId('sidebar-node-run-R-241').click()

    // Cycle forward several times; the background run never reappears on any
    // surface (a landing would mount its row/widget as selected).
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Control+BracketRight')
      await expect(page.getByTestId('sidebar-node-run-R-242')).toHaveCount(0)
      await expect(page.getByTestId('canvas-widget-run-R-242')).toHaveCount(0)
    }
  })

  test('reveal toggle shows background runs with badge and chip, and hides them again', async ({ page }) => {
    const toggle = page.getByTestId('sidebar-background-toggle')
    const count = page.getByTestId('sidebar-background-toggle-count')

    // No background runs yet.
    await expect(count).toHaveText('0')

    await patchRun(page, 'R-241', { background: true })
    await expect(page.getByTestId('canvas-widget-run-R-241')).toHaveCount(0, { timeout: 5000 })
    await expect(page.getByTestId('sidebar-node-run-R-241')).toHaveCount(0)

    // Count reflects the space's background runs even while the toggle is off.
    await expect(count).toHaveText('1')

    // Toggle on: sidebar row returns with the BG badge; canvas card returns
    // with the background chip.
    await toggle.click()
    await expect(page.getByTestId('sidebar-node-run-R-241')).toBeVisible()
    await expect(page.getByTestId('sidebar-background-badge-run-R-241')).toBeVisible()
    await expect(page.getByTestId('canvas-widget-run-R-241')).toBeVisible()
    await expect(page.getByTestId('background-chip-R-241')).toBeVisible()

    // Non-background sibling never grows a badge.
    await expect(page.getByTestId('sidebar-background-badge-run-R-251')).toHaveCount(0)

    // Toggle off: pruned again.
    await toggle.click()
    await expect(page.getByTestId('sidebar-node-run-R-241')).toHaveCount(0)
    await expect(page.getByTestId('canvas-widget-run-R-241')).toHaveCount(0)
  })

  test('attention breaks through pruning and returns to invisible when cleared', async ({ page }) => {
    await patchRun(page, 'R-241', { background: true })
    await expect(page.getByTestId('canvas-widget-run-R-241')).toHaveCount(0, { timeout: 5000 })
    await expect(page.getByTestId('sidebar-node-run-R-241')).toHaveCount(0)

    // Urgent attention (e.g. a permission prompt) breaks through with the
    // reveal toggle still OFF: canvas card + sidebar row render, marked as
    // background, and an inbox row appears.
    await patchRun(page, 'R-241', { attention: { level: 'urgent', reason: 'Waiting on permission' } })

    await expect(page.getByTestId('canvas-widget-run-R-241')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('background-chip-R-241')).toBeVisible()
    await expect(page.getByTestId('sidebar-node-run-R-241')).toBeVisible()
    await expect(page.getByTestId('sidebar-background-badge-run-R-241')).toBeVisible()

    await page.getByTestId('sidebar-tab-inbox').click()
    const inboxRow = page.getByTestId('inbox-row-R-241')
    await expect(inboxRow).toBeVisible()
    await expect(inboxRow).toContainText('Waiting on permission')

    // Clearing the attention returns the run to invisibility on every
    // surface — no toggle interaction needed.
    await patchRun(page, 'R-241', { attention: null })
    await expect(page.getByTestId('inbox-row-R-241')).toHaveCount(0, { timeout: 5000 })

    await page.getByTestId('sidebar-tab-hierarchy').click()
    await expect(page.getByTestId('sidebar-node-run-R-241')).toHaveCount(0)
    await expect(page.getByTestId('canvas-widget-run-R-241')).toHaveCount(0)
  })
})

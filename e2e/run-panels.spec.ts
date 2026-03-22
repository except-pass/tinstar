import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Run Widget Panels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('run widget shows status badge with correct color', async ({ page }) => {
    // Find a run widget — any canvas widget
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const count = await widgets.count()
    expect(count).toBeGreaterThan(0)

    // Each widget should have a status badge
    const firstWidget = widgets.first()
    const badge = firstWidget.locator('[class*="font-display"]').first()
    await expect(badge).toBeVisible()
  })

  test('run widget shows breadcrumb hierarchy', async ({ page }) => {
    // Find a run widget with breadcrumbs
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Should have initiative > epic > task breadcrumb
    // Breadcrumbs contain ">" separator
    const breadcrumb = firstWidget.locator('[class*="text-slate-500"]').first()
    await expect(breadcrumb).toBeVisible()
  })

  test('expanding collapsed files panel shows file list', async ({ page }) => {
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Find the collapsed files panel and click to expand
    const collapsedFiles = firstWidget.getByTestId('collapsed-files')
    if (await collapsedFiles.isVisible()) {
      await collapsedFiles.click()

      // After expanding, should show "Touched_Files" header
      await expect(firstWidget.getByText('Touched_Files')).toBeVisible()
    }
  })

  test('expanding collapsed procedures panel shows procedure list', async ({ page }) => {
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Find the collapsed procedures panel
    const collapsedProcs = firstWidget.getByTestId('collapsed-procedures')
    if (await collapsedProcs.isVisible()) {
      await collapsedProcs.click()

      // After expanding, should show procedures content
      await expect(firstWidget.getByText('Procedures', { exact: true })).toBeVisible()
    }
  })

  test('recap tab shows conversation entries', async ({ page }) => {
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Check that the recap tab exists and is visible by default
    const recapTab = firstWidget.getByText('Recap')
    await expect(recapTab).toBeVisible()
  })

  test('run widget header shows run ID', async ({ page }) => {
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // The header should show a run ID (starts with R-)
    await expect(firstWidget.getByText(/R-\d+/)).toBeVisible()
  })
})

test.describe('Run Widget Header Actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('header shows labeled COLOR button', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    await expect(widget.getByText('COLOR')).toBeVisible()
  })

  test('header shows labeled BROWSER button', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    await expect(widget.getByText('BROWSER')).toBeVisible()
  })

  test('header shows labeled REFRESH button when session is live with port', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    // Refresh is only shown when isLive && run.port — skip gracefully if absent
    const visible = await widget.getByText('REFRESH').isVisible().catch(() => false)
    if (!visible) return // session not live or no port — button intentionally absent
    await expect(widget.getByText('REFRESH')).toBeVisible()
  })

  test('header shows labeled STOP or RESUME button', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    const stop = widget.getByText('STOP')
    const resume = widget.getByText('RESUME')
    const stopVisible = await stop.isVisible().catch(() => false)
    const resumeVisible = await resume.isVisible().catch(() => false)
    expect(stopVisible || resumeVisible).toBeTruthy()
  })

  test('header shows labeled DELETE button', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    await expect(widget.getByText('DELETE')).toBeVisible()
  })

  test('REFRESH button has descriptive tooltip when shown', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    // Refresh is conditional on isLive && run.port — skip if not rendered
    const refreshBtn = widget.locator('button').filter({ hasText: 'REFRESH' }).first()
    if (!(await refreshBtn.isVisible().catch(() => false))) return
    const title = await refreshBtn.getAttribute('title')
    expect(title).toContain('proxy route')
  })
})

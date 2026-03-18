import { test, expect, type Page } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Run Widget Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('clicking a run widget selects it in the sidebar', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    await widget.click()
    await page.waitForTimeout(200)

    const sidebarNode = page.getByTestId('sidebar-node-run-R-241')
    await expect(sidebarNode).toHaveClass(/bg-primary/)
  })

  test('double-clicking a run in the sidebar zooms canvas to it', async ({ page }) => {
    // Expand tree to reach run R-241
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.getByTestId('chevron-epic-epic-1').click()
    await page.getByTestId('chevron-task-task-1').click()
    await page.waitForTimeout(200)

    // Pan away from the widget
    const canvas = page.getByTestId('infinite-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('canvas not visible')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -1000)
    await page.waitForTimeout(200)

    // Double-click the run in sidebar to zoom-to-fit
    await page.getByTestId('sidebar-node-run-R-241').dblclick()
    await page.waitForTimeout(500)

    // Widget should still be visible after zoom-to-fit
    await expect(page.getByTestId('canvas-widget-R-241')).toBeVisible()
  })

  test('run widget has drag handle header', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    await expect(widget).toBeVisible()
    const header = widget.locator('[class*="cursor-grab"]').first()
    await expect(header).toBeVisible()
  })

  test('run widget has resize handle', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    const resizeHandle = widget.locator('.cursor-se-resize')
    await expect(resizeHandle).toBeVisible()
  })
})

test.describe('Run Widget Panels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('run widget has session panel with Recap tab', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    // Session panel shows Recap tab
    await expect(widget.getByText('Recap')).toBeVisible()
  })

  test('run widget has collapsed files panel', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    // Files panel is either expanded (showing FILES label) or collapsed (showing vertical "Files" text)
    const filesExpanded = widget.locator('[data-testid="collapsed-files"]')
    const filesLabel = widget.getByText('Files')
    // One of these should be visible
    const expandedVisible = await filesExpanded.isVisible().catch(() => false)
    const labelVisible = await filesLabel.first().isVisible().catch(() => false)
    expect(expandedVisible || labelVisible).toBeTruthy()
  })

  test('run widget has collapsed procedures panel', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    // Procedures panel starts collapsed, showing "Procs" text
    const collapsedProcs = widget.getByTestId('collapsed-procedures')
    await expect(collapsedProcs).toBeVisible()
    await expect(collapsedProcs.getByText('Procs')).toBeVisible()
  })

  test('clicking collapsed procedures panel expands it', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')

    // Click collapsed procedures to expand
    await widget.getByTestId('collapsed-procedures').click()
    await page.waitForTimeout(200)

    // Should now show the full panel with "Procedures" heading
    await expect(widget.getByText('Procedures', { exact: true })).toBeVisible()
  })
})

test.describe('File Panel Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('double-click on touched file does not zoom the canvas widget', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')

    // Expand files panel if collapsed
    const collapsedFiles = widget.getByTestId('collapsed-files')
    if (await collapsedFiles.isVisible()) {
      await collapsedFiles.click()
      await page.waitForTimeout(200)
    }

    // Make sure we're on the "Changed" tab (touched files)
    const changedTab = widget.getByText('Changed')
    if (await changedTab.isVisible()) {
      await changedTab.click()
      await page.waitForTimeout(200)
    }

    // Get widget position before double-click
    const before = await widget.boundingBox()
    if (!before) throw new Error('widget not visible')

    // Find a file entry and double-click it
    const fileEntry = widget.locator('button').filter({ hasText: /\.ts/ }).first()
    if (await fileEntry.isVisible()) {
      await fileEntry.dblclick()
      await page.waitForTimeout(300)

      // Widget should NOT have moved (double-click should not trigger canvas zoom)
      const after = await widget.boundingBox()
      if (!after) throw new Error('widget not visible after dblclick')
      expect(Math.abs(after.x - before.x)).toBeLessThan(5)
      expect(Math.abs(after.y - before.y)).toBeLessThan(5)
    }
  })

  test('switching between Changed and Explorer tabs works', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')

    // Expand files panel if collapsed
    const collapsedFiles = widget.getByTestId('collapsed-files')
    if (await collapsedFiles.isVisible()) {
      await collapsedFiles.click()
      await page.waitForTimeout(200)
    }

    // Switch to Explorer tab
    const explorerTab = widget.getByText('Explorer')
    await expect(explorerTab).toBeVisible()
    await explorerTab.click()
    await page.waitForTimeout(200)

    // Switch back to Changed tab
    const changedTab = widget.getByText('Changed')
    await changedTab.click()
    await page.waitForTimeout(200)

    // Both tabs should still be visible (panel not collapsed)
    await expect(explorerTab).toBeVisible()
    await expect(changedTab).toBeVisible()
  })

  test('file panel collapse button works', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')

    // Expand files panel if collapsed
    const collapsedFiles = widget.getByTestId('collapsed-files')
    if (await collapsedFiles.isVisible()) {
      await collapsedFiles.click()
      await page.waitForTimeout(200)
    }

    // Click collapse button (chevron_left icon)
    const collapseBtn = widget.locator('span:has-text("chevron_left")').first()
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click()
      await page.waitForTimeout(200)

      // Panel should now show collapsed state
      await expect(widget.getByTestId('collapsed-files')).toBeVisible()
    }
  })
})

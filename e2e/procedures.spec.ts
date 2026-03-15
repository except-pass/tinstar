import { test, expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test.describe('Procedures Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('procedures panel shows + New button', async ({ page }) => {
    // Find the first canvas widget
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Procedures panel starts collapsed — expand it
    const collapsedProcs = firstWidget.getByTestId('collapsed-procedures')
    if (await collapsedProcs.isVisible()) {
      await collapsedProcs.click()
    }

    // Verify new-procedure-btn is visible
    await expect(firstWidget.getByTestId('new-procedure-btn')).toBeVisible()
  })

  test('clicking + New opens skill picker modal', async ({ page }) => {
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Expand procedures panel if collapsed
    const collapsedProcs = firstWidget.getByTestId('collapsed-procedures')
    if (await collapsedProcs.isVisible()) {
      await collapsedProcs.click()
    }

    // Click the + New button
    await firstWidget.getByTestId('new-procedure-btn').click()

    // SkillPickerModal renders at SkillsProvider (WorkspaceShell) level, not inside the widget DOM
    await expect(page.locator('input[placeholder="Search or define skill…"]')).toBeVisible()
  })

  test('pressing Escape closes skill picker modal', async ({ page }) => {
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Expand procedures panel if collapsed
    const collapsedProcs = firstWidget.getByTestId('collapsed-procedures')
    if (await collapsedProcs.isVisible()) {
      await collapsedProcs.click()
    }

    // Open picker
    await firstWidget.getByTestId('new-procedure-btn').click()
    const pickerInput = page.locator('input[placeholder="Search or define skill…"]')
    await expect(pickerInput).toBeVisible()

    // Press Escape to close
    await page.keyboard.press('Escape')

    // Verify the picker is closed
    await expect(pickerInput).not.toBeVisible()
  })

  test('typing in picker shows define row when no match', async ({ page }) => {
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Expand procedures panel if collapsed
    const collapsedProcs = firstWidget.getByTestId('collapsed-procedures')
    if (await collapsedProcs.isVisible()) {
      await collapsedProcs.click()
    }

    // Open picker
    await firstWidget.getByTestId('new-procedure-btn').click()

    // Type a unique string that won't match any existing skill
    const uniqueText = 'xyzzy-unique-no-match-skill'
    await page.locator('input[placeholder="Search or define skill…"]').fill(uniqueText)

    // Verify the define row shows the typed text
    await expect(page.getByText(uniqueText).first()).toBeVisible()
  })

  test('typing description and pressing Enter adds shimmer to sidebar', async ({ page }) => {
    const widgets = page.locator('[data-testid^="canvas-widget-"]')
    const firstWidget = widgets.first()

    // Expand procedures panel if collapsed
    const collapsedProcs = firstWidget.getByTestId('collapsed-procedures')
    if (await collapsedProcs.isVisible()) {
      await collapsedProcs.click()
    }

    // Open picker
    await firstWidget.getByTestId('new-procedure-btn').click()

    // Type a description
    const description = 'review code for security issues'
    await page.locator('input[placeholder="Search or define skill…"]').fill(description)

    // Press Enter to trigger define
    await page.keyboard.press('Enter')

    // Modal should close
    await expect(page.locator('input[placeholder="Search or define skill…"]')).not.toBeVisible()

    // Shimmer (pending skill) should appear in procedures panel with the description text
    await expect(firstWidget.getByText(description)).toBeVisible({ timeout: 3000 })
  })

  test('/api/skills endpoint returns skill list', async ({ request }) => {
    const res = await request.get('/api/skills')
    expect(res.status()).toBe(200)
    const body = await res.json() as { skills: unknown[] }
    expect(Array.isArray(body.skills)).toBe(true)
  })

  test('/api/sessions/:id/prompt returns 404 for unknown session', async ({ request }) => {
    const res = await request.post('/api/sessions/nonexistent-session/prompt', {
      data: { text: '/design' },
    })
    expect(res.status()).toBe(404)
  })
})

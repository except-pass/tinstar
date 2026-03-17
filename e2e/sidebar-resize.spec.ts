import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Sidebar resize and collapse', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('sidebar collapses to thin strip when chevron clicked', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar-slot')
    await expect(sidebar).toBeVisible()

    // Find and click the collapse button inside the sidebar
    const collapseBtn = sidebar.locator('button[aria-label="Collapse sidebar"]')
    await collapseBtn.click()

    // Sidebar slot should now be the thin strip
    const collapsed = page.getByTestId('collapsed-sidebar')
    await expect(collapsed).toBeVisible()

    // Original sidebar content should be gone
    await expect(sidebar).not.toBeVisible()
  })

  test('collapsed sidebar strip expands when clicked', async ({ page }) => {
    // Collapse first
    const collapseBtn = page.getByTestId('sidebar-slot').locator('button[aria-label="Collapse sidebar"]')
    await collapseBtn.click()

    const collapsed = page.getByTestId('collapsed-sidebar')
    await expect(collapsed).toBeVisible()

    // Click strip to expand
    await collapsed.click()
    await expect(page.getByTestId('sidebar-slot')).toBeVisible()
    await expect(collapsed).not.toBeVisible()
  })

  test('sidebar resize handle is present when expanded', async ({ page }) => {
    const handle = page.getByTestId('sidebar-resize-handle')
    await expect(handle).toBeVisible()
  })
})

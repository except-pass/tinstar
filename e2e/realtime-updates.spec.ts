import { test, expect, type Page } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test.describe('Real-Time SSE Updates', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('creating entity via API appears in sidebar without reload', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')

    // Create a new initiative via API
    await page.evaluate(async () => {
      await fetch('/api/initiatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SSE Test Initiative' }),
      })
    })

    // Should appear in sidebar via SSE delta (no reload needed)
    await expect(sidebar.getByText('SSE Test Initiative')).toBeVisible({ timeout: 5000 })
  })

  test('deleting entity via API removes it from sidebar without reload', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')

    // Verify init-3 exists
    await expect(sidebar.getByText('Developer Portal')).toBeVisible()

    // Delete via API
    await page.evaluate(async () => {
      await fetch('/api/initiatives/init-3', { method: 'DELETE' })
    })

    // Should disappear via SSE delta
    await expect(sidebar.getByText('Developer Portal')).not.toBeVisible({ timeout: 5000 })
  })

  test('renaming entity via API updates sidebar without reload', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')

    // Verify current name
    await expect(sidebar.getByText('Observability Stack')).toBeVisible()

    // Rename via PATCH API
    await page.evaluate(async () => {
      await fetch('/api/initiatives/init-2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Monitoring Stack' }),
      })
    })

    // Should update via SSE delta
    await expect(sidebar.getByText('Monitoring Stack')).toBeVisible({ timeout: 5000 })
    await expect(sidebar.getByText('Observability Stack')).not.toBeVisible()
  })

  test('SSE snapshot loads all data on initial connect', async ({ page }) => {
    // The fact that we see data after page load proves SSE snapshot works
    const sidebar = page.getByTestId('hierarchy-sidebar')
    await expect(sidebar.getByText('AI Dev Platform')).toBeVisible()
    await expect(sidebar.getByText('Observability Stack')).toBeVisible()
    await expect(sidebar.getByText('Developer Portal')).toBeVisible()

    // Status area shows correct run count
    await expect(page.getByTestId('status-area')).toContainText('14 runs')

    // Canvas should have containers
    await expect(page.getByTestId('group-container-initiative-init-1')).toBeVisible()
  })
})

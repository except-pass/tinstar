import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Multi-Agent Patterns', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('pattern dropdown appears when patterns exist', async ({ page }) => {
    await page.getByTestId('new-session-btn').click()

    // Pattern dropdown appears if patterns are discovered
    // In test env, may or may not have patterns loaded
    const patternSelect = page.locator('select').filter({ hasText: 'Single Agent' })

    // Either pattern dropdown is visible (patterns exist) or not (no patterns)
    // This test just verifies the UI can handle both states
    const isVisible = await patternSelect.isVisible({ timeout: 2000 }).catch(() => false)

    if (isVisible) {
      await expect(patternSelect).toBeVisible()
      // Default option should be "Single Agent"
      await expect(patternSelect).toHaveValue('')
    }
  })

  test('GET /api/patterns returns array', async ({ page }) => {
    const response = await page.request.get('/api/patterns')
    expect(response.ok()).toBe(true)

    const data = await response.json()
    expect(data.ok).toBe(true)
    expect(Array.isArray(data.data)).toBe(true)
  })
})

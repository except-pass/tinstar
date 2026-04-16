// e2e/prompt-composer-history.spec.ts
import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Prompt composer history', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)

    // Always return success for any prompt send, so we can exercise the
    // "push on success" path without a real session backend.
    await page.route('**/api/sessions/*/prompt', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    })
  })

  test('recalls recent prompts via ↑ and via the history button', async ({ page }) => {
    // Find a run widget whose session panel exposes the prompt composer.
    const composerToggle = page.getByRole('button', { name: /Prompt Composer/i }).first()
    if (!(await composerToggle.isVisible().catch(() => false))) {
      test.skip(true, 'No live-terminal run rendered in this FAST_SIM fixture')
      return
    }
    await composerToggle.click()

    const textarea = page.locator('textarea[placeholder*="Enter prompt text"]').first()
    await expect(textarea).toBeVisible()

    // Send two prompts.
    await textarea.fill('alpha prompt')
    await textarea.press('Control+Enter')
    await expect(textarea).toHaveValue('')

    await textarea.fill('beta prompt')
    await textarea.press('Control+Enter')
    await expect(textarea).toHaveValue('')

    // ↑ in empty textarea opens popover.
    await textarea.focus()
    await textarea.press('ArrowUp')
    const popover = page.getByTestId('prompt-history-popover')
    await expect(popover).toBeVisible()

    // Newest first: item 0 is "beta prompt".
    await expect(page.getByTestId('prompt-history-item-0')).toContainText('beta prompt')
    await expect(page.getByTestId('prompt-history-item-1')).toContainText('alpha prompt')

    // ↓ to item 1, Enter selects "alpha prompt".
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(popover).toHaveCount(0)
    await expect(textarea).toHaveValue('alpha prompt')
    await expect(textarea).toBeFocused()

    // Clear and open again via the history button.
    await textarea.fill('')
    await page.getByTestId('prompt-history-button').click()
    await expect(popover).toBeVisible()

    // Escape closes without changing the textarea.
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(textarea).toHaveValue('')
  })

  test('↑ does not open the popover when the textarea has text', async ({ page }) => {
    const composerToggle = page.getByRole('button', { name: /Prompt Composer/i }).first()
    if (!(await composerToggle.isVisible().catch(() => false))) {
      test.skip(true, 'No live-terminal run rendered in this FAST_SIM fixture')
      return
    }
    await composerToggle.click()

    const textarea = page.locator('textarea[placeholder*="Enter prompt text"]').first()
    await textarea.fill('seed')
    await textarea.press('Control+Enter')
    await expect(textarea).toHaveValue('')

    await textarea.fill('some typing')
    await textarea.press('ArrowUp')
    await expect(page.getByTestId('prompt-history-popover')).toHaveCount(0)
  })
})

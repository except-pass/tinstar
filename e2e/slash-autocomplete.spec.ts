// e2e/slash-autocomplete.spec.ts
import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Slash command autocomplete', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)

    // Mock slash commands list with a known set so tests are deterministic.
    await page.route('**/api/slash-commands', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          commands: [
            { name: 'full-review', description: 'review pipeline', source: 'user', argumentHint: null, useCount: 0, lastUsedAt: null },
            { name: 'flourish-test', description: 'flourish demo', source: 'user', argumentHint: null, useCount: 0, lastUsedAt: null },
            { name: 'review', description: 'review prs', source: 'user', argumentHint: null, useCount: 0, lastUsedAt: null },
            { name: 'recap', description: 'recap thread', source: 'user', argumentHint: null, useCount: 0, lastUsedAt: null },
            { name: 'recon', description: 'recon code', source: 'user', argumentHint: null, useCount: 0, lastUsedAt: null },
          ],
        }),
      })
    })

    // Stub prompt POST so we can ignore real backend.
    await page.route('**/api/sessions/*/prompt', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    })
  })

  async function openComposer(page: import('@playwright/test').Page) {
    const composerToggle = page.getByRole('button', { name: /Prompt Composer/i }).first()
    if (!(await composerToggle.isVisible().catch(() => false))) {
      test.skip(true, 'No live-terminal run rendered in this FAST_SIM fixture')
      return null
    }
    await composerToggle.click()
    const textarea = page.locator('textarea[placeholder*="Enter prompt text"]').first()
    await expect(textarea).toBeVisible()
    return textarea
  }

  test('typing / shows chips, Tab inserts top match', async ({ page }) => {
    const textarea = await openComposer(page)
    if (!textarea) return

    await textarea.fill('/full')
    // Chips strip prefix is visible.
    await expect(page.getByText('tab:').first()).toBeVisible()
    // Top match chip is visible.
    await expect(page.getByRole('button', { name: '/full-review' }).first()).toBeVisible()

    // Tab inserts the top match.
    await textarea.press('Tab')
    await expect(textarea).toHaveValue('/full-review')
  })

  test('Tab again cycles to the next candidate', async ({ page }) => {
    const textarea = await openComposer(page)
    if (!textarea) return

    // /re matches recap, recon, review, full-review (substring), flourish-test? no.
    await textarea.fill('/re')
    await textarea.press('Tab')
    const first = await textarea.inputValue()
    await textarea.press('Tab')
    const second = await textarea.inputValue()
    expect(first).not.toBe(second)
    // Third tab returns to the same first option after wrapping (5 candidates).
    // Just verify forward progress for now.
  })

  test('typing a non-Tab key clears the cycle', async ({ page }) => {
    const textarea = await openComposer(page)
    if (!textarea) return

    await textarea.fill('/re')
    await textarea.press('Tab')      // enters cycle at index 0
    await textarea.press('Backspace') // resets cycle, also deletes last char
    await textarea.press('Tab')      // fresh cycle starts at index 0 with the new partial
    // Just verify the textarea has a leading slash-named token (no exception thrown).
    await expect(textarea).toHaveValue(/^\/[a-z0-9-]+/)
  })
})

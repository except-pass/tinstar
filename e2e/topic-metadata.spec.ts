/**
 * Topic metadata e2e smoke tests.
 *
 * Verifies that PATCH /api/topics/<subject> surfaces in the Saloon row
 * within ~5s via SSE, and that the inline-rename UI flow PATCHes correctly
 * and propagates back.
 */
import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Topic metadata', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('PATCHing a topic name surfaces it in the Saloon panel', async ({ page, request }) => {
    test.skip(
      true,
      'Topic metadata e2e requires harness with NATS-enabled subscriptions; revisit when fast-sim emits subs (see saloon plan Task 10 note).',
    )

    // 1. Find a session with NATS-enabled subscriptions in the e2e harness.
    //    Pick the first run; assume it has at least one subscription.
    await page.locator('[data-testid^="canvas-widget-run-"]').first().click()

    // 2. Read its first subscription subject from the Saloon DOM.
    const firstTopic = page.getByTestId('saloon-topic').first()
    await expect(firstTopic).toBeVisible()
    const tooltip = await firstTopic.getAttribute('title')
    expect(tooltip).toContain('Subject:')

    // 3. PATCH the topic with a friendly name via the API.
    const realSubject = tooltip!.split('\n')[0]!.replace('Subject: ', '').trim()
    const r = await request.patch(`/api/topics/${encodeURIComponent(realSubject)}`, {
      data: { name: 'E2E renamed topic' },
    })
    expect(r.ok()).toBe(true)

    // 4. The Saloon row should pick it up via SSE within a few seconds.
    await expect(firstTopic).toContainText('E2E renamed topic', { timeout: 5000 })
  })

  test('inline rename via UI propagates and persists', async ({ page }) => {
    test.skip(
      true,
      'Topic metadata e2e requires harness with NATS-enabled subscriptions; revisit when fast-sim emits subs (see saloon plan Task 10 note).',
    )

    await page.locator('[data-testid^="canvas-widget-run-"]').first().click()
    const firstTopic = page.getByTestId('saloon-topic').first()
    await firstTopic.hover()
    await page.getByTestId('saloon-rename').first().click()
    const input = page.getByTestId('saloon-rename-input')
    await input.fill('inline-renamed')
    await input.press('Enter')
    await expect(firstTopic).toContainText('inline-renamed', { timeout: 5000 })
  })
})

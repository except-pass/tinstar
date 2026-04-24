import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('The Saloon', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('renders header with subscription count and broker dot', async ({ page }) => {
    // Saloon is rendered inside every run workspace widget on the canvas.
    const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
    await expect(widget).toBeVisible()

    // Saloon header visible
    await expect(widget.getByText(/saloon/i).first()).toBeVisible()

    // Broker dot renders with a status attribute
    const dot = widget.getByTestId('saloon-dot')
    await expect(dot).toBeVisible()
    await expect(dot).toHaveAttribute('data-status', /ok|bad/)

    // At least one subscription row (fast-sim sessions subscribe to their task channel)
    await expect(widget.getByTestId('saloon-topic').first()).toBeVisible()
  })

  test('filter narrows the stream', async ({ page }) => {
    const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
    await expect(widget).toBeVisible()

    const filter = widget.getByPlaceholder(/filter/i)
    await filter.fill('definitely-not-a-real-subject-xyz')

    // After filter, no messages visible
    await expect(widget.getByTestId('saloon-msg')).toHaveCount(0)
  })

  test('clicking a subscription mutes it', async ({ page }) => {
    const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
    await expect(widget).toBeVisible()

    const firstTopic = widget.getByTestId('saloon-topic').first()
    await expect(firstTopic).toHaveAttribute('data-muted', 'false')
    await firstTopic.click()
    await expect(firstTopic).toHaveAttribute('data-muted', 'true')

    // 'n hidden' pill should appear
    await expect(widget.getByTestId('saloon-hidden-pill')).toBeVisible()
  })
})

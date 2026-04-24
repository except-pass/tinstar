/**
 * Saloon e2e smoke tests.
 *
 * Scope: verifies the panel renders cleanly and the filter input is wired.
 * The fast-sim harness does not populate session.nats.subscriptions today,
 * so richer interaction tests (topic rows, messages, mute toggle) live as
 * unit tests. A follow-up that teaches the simulator to emit NATS subs
 * will enable those interactions in e2e too.
 */
import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('The Saloon', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('renders SALOON header with a broker dot', async ({ page }) => {
    const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
    await expect(widget).toBeVisible()

    await expect(widget.getByText(/SALOON/i).first()).toBeVisible()

    const dot = widget.getByTestId('saloon-dot')
    await expect(dot).toBeVisible()
    await expect(dot).toHaveAttribute('data-status', /ok|bad/)
  })

  test('shows empty-state when no subscriptions exist', async ({ page }) => {
    const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
    await expect(widget).toBeVisible()

    // The harness creates sessions without NATS subs, so the empty state should render.
    await expect(widget.getByText(/no subscriptions/i)).toBeVisible()
  })

  test('filter input accepts typed text', async ({ page }) => {
    const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
    await expect(widget).toBeVisible()

    const filter = widget.getByPlaceholder(/filter/i)
    await expect(filter).toBeVisible()
    await filter.fill('hello')
    await expect(filter).toHaveValue('hello')
  })
})

import { expect, type Page } from '@playwright/test'

/** Reset simulator data and wait for it to load in the UI */
export async function resetAndWaitForData(page: Page) {
  // Reset simulator on server (clears docstore, re-emits all mock events)
  await page.evaluate(async () => {
    await fetch('/api/simulator/reset', { method: 'POST' })
    await fetch('/api/simulator/start', { method: 'POST' })
  })

  // Small delay for SSE delta events to arrive
  await page.waitForTimeout(500)

  // Clear layouts and reload against the freshly seeded simulator state.
  await page.evaluate(() => {
    localStorage.removeItem('tinstar-layouts-v3')
  })
  await page.reload()

  // R-241 is a stable member of the simulator fixture and proves the current
  // server-backed grouping metadata and run snapshot have both rendered.
  await expect(page.getByTestId('canvas-widget-run-R-241')).toBeVisible({ timeout: 10000 })
}

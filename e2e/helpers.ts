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

  // Clear layouts, force initiative grouping (default changed to 'task'), and reload
  await page.evaluate(() => {
    localStorage.removeItem('tinstar-layouts-v3')
    localStorage.setItem('tinstar-dimensions', JSON.stringify(['initiative', 'epic', 'task']))
  })
  await page.reload()

  // Wait for ALL simulator initiatives to be visible (not just the first one)
  await expect(page.getByTestId('sidebar-node-initiative-init-1')).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId('sidebar-node-initiative-init-2')).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('sidebar-node-initiative-init-3')).toBeVisible({ timeout: 5000 })
}

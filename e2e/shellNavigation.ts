import type { Page } from '@playwright/test'

/** Enter worker detail through a supported worker link before opening its switcher. */
export async function openWorkerSwitcher(page: Page) {
  await page.getByRole('button', { name: 'Switch worker', exact: true }).click()
}

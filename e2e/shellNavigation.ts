import type { Page } from '@playwright/test'

/** The switcher is an on-demand Overview/worker-detail tool, not a rail destination. */
export async function openWorkerSwitcher(page: Page) {
  const switcher = page.getByRole('button', { name: /^(Find worker|Switch worker)$/ })
  if (!(await switcher.isVisible())) {
    const desk = page.getByRole('button', { name: 'Your desk', exact: true })
    if (await desk.isVisible()) await desk.click()
  }
  await switcher.click()
}

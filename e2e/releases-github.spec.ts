import { expect, test } from '@playwright/test'
import { githubReleasePreview } from '../test-fixtures/releases/github-preview'

let preview: Awaited<ReturnType<typeof githubReleasePreview>>
test.beforeAll(async () => { preview = await githubReleasePreview() })
test.afterAll(async () => {
  preview.server.closeAllConnections()
  await new Promise<void>(resolve => preview.server.close(() => resolve()))
})

test('v1.24.0 is visible from tag/runs without a GitHub Release; Plan/Verify, notes and narrow layout remain release-scoped', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const requestedTags: string[] = []
  page.on('request', request => { const tag = new URL(request.url()).searchParams.get('tag'); if (tag) requestedTags.push(tag) })
  await page.goto(`${preview.base}/?view=releases`)
  await page.getByRole('tab', { name: 'Verify', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'v1.24.0', exact: true })).toBeVisible()
  await expect.poll(() => requestedTags.includes('v1.24.0')).toBe(true)
  await expect(page.getByText(/0 targets lack verified deployment/)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Production acceptance', exact: true })).toBeVisible()
  await expect(page.getByText('No GitHub Release record', { exact: true })).toBeVisible()
  await expect(page.getByText('Production deployment proof unknown', { exact: true })).toBeVisible()
  await page.getByText('Component runs and results', { exact: true }).click()
  await expect(page.getByRole('link', { name: /completed \/ success/ })).toHaveAttribute('href', 'https://github.com/fortresspower/cmsandbox/actions/runs/42644291188')
  await expect(page.getByText(/Started 2026-11-06T12:01:00Z/)).toBeVisible()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('heading', { name: 'Changes in this release', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Improve command delivery/ }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText('Unknown · Acceptance unknown', { exact: true })).toBeVisible()
  await expect(drawer.getByRole('link', { name: 'fortresspower/cmsandbox#3267 ↗' })).toHaveAttribute('href', 'https://github.com/fortresspower/cmsandbox/pull/3267')
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: 'Release notes', exact: true }).click()
  await page.getByRole('button', { name: 'Customer', exact: true }).click()
  await expect(page.getByText('No changes are currently eligible for this audience.', { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('github-native-notes-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('github-native-mobile.png') })
})

test('unreadable GitHub data renders unknown rather than an empty release history', async ({ page }) => {
  await page.route('**/api/releases', route => route.fulfill({ json: { ok: true, data: { ...preview.data, releases: [], releaseSource: { status: 'unknown', observedAt: null, warnings: ['GitHub version tags unavailable; release history is unknown.'] } } } }))
  await page.goto(`${preview.base}/?view=releases`)
  await expect(page.getByRole('heading', { name: 'Release history unknown', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No release candidates', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Verify', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Release history unknown', exact: true })).toBeVisible()
})

// Uses pluginTest (sessions enabled): the /api/projects routes are only mounted
// when sessions are on. The default `test` fixture sets TINSTAR_NO_SESSIONS=1,
// under which those routes fall through to the SPA.
import { pluginTest as test, expect, type Page } from './fixtures'
import { resetAndWaitForData } from './helpers'

// Projects persist to the worker's isolated projects.json (TINSTAR_DATA_DIR),
// so we reset to a known set before each test for determinism.
const PROJECTS = [
  { name: 'zeta-proj', path: '/tmp/zeta' },
  { name: 'yankee-proj', path: '/tmp/yankee' },
  { name: 'xray-proj', path: '/tmp/xray' },
]

async function resetProjects(page: Page) {
  const existing = await page.request.get('/api/projects').then(r => r.json())
  for (const name of Object.keys(existing.data ?? {})) {
    await page.request.delete(`/api/projects/${encodeURIComponent(name)}`)
  }
  for (const p of PROJECTS) {
    await page.request.post('/api/projects', { data: p })
  }
}

async function openSettingsProjects(page: Page) {
  await page.getByTestId('settings-btn').click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
}

async function openNewSessionPicker(page: Page) {
  await page.getByTestId('new-session-btn').click()
  await expect(page.getByTestId('create-project-select')).toBeVisible()
}

test.describe('project star / hide / reorder', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
    await resetProjects(page)
  })

  test('starring a project surfaces it in the Favorites group of the picker', async ({ page }) => {
    await openSettingsProjects(page)
    // Star yankee-proj
    await page.getByRole('button', { name: 'Star yankee-proj' }).click()
    // The star toggle flips to "Unstar" (optimistic)
    await expect(page.getByRole('button', { name: 'Unstar yankee-proj' })).toBeVisible()
    await page.keyboard.press('Escape')

    await openNewSessionPicker(page)
    const favorites = page.locator(
      'select[data-testid="create-project-select"] optgroup[label="★ Favorites"] option',
    )
    await expect(favorites).toHaveText(['yankee-proj'])
    // A non-starred project lives under the "Projects" group, not Favorites.
    const others = page.locator(
      'select[data-testid="create-project-select"] optgroup[label="Projects"] option',
    )
    await expect(others).toContainText(['zeta-proj', 'xray-proj'])
  })

  test('hiding a project removes it from the picker and dims it in Settings', async ({ page }) => {
    await openSettingsProjects(page)
    await page.getByRole('button', { name: 'Hide xray-proj' }).click()
    // Row becomes dimmed (opacity-40) and the toggle flips to "Unhide"
    const row = page.getByTestId('project-row-xray-proj')
    await expect(row).toHaveClass(/opacity-40/)
    await expect(page.getByRole('button', { name: 'Unhide xray-proj' })).toBeVisible()
    await page.keyboard.press('Escape')

    await openNewSessionPicker(page)
    const allOptions = page.locator('select[data-testid="create-project-select"] option')
    await expect(allOptions).not.toContainText(['xray-proj'])
    await expect(allOptions).toContainText(['zeta-proj', 'yankee-proj'])
    await page.keyboard.press('Escape')

    // Unhide restores it
    await openSettingsProjects(page)
    await page.getByRole('button', { name: 'Unhide xray-proj' }).click()
    await expect(page.getByTestId('project-row-xray-proj')).not.toHaveClass(/opacity-40/)
    await page.keyboard.press('Escape')

    await openNewSessionPicker(page)
    await expect(
      page.locator('select[data-testid="create-project-select"] option'),
    ).toContainText(['xray-proj'])
  })

  test('reordering persists and is reflected in Settings after reload', async ({ page }) => {
    // Drive the order endpoint (native HTML5 drag is unreliable to simulate);
    // this verifies the order round-trips and the UI honors it after reload.
    const res = await page.request.put('/api/projects/order', {
      data: { order: ['xray-proj', 'zeta-proj', 'yankee-proj'] },
    })
    expect(res.ok()).toBeTruthy()

    await page.reload()
    await openSettingsProjects(page)

    const rows = page.locator('[data-testid^="project-row-"]')
    await expect(rows).toHaveCount(3)
    // The rendered order matches the reordered sequence.
    await expect(rows.nth(0)).toHaveAttribute('data-testid', 'project-row-xray-proj')
    await expect(rows.nth(1)).toHaveAttribute('data-testid', 'project-row-zeta-proj')
    await expect(rows.nth(2)).toHaveAttribute('data-testid', 'project-row-yankee-proj')
  })

  test('reorder endpoint rejects unknown project names', async ({ page }) => {
    const res = await page.request.put('/api/projects/order', {
      data: { order: ['xray-proj', 'nonexistent'] },
    })
    expect(res.status()).toBe(400)
  })
})

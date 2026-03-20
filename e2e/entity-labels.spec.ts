import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Entity Labels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('Entity Labels tab is visible in Settings nav', async ({ page }) => {
    await page.getByTestId('settings-btn').click()

    // The settings nav should contain an "Entity Labels" tab button
    await expect(page.getByRole('button', { name: /Entity Labels/i })).toBeVisible()
  })

  test('Entity Labels section heading is visible after opening settings', async ({ page }) => {
    await page.getByTestId('settings-btn').click()

    // Scroll to Entity Labels by clicking the nav tab
    await page.getByRole('button', { name: /Entity Labels/i }).click()

    // The section heading should be visible
    await expect(page.getByRole('heading', { name: /Entity Labels/i })).toBeVisible()
  })

  test('default level labels are shown in settings', async ({ page }) => {
    await page.getByTestId('settings-btn').click()
    await page.getByRole('button', { name: /Entity Labels/i }).click()

    // Default labels: Initiative, Epic, Task
    const inputs = page.locator('input[placeholder="Label"]')
    await expect(inputs.first()).toBeVisible()

    // The singular inputs should contain the defaults
    const values = await inputs.evaluateAll((els: HTMLInputElement[]) => els.map(e => e.value))
    expect(values).toContain('Initiative')
    expect(values).toContain('Epic')
    expect(values).toContain('Task')
  })

  test('can rename a hierarchy level label', async ({ page }) => {
    await page.getByTestId('settings-btn').click()
    await page.getByRole('button', { name: /Entity Labels/i }).click()

    // Find the "Initiative" singular input and rename it
    const initiativeInput = page.locator('input[placeholder="Label"]').first()
    await expect(initiativeInput).toBeVisible()

    await initiativeInput.selectText()
    await initiativeInput.fill('Project')

    // Save button should now be enabled
    const saveBtn = page.getByRole('button', { name: /^Save$/ }).last()
    await expect(saveBtn).toBeEnabled()
  })

  test('save button is disabled when no changes have been made', async ({ page }) => {
    await page.getByTestId('settings-btn').click()
    await page.getByRole('button', { name: /Entity Labels/i }).click()

    // The Save button in the labels footer starts disabled (not dirty)
    const saveBtn = page.getByRole('button', { name: /^Save$/ }).last()
    await expect(saveBtn).toBeDisabled()
  })

  test('save button becomes enabled after editing a label', async ({ page }) => {
    await page.getByTestId('settings-btn').click()
    await page.getByRole('button', { name: /Entity Labels/i }).click()

    // Edit the first label
    const firstInput = page.locator('input[placeholder="Label"]').first()
    await firstInput.selectText()
    await firstInput.fill('Sprint')

    const saveBtn = page.getByRole('button', { name: /^Save$/ }).last()
    await expect(saveBtn).toBeEnabled()
  })

  test('Reset to defaults button marks labels as dirty', async ({ page }) => {
    await page.getByTestId('settings-btn').click()
    await page.getByRole('button', { name: /Entity Labels/i }).click()

    await page.getByRole('button', { name: /Reset to defaults/i }).click()

    // After reset, Save should be enabled (dirty)
    const saveBtn = page.getByRole('button', { name: /^Save$/ }).last()
    await expect(saveBtn).toBeEnabled()
  })

  test('Add level button appears when fewer than 3 levels exist', async ({ page }) => {
    await page.getByTestId('settings-btn').click()
    await page.getByRole('button', { name: /Entity Labels/i }).click()

    // With 3 levels (default) the add button should NOT be visible
    await expect(page.getByRole('button', { name: /\+ Add level above leaf/i })).not.toBeVisible()
  })

  test('removing a level makes Add level button appear', async ({ page }) => {
    await page.getByTestId('settings-btn').click()
    await page.getByRole('button', { name: /Entity Labels/i }).click()

    // Remove the first (top) level — "Remove level" button for non-leaf rows
    const removeBtns = page.getByRole('button', { name: /Remove level/i })
    // First remove button belongs to Level 1 (non-leaf)
    await removeBtns.first().click()

    // Now only 2 levels remain, so "Add level above leaf" should appear
    await expect(page.getByRole('button', { name: /\+ Add level above leaf/i })).toBeVisible()
  })

  test('PATCH /api/spaces/:id accepts labelConfig payload', async ({ page }) => {
    // Load the page so we have a base URL to work from
    await page.goto('/')
    await resetAndWaitForData(page)

    // Get active space id via the Playwright request API (uses the context baseURL)
    const stateRes = await page.request.get('/api/state')
    const state = await stateRes.json()
    const spaceId: string = state.activeSpaceId ?? state.spaces?.[0]?.id
    expect(spaceId).toBeTruthy()

    const patchRes = await page.request.patch(`/api/spaces/${spaceId}`, {
      data: {
        labelConfig: {
          levels: [
            { icon: '🚀', label: 'Initiative' },
            { icon: '🏔️', label: 'Epic' },
            { icon: '🗂️', label: 'Task' },
          ],
        },
      },
    })
    const result = await patchRes.json()
    expect(result.ok).toBe(true)
  })
})

import { test, expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test.describe('CreateSessionDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('session dialog opens from top bar button', async ({ page }) => {
    await page.getByTestId('new-session-btn').click()

    // Dialog should show with name input
    await expect(page.getByTestId('session-name-input')).toBeVisible()
  })

  test('session dialog has backend toggle', async ({ page }) => {
    await page.getByTestId('new-session-btn').click()

    // Should show Docker and Tmux options
    await expect(page.getByText('Docker')).toBeVisible()
    await expect(page.getByText('Tmux')).toBeVisible()
  })

  test('session dialog has skip permissions checkbox', async ({ page }) => {
    await page.getByTestId('new-session-btn').click()

    await expect(page.getByText('Skip permissions')).toBeVisible()
  })

  test('session dialog has starting prompt textarea', async ({ page }) => {
    await page.getByTestId('new-session-btn').click()

    await expect(page.getByPlaceholder('Initial message to send to Claude...')).toBeVisible()
  })

  test('create button disabled without name', async ({ page }) => {
    await page.getByTestId('new-session-btn').click()

    const createBtn = page.getByTestId('create-session-submit')
    await expect(createBtn).toBeDisabled()
  })

  test('Ctrl+Enter hint shown', async ({ page }) => {
    await page.getByTestId('new-session-btn').click()

    await expect(page.getByText('Ctrl+Enter to create')).toBeVisible()
  })

  test('Escape closes the dialog', async ({ page }) => {
    await page.getByTestId('new-session-btn').click()
    await expect(page.getByTestId('session-name-input')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByTestId('session-name-input')).not.toBeVisible()
  })
})

test.describe('SettingsDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('settings dialog opens from gear button', async ({ page }) => {
    await page.getByTestId('settings-btn').click()

    // Should show settings dialog with Projects heading
    await expect(page.getByText('Projects')).toBeVisible()
  })
})

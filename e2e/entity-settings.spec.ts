import { test, expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test.describe('Entity Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('settings dialog opens from entity menu', async ({ page }) => {
    // Open menu for init-1
    const node = page.getByTestId('sidebar-node-initiative-init-1')
    await node.hover()
    await page.getByTestId('menu-initiative-init-1').click({ force: true })

    const menu = page.getByTestId('entity-menu')
    await expect(menu).toBeVisible()

    // Click Settings...
    await page.getByTestId('menu-action-settings-').click()

    // Settings dialog should appear (heading contains entity name + "Settings")
    await expect(page.getByRole('heading', { name: /Settings/ })).toBeVisible()
  })

  test('settings API returns resolved settings', async ({ page }) => {
    // Test the settings API endpoint directly
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/initiatives/init-1/settings')
      return res.json()
    })

    expect(response.ok).toBe(true)
    expect(response.data).toHaveProperty('resolved')
    expect(response.data).toHaveProperty('sources')
    expect(response.data).toHaveProperty('local')
  })

  test('start session from menu opens prefilled dialog', async ({ page }) => {
    const node = page.getByTestId('sidebar-node-initiative-init-1')
    await node.hover()
    await page.getByTestId('menu-initiative-init-1').click({ force: true })

    const menu = page.getByTestId('entity-menu')
    await expect(menu).toBeVisible()

    // Click Start Session
    await page.getByTestId('menu-action-start-session').click()

    // Session dialog should appear
    await expect(page.getByTestId('session-name-input')).toBeVisible()
  })
})

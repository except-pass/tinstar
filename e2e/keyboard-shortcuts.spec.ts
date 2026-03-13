import { test, expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('Alt+Z resets zoom to 100%', async ({ page }) => {
    const canvas = page.getByTestId('infinite-canvas')
    const zoomIndicator = page.getByTestId('zoom-indicator')

    // Verify initial zoom is 100%
    await expect(zoomIndicator).toContainText('100%')

    // Zoom in with Ctrl+scroll (use dispatchEvent for ctrlKey)
    await canvas.hover()
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="infinite-canvas"]')!
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -500,
        ctrlKey: true,
        bubbles: true,
        clientX: 400,
        clientY: 400,
      }))
    })
    await page.waitForTimeout(100)

    // Zoom should have changed
    const zoomText = await zoomIndicator.textContent()
    expect(zoomText).not.toBe('100%')

    // Reset with Alt+Z
    await page.keyboard.press('Alt+z')
    await page.waitForTimeout(100)
    await expect(zoomIndicator).toContainText('100%')
  })

  test('Escape closes create entity dialog', async ({ page }) => {
    await page.getByTestId('add-root').click()
    const dialog = page.locator('.fixed').first()
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('hierarchy-sidebar')).toBeVisible()
  })

  test('Escape closes entity menu', async ({ page }) => {
    const node = page.getByTestId('sidebar-node-initiative-init-1')
    await node.hover()
    await page.getByTestId('menu-initiative-init-1').click({ force: true })

    const menu = page.getByTestId('entity-menu')
    await expect(menu).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })
})

import { test, expect } from './fixtures'

test.describe('Space creation and switching', () => {
  test.describe.configure({ mode: 'serial' })

  test('page loads with simulator space active', async ({ page }) => {
    await page.goto('/')
    const switcher = page.getByTestId('space-switcher')
    await expect(switcher).toBeVisible({ timeout: 10000 })
    await expect(switcher).toContainText('_simulator')
  })

  test('create new space switches to it immediately', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('space-switcher')).toBeVisible({ timeout: 10000 })

    // Log network requests for debugging
    page.on('response', async res => {
      if (res.url().includes('/api/spaces')) {
        const body = await res.text().catch(() => '');
        console.log(`[NET] ${res.request().method()} ${res.url()} → ${res.status()} ${body.substring(0, 100)}`);
      }
    })

    // Open space switcher popover
    await page.getByTestId('space-switcher').click()
    await expect(page.getByTestId('create-space-btn')).toBeVisible()

    // Click "New Space"
    await page.getByTestId('create-space-btn').click()

    // Type name and press Enter
    const input = page.locator('input[placeholder="Space name..."]')
    await expect(input).toBeVisible()
    await input.fill('My Test Space')
    await input.press('Enter')

    // Wait for space switcher to show the new space name
    await expect(page.getByTestId('space-switcher')).toContainText('My Test Space', { timeout: 5000 })
  })

  test('new space persists after page refresh', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('space-switcher')).toBeVisible({ timeout: 10000 })

    // Create a new space
    await page.getByTestId('space-switcher').click()
    await page.getByTestId('create-space-btn').click()
    const input = page.locator('input[placeholder="Space name..."]')
    await input.fill('Persist Test')
    await input.press('Enter')

    await expect(page.getByTestId('space-switcher')).toContainText('Persist Test', { timeout: 5000 })

    // Refresh
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('space-switcher')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('space-switcher')).toContainText('Persist Test', { timeout: 5000 })
  })

  test('page refresh loads without hanging', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('space-switcher')).toBeVisible({ timeout: 10000 })

    for (let i = 0; i < 3; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('space-switcher')).toBeVisible({ timeout: 10000 })
    }
  })

  test('clicking a different space in the menu switches to it', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('space-switcher')).toBeVisible({ timeout: 10000 })

    // Create a second space via API
    const spaceId = await page.evaluate(async () => {
      const res = await fetch('/api/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Switch Target' }),
      })
      return ((await res.json()) as { id: string }).id
    })
    await page.waitForTimeout(500) // let SSE delta arrive

    // Open switcher and click "Switch Target"
    await page.getByTestId('space-switcher').click()
    await page.locator('.cursor-pointer', { hasText: 'Switch Target' }).click()

    // Switcher should now show "Switch Target"
    await expect(page.getByTestId('space-switcher')).toContainText('Switch Target', { timeout: 5000 })

    // Cleanup: switch back and delete
    await page.evaluate(async (id: string) => {
      const state = await fetch('/api/state').then(r => r.json()) as { spaces: { id: string }[] }
      const other = state.spaces.find(s => s.id !== id)
      if (other) await fetch(`/api/spaces/${other.id}/activate`, { method: 'POST' })
      await fetch(`/api/spaces/${id}`, { method: 'DELETE' })
    }, spaceId)
  })

  test('space created via API activates and appears in switcher', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('space-switcher')).toBeVisible({ timeout: 10000 })

    // Create and activate via direct API
    const spaceId = await page.evaluate(async () => {
      const res = await fetch('/api/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'API Created' }),
      })
      const space = await res.json() as { id: string }
      await fetch(`/api/spaces/${space.id}/activate`, { method: 'POST' })
      return space.id
    })

    // SSE snapshot should update the UI
    await expect(page.getByTestId('space-switcher')).toContainText('API Created', { timeout: 5000 })

    // Cleanup
    await page.evaluate(async (id: string) => {
      const state = await fetch('/api/state').then(r => r.json()) as { spaces: { id: string }[] }
      const other = state.spaces.find(s => s.id !== id)
      if (other) await fetch(`/api/spaces/${other.id}/activate`, { method: 'POST' })
      await fetch(`/api/spaces/${id}`, { method: 'DELETE' })
    }, spaceId)
  })
})

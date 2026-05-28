import { pluginTest as test, expect } from './fixtures'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePluginPath = resolve(repoRoot, 'test-fixtures', 'plugin-widget-fixture')

test.describe('Inbox view', () => {
  test.beforeEach(async ({ serverUrl }) => {
    const res = await fetch(`${serverUrl}/api/plugins-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        disabled: [],
        external: [{ name: 'plugin-widget-fixture', path: fixturePluginPath }],
      }),
    })
    if (!res.ok) throw new Error(`failed to register fixture plugin: ${res.status} ${await res.text()}`)

    const listRes = await fetch(`${serverUrl}/api/plugin-widgets`)
    if (listRes.ok) {
      const { data } = await listRes.json() as { data: { id: string }[] }
      await Promise.all(data.map(w =>
        fetch(`${serverUrl}/api/plugin-widgets/${w.id}`, { method: 'DELETE' }),
      ))
    }
  })

  test('plugin setAttention → inbox row → click flashes widget', async ({ page, serverUrl }) => {
    await page.goto(serverUrl)

    // Drag the fixture widget onto the canvas.
    const entry = page.getByTestId('palette-entry-plugin-widget-fixture-fixture-widget')
    await expect(entry).toBeVisible({ timeout: 10_000 })
    const canvas = page.getByTestId('infinite-canvas')
    const canvasBox = await canvas.boundingBox()
    if (!canvasBox) throw new Error('canvas has no bounding box')
    await entry.scrollIntoViewIfNeeded()
    await entry.dragTo(canvas, {
      targetPosition: { x: Math.round(canvasBox.width / 2), y: Math.round(canvasBox.height / 2) },
    })
    await expect(page.getByTestId('fixture-widget').first()).toBeVisible({ timeout: 8000 })

    // Initially the inbox tab has no badge.
    await expect(page.getByTestId('sidebar-tab-inbox-badge')).toHaveCount(0)

    // Click the fixture's mark-urgent button.
    await page.getByTestId('fixture-mark-urgent').first().dispatchEvent('click')

    // Wait for the 250ms debounce + PATCH + SSE round-trip.
    await expect(page.getByTestId('sidebar-tab-inbox-badge')).toHaveText('1', { timeout: 3000 })

    // Switch to inbox tab.
    await page.getByTestId('sidebar-tab-inbox').click()

    // Find the inbox row by its unique reason text.
    const reasonRow = page.getByText('Fixture urgent')
    await expect(reasonRow).toBeVisible()

    // Click the row.
    await reasonRow.click()

    // The widget should briefly have the .widget-flash class.
    await expect(async () => {
      const hasFlash = await page.locator('.widget-flash').count()
      expect(hasFlash).toBeGreaterThan(0)
    }).toPass({ timeout: 1500 })

    // The fixture widget is still on the canvas — the inbox is in the sidebar, not the main pane.
    // Click clear-attention directly without switching tabs.
    await page.getByTestId('fixture-clear-attention').first().dispatchEvent('click')

    // Inbox should be empty after the PATCH + SSE round-trip clears the attention.
    await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 3000 })

    // And the badge in the sidebar tab should be gone once state has been re-derived.
    await expect(page.getByTestId('sidebar-tab-inbox-badge')).toHaveCount(0)
  })
})

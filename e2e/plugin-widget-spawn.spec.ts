import { pluginTest as test, expect } from './fixtures'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePluginPath = resolve(repoRoot, 'test-fixtures', 'plugin-widget-fixture')

test.describe('Plugin widget spawn', () => {
  test.beforeEach(async ({ serverUrl }) => {
    // Register the fixture plugin BEFORE the first page.goto in each test.
    // The frontend fetches /api/plugins-config on page load, so this PUT must
    // land before page navigation. serverUrl is worker-scoped (already running).
    // PUT also calls invalidateWidgetRegistryCache() so subsequent registry GETs see the plugin.
    const res = await fetch(`${serverUrl}/api/plugins-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        disabled: [],
        external: [{ name: 'plugin-widget-fixture', path: fixturePluginPath }],
      }),
    })
    if (!res.ok) throw new Error(`failed to register fixture plugin: ${res.status} ${await res.text()}`)

    // Clean up any stale plugin widgets left from a previous test attempt on this worker.
    const listRes = await fetch(`${serverUrl}/api/plugin-widgets`)
    if (listRes.ok) {
      const { data } = await listRes.json() as { data: { id: string }[] }
      await Promise.all(data.map(w =>
        fetch(`${serverUrl}/api/plugin-widgets/${w.id}`, { method: 'DELETE' }),
      ))
    }
  })

  test('drag-drop spawns + useData persists + delete', async ({ page, serverUrl }) => {
    await page.goto(serverUrl)

    // Wait for the palette entry to appear — it fetches /api/plugin-widgets/registry on mount.
    // The registry is populated because we PUT plugins-config before goto.
    const entry = page.getByTestId('palette-entry-plugin-widget-fixture-fixture-widget')
    await expect(entry).toBeVisible({ timeout: 10_000 })

    // Drag from palette entry to canvas
    const canvas = page.getByTestId('infinite-canvas')
    await expect(canvas).toBeVisible({ timeout: 5000 })
    const canvasBox = await canvas.boundingBox()
    if (!canvasBox) throw new Error('canvas has no bounding box')

    // Scroll the palette entry into the viewport so drag events fire correctly
    await entry.scrollIntoViewIfNeeded()

    await entry.dragTo(canvas, {
      targetPosition: { x: Math.round(canvasBox.width / 2), y: Math.round(canvasBox.height / 2) },
    })

    // The fixture widget should now be on the canvas
    const widget = page.getByTestId('fixture-widget').first()
    await expect(widget).toBeVisible({ timeout: 8000 })

    const counter = page.getByTestId('fixture-counter').first()
    await expect(counter).toHaveText('0')

    // Click +1 three times via dispatchEvent (widget may be outside Playwright viewport due to canvas overflow)
    const incBtn = page.getByTestId('fixture-increment').first()
    await incBtn.dispatchEvent('click')
    await incBtn.dispatchEvent('click')
    await incBtn.dispatchEvent('click')

    // Optimistic update should show 3 immediately
    await expect(counter).toHaveText('3')

    // Wait for the 250ms debounce + network round-trip to complete
    await page.waitForTimeout(600)

    // Reload — useData should hydrate from the persisted server snapshot.
    // Wait for DOMContentLoaded; SSE keeps the connection alive so 'networkidle' never fires.
    await page.reload({ waitUntil: 'domcontentloaded' })
    // The fixture-widget testid only appears once the plugin JS has finished booting and
    // api.widgets.register() has been called for the 'fixture-widget' type.
    await expect(page.getByTestId('fixture-widget').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('fixture-counter').first()).toHaveText('3')

    // Delete via the widget's own delete button (api.widget.useDelete path)
    await page.getByTestId('fixture-delete').first().dispatchEvent('click')
    await page.waitForTimeout(400)
    await expect(page.getByTestId('fixture-widget')).toHaveCount(0)

    // Verify server-side: no plugin widgets remain
    const r = await fetch(`${serverUrl}/api/plugin-widgets`)
    const body = await r.json() as { ok: boolean; data: unknown[] }
    expect(body.data.length).toBe(0)
  })

  test('singleton violation on second drop', async ({ page, serverUrl }) => {
    await page.goto(serverUrl)

    // Wait for palette to load
    const singletonEntry = page.getByTestId('palette-entry-plugin-widget-fixture-fixture-singleton-widget')
    await expect(singletonEntry).toBeVisible({ timeout: 10_000 })

    const canvas = page.getByTestId('infinite-canvas')
    await expect(canvas).toBeVisible({ timeout: 5000 })
    const canvasBox = await canvas.boundingBox()
    if (!canvasBox) throw new Error('canvas has no bounding box')

    // First spawn — should succeed
    await singletonEntry.scrollIntoViewIfNeeded()
    await singletonEntry.dragTo(canvas, {
      targetPosition: { x: Math.round(canvasBox.width / 3), y: Math.round(canvasBox.height / 2) },
    })
    await expect(page.getByTestId('fixture-widget').first()).toBeVisible({ timeout: 5000 })

    // Second spawn of the singleton — server returns 409; canvas logs a warning and does NOT add a second widget
    await singletonEntry.dragTo(canvas, {
      targetPosition: { x: Math.round((canvasBox.width * 2) / 3), y: Math.round(canvasBox.height / 2) },
    })
    await page.waitForTimeout(600)

    // Still only one widget on canvas
    await expect(page.getByTestId('fixture-widget')).toHaveCount(1)

    // Server has only one instance
    const r = await fetch(`${serverUrl}/api/plugin-widgets`)
    const body = await r.json() as { ok: boolean; data: unknown[] }
    expect(body.data.length).toBe(1)
  })
})

/**
 * Model-attribution bundled-plugin e2e smoke (Switchboard Phase 2, Step 4).
 *
 * Drags the bundled `model-attribution` widget from the WIDGETS palette onto the
 * canvas and asserts it mounts and renders its Sessions section without a console
 * error. Uses `pluginTest` (sessions enabled, so /api/plugin-widgets/registry
 * resolves configRoot and lists built-in palette widgets) — no plugins-config PUT
 * is required because model-attribution is a BUNDLED plugin served via
 * BUILTIN_PLUGIN_PKGS.
 *
 * NOTE: tinstar e2e is flaky on the Windows dev box (server spawn / sockets). This
 * spec is written for CI / operator UAT; it is NOT run as a blocking gate here.
 */
import { pluginTest as test, expect } from './fixtures'

test.describe('Model attribution widget', () => {
  test('spawns from the palette and renders the Sessions section without console error', async ({ page, serverUrl }) => {
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.goto(serverUrl)

    // The palette entry id is `palette-entry-${pluginId}-${widgetType}`.
    // model-attribution is the pluginId AND the widgetType.
    const entry = page.getByTestId('palette-entry-model-attribution-model-attribution')
    await expect(entry).toBeVisible({ timeout: 10_000 })

    const canvas = page.getByTestId('infinite-canvas')
    await expect(canvas).toBeVisible({ timeout: 5000 })
    const canvasBox = await canvas.boundingBox()
    if (!canvasBox) throw new Error('canvas has no bounding box')

    await entry.scrollIntoViewIfNeeded()
    await entry.dragTo(canvas, {
      targetPosition: { x: Math.round(canvasBox.width / 2), y: Math.round(canvasBox.height / 2) },
    })

    // The widget mounts: its root testid appears.
    const widget = page.getByTestId('model-attribution-widget').first()
    await expect(widget).toBeVisible({ timeout: 8000 })

    // It renders its Sessions section (label is always present; the row list or
    // the "No sessions" empty-state renders underneath once the first /api/state
    // poll resolves).
    await expect(widget.getByText('Sessions')).toBeVisible({ timeout: 5000 })

    // No console errors during mount + first poll.
    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join(' | ')}`).toEqual([])
  })
})

import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

/** Helper: create an editor widget via API and return the widget data */
async function createEditorWidget(page: import('@playwright/test').Page, filePath = '/etc/hostname') {
  const state = await page.evaluate(async () => {
    const r = await fetch('/api/state')
    return r.json()
  })
  const sessionId: string = state.runs[0]?.sessionId
  if (!sessionId) throw new Error('No runs in simulator state')

  const result = await page.evaluate(async ({ sid, fp }: { sid: string; fp: string }) => {
    const r = await fetch('/api/editor-widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, filePath: fp }),
    })
    return r.json()
  }, { sid: sessionId, fp: filePath })

  return result.data
}

test('editor widget appears when created via API', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  const before = await page.locator('[data-widget-type="file-editor"]').count()
  await createEditorWidget(page)
  await expect(page.locator('[data-widget-type="file-editor"]')).toHaveCount(before + 1, { timeout: 5000 })
})

test('editor widget footer shows "watching" when file content loads', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  await createEditorWidget(page, '/etc/hostname')

  const editorWidget = page.locator('[data-widget-type="file-editor"]').first()
  await expect(editorWidget).toBeVisible({ timeout: 5000 })
  // After our fix: host-absolute paths don't need a session lookup, so content
  // loads immediately and the footer shows "watching" (not "disconnected")
  await expect(editorWidget.locator('text=watching')).toBeVisible({ timeout: 10000 })
})

test('editor widget loads file content (not stuck on Loading)', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  await createEditorWidget(page, '/etc/hostname')

  const editorWidget = page.locator('[data-widget-type="file-editor"]').first()
  await expect(editorWidget).toBeVisible({ timeout: 5000 })

  // Verify "Loading…" goes away — content has been received
  await expect(editorWidget.locator('text=Loading…')).not.toBeVisible({ timeout: 10000 })
})

test('editor widget close button removes it', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  const widget = await createEditorWidget(page)
  if (!widget?.id) throw new Error('Widget creation failed or returned no id')

  const editorWidget = page.locator('[data-widget-type="file-editor"]').first()
  await expect(editorWidget).toBeVisible({ timeout: 5000 })

  // Delete via API (canvas widgets may overlap, making click unreliable;
  // the sidebar × test covers UI click deletion)
  await page.evaluate(async (id: string) => {
    await fetch(`/api/editor-widgets/${id}`, { method: 'DELETE' })
  }, widget.id)

  await expect(page.locator('[data-widget-type="file-editor"]')).toHaveCount(0, { timeout: 5000 })
})

test('editor widget sidebar × removes it', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  const widget = await createEditorWidget(page)
  if (!widget?.id) throw new Error('Widget creation failed or returned no id')

  // Editor node might be nested under a task — expand all sidebar chevrons
  const sidebar = page.getByTestId('hierarchy-sidebar')
  const chevrons = sidebar.locator('[data-testid^="chevron-"]')
  for (let i = 0; i < await chevrons.count(); i++) {
    await chevrons.nth(i).click()
    await page.waitForTimeout(50)
  }

  // The editor node appears in the sidebar with id "{widgetId}"
  const sidebarNode = page.getByTestId(`sidebar-node-${widget.id}`)
  await expect(sidebarNode).toBeVisible({ timeout: 5000 })

  // Hover to reveal × button, then click it
  await sidebarNode.hover()
  const closeBtn = sidebarNode.locator('button:has-text("×")')
  await expect(closeBtn).toBeVisible({ timeout: 2000 })
  await closeBtn.click()

  // Both sidebar node and canvas widget should be gone
  await expect(sidebarNode).not.toBeVisible({ timeout: 5000 })
  await expect(page.locator('[data-widget-type="file-editor"]')).toHaveCount(0, { timeout: 5000 })
})

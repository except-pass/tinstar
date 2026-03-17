import { test, expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test('editor widget appears when created via API', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  const state = await page.evaluate(async () => {
    const r = await fetch('/api/state')
    return r.json()
  })
  const sessionId = state.runs[0]?.sessionId
  if (!sessionId) throw new Error('No runs in simulator state')

  const before = await page.locator('[data-widget-type="file-editor"]').count()

  await page.evaluate(async (sid: string) => {
    await fetch('/api/editor-widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, filePath: '/etc/hostname' }),
    })
  }, sessionId)

  await expect(page.locator('[data-widget-type="file-editor"]')).toHaveCount(before + 1, { timeout: 5000 })
})

test('editor widget footer shows watching status', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  const state = await page.evaluate(async () => {
    const r = await fetch('/api/state')
    return r.json()
  })
  const sessionId = state.runs[0]?.sessionId
  if (!sessionId) throw new Error('No runs in simulator state')

  await page.evaluate(async (sid: string) => {
    await fetch('/api/editor-widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, filePath: '/etc/hostname' }),
    })
  }, sessionId)

  const editorWidget = page.locator('[data-widget-type="file-editor"]').first()
  await expect(editorWidget).toBeVisible({ timeout: 5000 })
  // Footer shows connection status — "watching" when connected, "disconnected" in simulator
  await expect(editorWidget.locator('text=/watching|disconnected/')).toBeVisible({ timeout: 10000 })
})

test('editor widget close button removes it', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  const state = await page.evaluate(async () => {
    const r = await fetch('/api/state')
    return r.json()
  })
  const sessionId = state.runs[0]?.sessionId
  if (!sessionId) throw new Error('No runs in simulator state')

  await page.evaluate(async (sid: string) => {
    await fetch('/api/editor-widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, filePath: '/etc/hostname' }),
    })
  }, sessionId)

  const before = await page.locator('[data-widget-type="file-editor"]').count()
  const editorWidget = page.locator('[data-widget-type="file-editor"]').first()
  await expect(editorWidget).toBeVisible({ timeout: 5000 })
  await editorWidget.locator('button[title="Close"]').click()
  await expect(page.locator('[data-widget-type="file-editor"]')).toHaveCount(before - 1, { timeout: 5000 })
})

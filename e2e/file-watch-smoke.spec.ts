/**
 * Smoke test for ADR 0002 — Phase 2 file-editor migration.
 *
 * Verifies that the file-editor plugin, now consuming `api.watch.file()`
 * instead of importing `useFileWatch` directly, still picks up live SSE
 * file-watch updates when an open file is edited externally.
 *
 * Approach:
 *   1. Create a temp file with initial content.
 *   2. Mount a file-editor widget pointing at it via the API.
 *   3. Confirm the widget renders + the watcher reports "watching".
 *   4. Edit the temp file from the test process.
 *   5. Verify the widget's Monaco editor value updates within a few seconds.
 */

import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('file-editor widget reflects external file edits via api.watch.file', async ({ page }) => {
  await page.goto('/')
  await resetAndWaitForData(page)

  const tmpDir = mkdtempSync(join(tmpdir(), 'tinstar-watch-smoke-'))
  const filePath = join(tmpDir, 'sample.txt')
  const initialContent = 'first revision\n'
  writeFileSync(filePath, initialContent)

  try {
    const state = await page.evaluate(async () => {
      const r = await fetch('/api/state')
      return r.json()
    })
    const sessionId: string = state.runs[0]?.sessionId
    if (!sessionId) throw new Error('No simulator runs to host the widget')

    const widget = await page.evaluate(async ({ sid, fp }: { sid: string; fp: string }) => {
      const r = await fetch('/api/editor-widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, filePath: fp }),
      })
      return (await r.json()).data
    }, { sid: sessionId, fp: filePath })

    expect(widget?.id, 'widget creation returned no id').toBeTruthy()

    const editorWidget = page.locator('[data-widget-type="file-editor"]').first()
    await expect(editorWidget).toBeVisible({ timeout: 10_000 })
    await expect(editorWidget.locator('text=Loading…')).not.toBeVisible({ timeout: 10_000 })
    await expect(editorWidget.locator('text=watching')).toBeVisible({ timeout: 10_000 })

    // Initial Monaco content — read it back through the global monaco instance.
    const readEditorValue = async () => page.evaluate(() => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors: () => Array<{ getValue: () => string }> } } }).monaco
      return monaco?.editor?.getEditors?.()?.[0]?.getValue?.() ?? null
    })

    await expect.poll(readEditorValue, { timeout: 10_000, intervals: [250, 500, 1000] }).toContain('first revision')

    // External edit — the file watcher should push the new content via SSE.
    const updatedContent = 'second revision\n'
    writeFileSync(filePath, updatedContent)

    await expect.poll(readEditorValue, { timeout: 10_000, intervals: [250, 500, 1000] }).toContain('second revision')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

import { test, expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test.describe('File Touched Hook', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('file-touched hook adds file to run with pending state', async ({ page }) => {
    // Get an existing run name from the simulator
    const state = await page.evaluate(async () => {
      const res = await fetch('/api/state')
      return res.json()
    })
    const firstRun = state.runs?.[0]
    if (!firstRun) return

    // Simulate a file-touched hook
    const result = await page.evaluate(async (runId: string) => {
      const res = await fetch('/api/hooks/file-touched', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: runId, path: '/src/utils/helper.ts' }),
      })
      return res.json()
    }, firstRun.id)

    expect(result.ok).toBe(true)

    // Verify the file was added
    const updatedState = await page.evaluate(async () => {
      const res = await fetch('/api/state')
      return res.json()
    })
    const updatedRun = updatedState.runs?.find((r: { id: string }) => r.id === firstRun.id)
    const newFile = updatedRun?.touchedFiles?.find((f: { path: string }) => f.path === '/src/utils/helper.ts')
    expect(newFile).toBeTruthy()
    expect(newFile.pending).toBe(true)
    expect(newFile.kind).toBe('code')
  })

  test('file-touched hook deduplicates by path', async ({ page }) => {
    const state = await page.evaluate(async () => {
      const res = await fetch('/api/state')
      return res.json()
    })
    const firstRun = state.runs?.[0]
    if (!firstRun) return

    // Send the same file twice
    await page.evaluate(async (runId: string) => {
      await fetch('/api/hooks/file-touched', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: runId, path: '/test/dedup-file.ts' }),
      })
      await fetch('/api/hooks/file-touched', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: runId, path: '/test/dedup-file.ts' }),
      })
    }, firstRun.id)

    // Should only have one entry
    const updatedState = await page.evaluate(async () => {
      const res = await fetch('/api/state')
      return res.json()
    })
    const updatedRun = updatedState.runs?.find((r: { id: string }) => r.id === firstRun.id)
    const matches = updatedRun?.touchedFiles?.filter((f: { path: string }) => f.path === '/test/dedup-file.ts')
    expect(matches?.length).toBe(1)
  })
})

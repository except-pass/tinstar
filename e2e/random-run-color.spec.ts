import { test, expect } from './fixtures'

// Keep these in sync with src/components/ColorPalette.tsx
const PALETTE_COLORS = [
  '#7df9ff', '#00f0ff', '#007a8a',
  '#b7ff9e', '#00ff88', '#00844a',
  '#ffd580', '#ffaa00', '#b36b00',
  '#ff9e9e', '#ff5555', '#cc2200',
  '#ff79c6', '#ff2e88', '#a8005a',
  '#e0c3fc', '#bd93f9', '#5b21b6',
  '#93c5fd', '#4d9de0', '#1d5a99',
  '#cbd5e1', '#94a3b8', '#334155',
]

/**
 * Reads the hex label shown under the palette in CreateSessionDialog.
 * That span is rendered with `className="text-xs font-mono"` and its text is the hex color.
 */
async function readRunColorHex(page: import('@playwright/test').Page): Promise<string> {
  const hex = await page
    .locator('.font-mono')
    .filter({ hasText: /^#[0-9a-fA-F]{6}$/ })
    .first()
    .innerText()
  return hex.toLowerCase()
}

test.describe('New Session dialog — default run color', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('initial run color is drawn from the palette (not always cyan)', async ({ page }) => {
    // Open once and record the color.
    await page.keyboard.press('s')
    await expect(page.getByTestId('session-name-input')).toBeVisible()
    const firstColor = await readRunColorHex(page)
    expect(PALETTE_COLORS.map(c => c.toLowerCase())).toContain(firstColor)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('session-name-input')).not.toBeVisible()

    // Open repeatedly — at least one of the samples should differ from the old cyan default.
    // With 24 palette colors this practically always holds after a few tries.
    const samples = new Set<string>([firstColor])
    for (let i = 0; i < 12 && samples.size < 2; i++) {
      await page.keyboard.press('s')
      await expect(page.getByTestId('session-name-input')).toBeVisible()
      samples.add(await readRunColorHex(page))
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('session-name-input')).not.toBeVisible()
    }
    expect(samples.size).toBeGreaterThan(1)
  })

  test('Random button picks a palette color', async ({ page }) => {
    await page.keyboard.press('s')
    await expect(page.getByTestId('session-name-input')).toBeVisible()

    const before = await readRunColorHex(page)
    const randomBtn = page.getByRole('button', { name: /random/i })
    await expect(randomBtn).toBeVisible()

    // Click until it lands on something different (or give up after 10 tries — with 24 colors this should be quick).
    let after = before
    for (let i = 0; i < 10 && after === before; i++) {
      await randomBtn.click()
      after = await readRunColorHex(page)
    }
    expect(PALETTE_COLORS.map(c => c.toLowerCase())).toContain(after)
    expect(after).not.toBe(before)
  })
})

// e2e/cc-quota.spec.ts
import { test, expect } from '@playwright/test'

test.describe('cc-quota HUD card', () => {
  test('renders clock, 7D bar, % left values, and gas-pump chip with fast-sim data', async ({ page }) => {
    await page.goto('/')
    // HUD may be toggled off; press "t" to ensure it's visible
    await page.keyboard.press('KeyT')

    const card = page.getByTestId('cc-quota-card')
    await expect(card).toBeVisible()

    // % left text — with fast-sim fixture: 5h=67% used → 33% left; 7d=89% used → 11% left
    await expect(card).toContainText('33% left')
    await expect(card).toContainText('11% left')

    // gas pump chip — fast-sim has is_enabled=true, used_credits=8148 → $81.48
    await expect(card.getByText('$81.48')).toBeVisible()
  })
})

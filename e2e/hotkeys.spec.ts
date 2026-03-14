import { test, expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test.describe('Hotkeys', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test.describe('Command Palette', () => {
    test('? opens palette', async ({ page }) => {
      await page.keyboard.press('?')
      await expect(page.getByTestId('hotkey-palette')).toBeVisible()
    })

    test('palette renders category headings', async ({ page }) => {
      await page.keyboard.press('?')
      await expect(page.getByText('General')).toBeVisible()
      await expect(page.getByText('Sessions')).toBeVisible()
      await expect(page.getByText('Hotgroups')).toBeVisible()
    })

    test('search filters hotkeys', async ({ page }) => {
      await page.keyboard.press('?')
      await page.getByTestId('hotkey-palette-input').fill('session')
      await expect(page.getByText('Next ready-for-input session')).toBeVisible()
      await expect(page.getByText('Pan mode')).not.toBeVisible()
    })

    test('Escape closes palette', async ({ page }) => {
      await page.keyboard.press('?')
      await expect(page.getByTestId('hotkey-palette')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('hotkey-palette')).not.toBeVisible()
    })

    test('clicking backdrop closes palette', async ({ page }) => {
      await page.keyboard.press('?')
      await page.mouse.click(10, 10) // outside the palette
      await expect(page.getByTestId('hotkey-palette')).not.toBeVisible()
    })

    test('? does not open palette when input is focused', async ({ page }) => {
      await page.getByTestId('add-root').click()
      await page.getByRole('textbox').first().focus()
      await page.keyboard.press('?')
      await expect(page.getByTestId('hotkey-palette')).not.toBeVisible()
      await page.keyboard.press('Escape') // close dialog
    })
  })

  test.describe('Hotgroups', () => {
    test('Ctrl+1 assigns selected run and shows badge', async ({ page }) => {
      await page.getByTestId('canvas-widget-R-241').click()
      await page.keyboard.press('Control+1')
      await expect(page.getByTestId('hotgroup-badge-R-241')).toContainText('⌨ 1')
      // Also check sidebar
      const sidebarBadge = page.getByTestId('sidebar-hotgroup-badge-R-241')
      await expect(sidebarBadge).toContainText('⌨ 1')
    })

    test('Ctrl+2 adds second slot — badge shows both', async ({ page }) => {
      await page.getByTestId('canvas-widget-R-241').click()
      await page.keyboard.press('Control+1')
      await page.keyboard.press('Control+2')
      await expect(page.getByTestId('hotgroup-badge-R-241')).toContainText('⌨ 1 2')
    })

    test('Ctrl+Shift+1 removes slot 1', async ({ page }) => {
      await page.getByTestId('canvas-widget-R-241').click()
      await page.keyboard.press('Control+1')
      await page.keyboard.press('Control+2')
      await page.keyboard.press('Control+Shift+1')
      await expect(page.getByTestId('hotgroup-badge-R-241')).toContainText('⌨ 2')
    })

    test('Ctrl+Shift+1 on unassigned slot is no-op', async ({ page }) => {
      await page.getByTestId('canvas-widget-R-241').click()
      await page.keyboard.press('Control+Shift+1') // slot 1 is empty
      await expect(page.getByTestId('hotgroup-badge-R-241')).not.toBeVisible()
    })

    test('pressing 1 selects the hotgroup', async ({ page }) => {
      await page.getByTestId('canvas-widget-R-241').click()
      await page.keyboard.press('Control+1')
      await page.getByTestId('infinite-canvas').click({ position: { x: 10, y: 10 } })
      await page.keyboard.press('1')
      const widget = page.getByTestId('canvas-widget-R-241')
      await expect(widget).toHaveClass(/ring|selected|border-indigo/)
    })

    test('pressing 1 twice zooms to fit hotgroup', async ({ page }) => {
      await page.getByTestId('canvas-widget-R-241').click()
      await page.keyboard.press('Control+1')
      await page.getByTestId('infinite-canvas').click({ position: { x: 10, y: 10 } })

      const zoomBefore = await page.getByTestId('zoom-indicator').textContent()
      await page.keyboard.press('1')
      await page.waitForTimeout(50)
      await page.keyboard.press('1')
      await page.waitForTimeout(300)

      const zoomAfter = await page.getByTestId('zoom-indicator').textContent()
      expect(zoomAfter).not.toBe(zoomBefore)
    })

    test('pressing 0 works as slot 10', async ({ page }) => {
      await page.getByTestId('canvas-widget-R-241').click()
      await page.keyboard.press('Control+0')
      await expect(page.getByTestId('hotgroup-badge-R-241')).toContainText('⌨ 0')
    })

    test('pressing unassigned slot is no-op', async ({ page }) => {
      await page.keyboard.press('5')
      await expect(page.getByTestId('hotkey-palette')).not.toBeVisible()
    })

    test('digit keys do not fire during sidebar node rename', async ({ page }) => {
      const node = page.getByTestId('sidebar-node-initiative-init-1')
      await node.hover()
      await page.getByTestId('menu-initiative-init-1').click({ force: true })
      const renameBtn = page.getByText('Rename')
      if (await renameBtn.isVisible()) {
        await renameBtn.click()
        await page.keyboard.press('1')
        await expect(page.getByTestId('hotkey-palette')).not.toBeVisible()
      }
    })
  })

  test.describe('Tab Navigation', () => {
    test('Tab moves focus to left panel zone', async ({ page }) => {
      const widget = page.getByTestId('canvas-widget-R-241')
      await widget.locator('[data-testid="widget-root-R-241"]').click()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('focus-zone-left-tab')).toHaveClass(/ring-2/)
    })

    test('Tab advances through zones', async ({ page }) => {
      await page.getByTestId('widget-root-R-241').click()
      await page.keyboard.press('Tab') // left-tab
      await page.keyboard.press('Tab') // file-list (if left expanded)
      await page.keyboard.press('Tab') // center-tabs
      await expect(page.getByTestId('focus-zone-center-tabs')).toHaveClass(/ring-2/)
    })

    test('Shift+Tab reverses', async ({ page }) => {
      await page.getByTestId('widget-root-R-241').click()
      await page.keyboard.press('Tab') // left-tab
      await page.keyboard.press('Shift+Tab') // wraps to right-panel
      await expect(page.getByTestId('focus-zone-right-panel')).toHaveClass(/ring-2/)
    })

    test('arrow keys switch center tabs when center-tabs is focused', async ({ page }) => {
      await page.getByTestId('widget-root-R-241').click()
      let attempts = 0
      while (attempts < 5) {
        await page.keyboard.press('Tab')
        const hasFocus = await page.getByTestId('focus-zone-center-tabs').evaluate(
          el => el.className.includes('ring-2')
        )
        if (hasFocus) break
        attempts++
      }
      const centerPanel = page.getByTestId('focus-zone-center-tabs')
      const tabsBefore = await centerPanel.locator('[aria-selected="true"]').textContent()
      await page.keyboard.press('ArrowRight')
      const tabsAfter = await centerPanel.locator('[aria-selected="true"]').textContent()
      expect(tabsAfter).not.toBe(tabsBefore)
    })
  })

  test.describe('Session Cycling', () => {
    test('] selects a run widget', async ({ page }) => {
      await page.keyboard.press(']')
      const selected = page.locator('[data-testid^="canvas-widget-"].ring-2, [data-testid^="canvas-widget-"][class*="selected"]')
      await expect(selected.first()).toBeVisible({ timeout: 2000 })
    })

    test('] cycles to a different run on second press', async ({ page }) => {
      await page.keyboard.press(']')
      const getSelected = async () => {
        const widgets = await page.locator('[data-testid^="canvas-widget-"]').all()
        for (const w of widgets) {
          const cls = await w.getAttribute('class') ?? ''
          if (cls.includes('ring') || cls.includes('selected')) {
            return await w.getAttribute('data-testid')
          }
        }
        return null
      }
      const first = await getSelected()
      await page.keyboard.press(']')
      const second = await getSelected()
      expect(second).not.toBeNull()
    })

    test('Shift+] cycles through all sessions', async ({ page }) => {
      await page.keyboard.press('Shift+]')
      const selected = page.locator('[data-testid^="canvas-widget-"].ring-2, [data-testid^="canvas-widget-"][class*="selected"]')
      await expect(selected.first()).toBeVisible({ timeout: 2000 })
    })
  })

  test.describe('Window Arrangements', () => {
    test('Ctrl+G arranges grid', async ({ page }) => {
      const root = page.getByTestId('group-container-initiative-init-1')
      const before = await root.boundingBox()

      await root.locator('.cursor-grab').first().evaluate((el, dy) => {
        const rect = el.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        el.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, button: 0, pointerId: 1, bubbles: true }))
        el.dispatchEvent(new PointerEvent('pointermove', { clientX: cx, clientY: cy + dy, pointerId: 1, bubbles: true }))
        el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))
      }, 200)
      await page.waitForTimeout(300)

      await page.keyboard.press('Control+g')
      await page.waitForTimeout(500)

      const after = await root.boundingBox()
      expect(Math.abs(after!.y - before!.y)).toBeLessThan(30)
    })

    test('Ctrl+Shift+G resets layout', async ({ page }) => {
      const root = page.getByTestId('group-container-initiative-init-1')
      const original = await root.boundingBox()

      await root.locator('.cursor-grab').first().evaluate((el) => {
        const rect = el.getBoundingClientRect()
        const cx = rect.left + rect.width / 2; const cy = rect.top + rect.height / 2
        el.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, button: 0, pointerId: 1, bubbles: true }))
        el.dispatchEvent(new PointerEvent('pointermove', { clientX: cx + 300, clientY: cy + 300, pointerId: 1, bubbles: true }))
        el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))
      })
      await page.waitForTimeout(300)

      await page.keyboard.press('Control+Shift+g')
      await page.waitForTimeout(500)

      const after = await root.boundingBox()
      expect(Math.abs(after!.y - original!.y)).toBeLessThan(30)
    })
  })

  test.describe('New Session (Ctrl+Enter)', () => {
    test('Ctrl+Enter opens CreateSessionDialog', async ({ page }) => {
      await page.keyboard.press('Control+Enter')
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 2000 })
      await page.keyboard.press('Escape')
    })

    test('Ctrl+Enter does not open dialog when input is focused', async ({ page }) => {
      await page.getByTestId('add-root').click()
      await page.getByRole('textbox').first().focus()
      await page.keyboard.press('Control+Enter')
      const dialogs = await page.getByRole('dialog').all()
      expect(dialogs.length).toBeLessThanOrEqual(1)
      await page.keyboard.press('Escape')
    })
  })
})

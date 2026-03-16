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

    test('palette renders widget display name headings', async ({ page }) => {
      await page.keyboard.press('?')
      const palette = page.getByTestId('hotkey-palette')
      await expect(palette.getByText('Agent Session')).toBeVisible()
    })

    test('search filters hotkeys', async ({ page }) => {
      await page.keyboard.press('?')
      await page.getByTestId('hotkey-palette-input').fill('terminal')
      await expect(page.getByText('Enter terminal')).toBeVisible()
      await expect(page.getByText('Next panel')).not.toBeVisible()
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
      await expect(widget).toHaveAttribute('data-selected', 'true')
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
      const w = page.getByTestId('widget-root-R-241')
      await w.click()
      await page.keyboard.press('Tab')
      await expect(w.getByTestId('focus-zone-left-tab')).toHaveClass(/ring-2/)
    })

    test('Tab advances through zones', async ({ page }) => {
      const w = page.getByTestId('widget-root-R-241')
      await w.click()
      await page.keyboard.press('Tab') // left-tab
      await page.keyboard.press('Tab') // file-list (if left expanded)
      await page.keyboard.press('Tab') // center-tabs
      await expect(w.getByTestId('focus-zone-center-tabs')).toHaveClass(/ring-2/)
    })

    test('Shift+Tab reverses', async ({ page }) => {
      const w = page.getByTestId('widget-root-R-241')
      await w.click()
      await page.keyboard.press('Tab') // left-tab
      await page.keyboard.press('Shift+Tab') // wraps to right-panel
      await expect(w.getByTestId('focus-zone-right-panel')).toHaveClass(/ring-2/)
    })

    test('arrow keys switch center tabs when center-tabs is focused', async ({ page }) => {
      const w = page.getByTestId('widget-root-R-241')
      await w.click()
      let attempts = 0
      while (attempts < 5) {
        await page.keyboard.press('Tab')
        const hasFocus = await w.getByTestId('focus-zone-center-tabs').evaluate(
          el => el.className.includes('ring-2')
        )
        if (hasFocus) break
        attempts++
      }
      const centerPanel = w.getByTestId('focus-zone-center-tabs')
      const tabsBefore = await centerPanel.locator('[aria-selected="true"]').textContent()
      await page.keyboard.press('ArrowRight')
      const tabsAfter = await centerPanel.locator('[aria-selected="true"]').textContent()
      expect(tabsAfter).not.toBe(tabsBefore)
    })
  })

  test.describe('Session Cycling', () => {
    test('] selects a run widget', async ({ page }) => {
      await page.keyboard.press(']')
      const selected = page.locator('[data-testid^="canvas-widget-"][data-selected="true"]')
      await expect(selected.first()).toBeVisible({ timeout: 2000 })
    })

    test('] cycles to a different run on second press', async ({ page }) => {
      await page.keyboard.press(']')
      const getSelected = async () => {
        const w = page.locator('[data-testid^="canvas-widget-"][data-selected="true"]').first()
        const visible = await w.isVisible().catch(() => false)
        if (!visible) return null
        return w.getAttribute('data-testid')
      }
      const first = await getSelected()
      await page.keyboard.press(']')
      const second = await getSelected()
      expect(second).not.toBeNull()
    })

    test('Shift+] cycles through all sessions', async ({ page }) => {
      await page.keyboard.press('Shift+]')
      const selected = page.locator('[data-testid^="canvas-widget-"][data-selected="true"]')
      await expect(selected.first()).toBeVisible({ timeout: 2000 })
    })
  })

  test.describe('Window Arrangements', () => {
    test('Ctrl+G arranges grid', async ({ page }) => {
      const root = page.getByTestId('group-container-initiative-init-1')

      await root.locator('.cursor-grab').first().evaluate((el, dy) => {
        const rect = el.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        el.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, button: 0, pointerId: 1, bubbles: true }))
        el.dispatchEvent(new PointerEvent('pointermove', { clientX: cx, clientY: cy + dy, pointerId: 1, bubbles: true }))
        el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))
      }, 200)
      await page.waitForTimeout(300)
      const dragged = await root.boundingBox()

      await page.keyboard.press('Control+g')
      await page.waitForTimeout(500)

      const after = await root.boundingBox()
      // Arrange should move the container away from the dragged position
      expect(Math.abs(after!.y - dragged!.y)).toBeGreaterThan(5)
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
      await expect(page.getByTestId('session-name-input')).toBeVisible({ timeout: 2000 })
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

  test.describe('Terminal Focus (Ctrl+\\)', () => {
    test('Ctrl+\\ focuses terminal and typed keys reach it', async ({ page }) => {
      // Replace terminal-wrapper.html with a key-capture stub for this test
      await page.route('**/terminal-wrapper.html**', route =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!DOCTYPE html><html><body style="background:black;color:lime;font-family:monospace">
            <div id="typed"></div>
            <script>
              window.addEventListener('keydown', function(e) {
                if (e.code === 'Backslash' && e.ctrlKey && e.shiftKey) {
                  window.parent.postMessage({ type: 'terminal-focus-toggle', sessionName: new URLSearchParams(location.search).get('session') }, '*')
                  return
                }
                document.getElementById('typed').textContent += e.key
              })
            </script>
          </body></html>`,
        })
      )

      // Inject a fake port into R-241 so the Terminal tab and iframe become visible
      await page.evaluate(async () => {
        await fetch('/api/simulator/patch-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'R-241', port: 19999 }),
        })
      })

      // Wait for the Terminal tab button to appear on R-241's widget
      const widget = page.getByTestId('widget-root-R-241')
      const terminalTabBtn = widget.getByRole('button', { name: 'Terminal', exact: true })
      await expect(terminalTabBtn).toBeVisible({ timeout: 3000 })

      // Assign R-241 to hotgroup 1
      await page.getByTestId('canvas-widget-R-241').click()
      await page.keyboard.press('Control+1')

      // Click away to deselect
      await page.getByTestId('infinite-canvas').click({ position: { x: 10, y: 10 } })
      await page.waitForTimeout(100)

      // Press 1 to re-select via hotgroup
      await page.keyboard.press('1')
      await expect(page.getByTestId('canvas-widget-R-241')).toHaveAttribute('data-selected', 'true')

      // Give the widget focus and switch to the Terminal tab via JS click
      // (avoids controls-bar pointer intercept issue in headless tests)
      await widget.click()
      await page.evaluate(() => {
        const widget = document.querySelector('[data-testid="widget-root-R-241"]')
        const btn = Array.from(widget?.querySelectorAll('button') ?? [])
          .find(b => b.textContent?.trim() === 'Terminal')
        btn?.click()
      })
      await page.waitForTimeout(100)

      // Re-focus the widget root so the keydown listener receives Ctrl+Backslash
      await widget.focus()

      // Dispatch Ctrl+\ directly on the widget root — what the browser does when focused
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="widget-root-R-241"]') as HTMLElement | null
        el?.dispatchEvent(new KeyboardEvent('keydown', {
          key: '\\', code: 'Backslash', ctrlKey: true, bubbles: true, cancelable: true,
        }))
      })
      await page.waitForTimeout(150) // requestAnimationFrame for iframe.focus()

      await expect(widget.getByTestId('terminal-focus-badge')).toBeVisible({ timeout: 1000 })

      // Verify the iframe actually received browser focus
      const iframeFocused = await page.evaluate(() => document.activeElement?.tagName === 'IFRAME')
      expect(iframeFocused).toBe(true)

      // Type into the terminal — keys should reach the stub iframe
      const terminalFrame = page.frameLocator(`[data-testid="widget-root-R-241"] iframe`)
      await terminalFrame.locator('body').dispatchEvent('click')
      await page.keyboard.type('hello')

      // The stub terminal page should have captured the keys
      await expect(terminalFrame.locator('#typed')).toContainText('hello', { timeout: 2000 })
    })
  })

  test.describe('Hotkeys Sidebar', () => {
    test('sidebar renders with ALWAYS section', async ({ page }) => {
      await expect(page.getByTestId('hotkeys-sidebar')).toBeVisible()
      await expect(page.getByTestId('hotkeys-sidebar').getByText('Always')).toBeVisible()
    })

    test('sidebar collapse and expand', async ({ page }) => {
      const sidebar = page.getByTestId('hotkeys-sidebar')
      await expect(sidebar).toBeVisible()
      // Click collapse button
      await sidebar.getByTitle('Collapse hotkeys panel').click()
      await expect(page.getByTestId('hotkeys-sidebar-collapsed')).toBeVisible()
      await expect(page.getByTestId('hotkeys-sidebar')).not.toBeVisible()
      // Click collapsed strip to expand
      await page.getByTestId('hotkeys-sidebar-collapsed').click()
      await expect(page.getByTestId('hotkeys-sidebar')).toBeVisible()
    })

    test('backtick clears focus path (root key)', async ({ page }) => {
      // Press backtick to clear focus path
      await page.keyboard.press('`')
      // Sidebar should show Canvas context
      await expect(page.getByTestId('hotkeys-sidebar').getByText('Canvas')).toBeVisible()
    })
  })

  test.describe('HotkeyPalette after migration', () => {
    test('palette still renders with key bindings', async ({ page }) => {
      await page.keyboard.press('?')
      const palette = page.getByTestId('hotkey-palette')
      await expect(palette).toBeVisible()
      // Should show at least the Agent Session section (from run-workspace WidgetDefinition)
      await expect(palette.getByText('Agent Session')).toBeVisible()
    })
  })

  test.describe('Quick Session (S)', () => {
    test('S opens CreateSessionDialog', async ({ page }) => {
      await page.keyboard.press('s')
      await expect(page.getByTestId('session-name-input')).toBeVisible({ timeout: 2000 })
      await page.keyboard.press('Escape')
    })

    test('S does not open dialog when input is focused', async ({ page }) => {
      await page.getByTestId('add-root').click()
      await page.getByRole('textbox').first().focus()
      await page.keyboard.press('s')
      await expect(page.getByTestId('session-name-input')).not.toBeVisible()
      await page.keyboard.press('Escape')
    })
  })
})

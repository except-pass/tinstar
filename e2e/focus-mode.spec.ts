import { test, expect, type Page } from './fixtures'
import { resetAndWaitForData } from './helpers'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const SCREENSHOTS_DIR = resolve('test-results/focus-mode-screenshots')

async function capture(page: Page, name: string) {
  await page.screenshot({ path: resolve(SCREENSHOTS_DIR, `${name}.png`), fullPage: false })
}

async function resetFocusFixture(page: Page, width = 1600, height = 900) {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.removeItem('tinstar-ui-prefs')
    localStorage.removeItem('tinstar-hidden-runs')
  })
  await resetAndWaitForData(page)
  await page.waitForTimeout(700)
}

async function enterFocus(page: Page) {
  const toggle = page.getByTestId('focus-mode-toggle')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('infinite-canvas')).toHaveAttribute('data-focus-mode', 'true')
  return page.locator('[data-testid^="canvas-widget-run-"]:visible').first()
}

async function focusedRunTestId(page: Page) {
  return page.locator('[data-testid^="canvas-widget-run-"]:visible').first().getAttribute('data-testid')
}

async function terminalResizeCount(page: Page, runId: string) {
  const terminal = page
    .frameLocator(`[data-testid="widget-root-${runId}"] iframe[title="Session terminal"]`)
    .frameLocator('#term')
  await expect(terminal.locator('body')).toBeAttached()
  return terminal.locator('body').evaluate(() => (
    window as Window & { __resizeCount?: number }
  ).__resizeCount ?? 0)
}

test.describe('Focus mode', () => {
  test.beforeAll(async () => {
    await mkdir(SCREENSHOTS_DIR, { recursive: true })
  })

  test.beforeEach(async ({ page }) => {
    await resetFocusFixture(page)
  })

  test('uses transient viewport geometry and restores camera, layout, and palette exactly', async ({ page }) => {
    let layoutPatchCount = 0
    await page.route('**/api/config', async route => {
      const request = route.request()
      if (request.method() === 'PATCH' && request.postData()?.includes('layouts')) layoutPatchCount++
      await route.continue()
    })
    const canvas = page.getByTestId('infinite-canvas')
    const target = page.getByTestId('canvas-widget-run-R-241')
    const paletteToggle = page.getByTestId('widgets-palette-toggle')
    const transform = page.getByTestId('canvas-transform-layer')

    const canonicalStyle = await target.evaluate(el => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
      width: (el as HTMLElement).style.width,
      height: (el as HTMLElement).style.height,
    }))
    const cameraTransform = await transform.evaluate(el => (el as HTMLElement).style.transform)
    await page.waitForTimeout(700)
    const layoutPatchCountBefore = layoutPatchCount
    await expect(paletteToggle).toHaveAttribute('aria-expanded', 'true')

    const active = await enterFocus(page)
    await expect(active).toHaveAttribute('data-testid', 'canvas-widget-run-R-241')
    await expect(paletteToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(paletteToggle).toBeDisabled()
    await expect(page.getByTestId('zoom-indicator')).not.toBeVisible()
    await expect(transform).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')

    const canvasBox = await canvas.boundingBox()
    const targetBox = await active.boundingBox()
    expect(canvasBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    expect(Math.abs(targetBox!.x - canvasBox!.x)).toBeLessThan(2)
    expect(Math.abs(targetBox!.y - canvasBox!.y)).toBeLessThan(2)
    expect(Math.abs(targetBox!.width - (canvasBox!.width - 320))).toBeLessThan(3)
    expect(Math.abs(targetBox!.height - canvasBox!.height)).toBeLessThan(3)
    await capture(page, 'wide-focus')

    const hiddenShells = page.locator('[data-testid^="canvas-widget-run-"][aria-hidden="true"]')
    expect(await hiddenShells.count()).toBeGreaterThan(0)
    await page.keyboard.press('Control+g')
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -200)
    await page.keyboard.up('Control')

    await page.getByTestId('focus-mode-toggle').click()
    await expect(page.getByTestId('zoom-indicator')).toBeVisible()
    await expect(paletteToggle).toHaveAttribute('aria-expanded', 'true')
    expect(await target.evaluate(el => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
      width: (el as HTMLElement).style.width,
      height: (el as HTMLElement).style.height,
    }))).toEqual(canonicalStyle)
    expect(await transform.evaluate(el => (el as HTMLElement).style.transform)).toBe(cameraTransform)
    await capture(page, 'restored-canvas')
    await page.waitForTimeout(700)
    expect(layoutPatchCount).toBe(layoutPatchCountBefore)
  })

  test('remembers Focus across reload and exposes constrained support drawers without changing preferences', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await enterFocus(page)

    const run = page.locator('[data-testid^="widget-root-"]:visible').first()
    await expect(run).toHaveAttribute('data-focus-constrained', 'true')
    const filesRail = run.getByTestId('focus-files-rail')
    const telemetryRail = run.getByTestId('focus-telemetry-rail')
    await capture(page, 'constrained-focus')
    await filesRail.click()
    await expect(run.getByTestId('focus-files-drawer')).toBeVisible()
    await telemetryRail.click()
    await expect(run.getByTestId('focus-files-drawer')).not.toBeVisible()
    await expect(run.getByTestId('focus-telemetry-drawer')).toBeVisible()
    await capture(page, 'telemetry-drawer')
    await page.keyboard.press('Escape')
    await expect(run.getByTestId('focus-telemetry-drawer')).not.toBeVisible()
    await expect(telemetryRail).toBeFocused()

    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('tinstar-ui-prefs') ?? '{}'))
    expect(prefs.focusMode).toBe(true)
    expect(prefs.telemetryCollapsed).not.toBe(true)

    await page.reload()
    await expect(page.getByTestId('focus-mode-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-testid^="canvas-widget-run-"]:visible')).toHaveCount(1)
  })

  test('cycles from the page and composer while preserving the mounted composer state', async ({ page }) => {
    await enterFocus(page)
    expect(await focusedRunTestId(page)).toBe('canvas-widget-run-R-241')

    // All-session cycling is reversible from the initial running target.
    await page.keyboard.press('Control+Shift+]')
    const firstAllTarget = await focusedRunTestId(page)
    expect(firstAllTarget).not.toBe('canvas-widget-run-R-241')
    await page.keyboard.press('Control+Shift+[')
    expect(await focusedRunTestId(page)).toBe('canvas-widget-run-R-241')

    // Ready cycling may enter a different queue; preserve state on that target
    // while moving forward and backward within the same ready queue.
    await page.keyboard.press('Control+]')
    const readyTargetTestId = await focusedRunTestId(page)
    expect(readyTargetTestId).not.toBe('canvas-widget-run-R-241')
    const readyRunId = readyTargetTestId!.replace('canvas-widget-run-', '')

    const run = page.getByTestId(`widget-root-${readyRunId}`)
    await run.getByRole('button', { name: /Prompt Composer/ }).click()
    const composer = run.getByPlaceholder('Enter prompt text... (Ctrl+Enter to send)')
    await composer.fill('keep this draft')
    await composer.press('Control+]')
    expect(await focusedRunTestId(page)).not.toBe(readyTargetTestId)
    await page.keyboard.press('Control+[')
    await expect(page.getByTestId(readyTargetTestId!)).toBeVisible()
    await expect(composer).toHaveValue('keep this draft')
  })

  test('switches focused runs without resizing either terminal viewport', async ({ page }) => {
    await page.route('**/s/**', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>
        html, body { width: 100%; height: 100%; margin: 0; }
      </style></head><body><script>
        window.__resizeCount = 0
        window.addEventListener('resize', () => { window.__resizeCount++ })
        window.term = { attachCustomKeyEventHandler() {}, focus() {} }
      </script></body></html>`,
    }))

    await page.evaluate(async () => {
      const state = await fetch('/api/state').then(response => response.json()) as {
        runs: Array<{ id: string; sessionId?: string | null }>
      }
      const ids = state.runs.filter(run => run.sessionId).map(run => run.id)
      await Promise.all(ids.map(id => fetch('/api/simulator/patch-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, port: 19999 }),
      })))
    })

    await page.reload()
    await enterFocus(page)
    await page.waitForTimeout(300)

    // Collapsed hierarchy branches are intentionally absent from the canvas.
    // Measure only the terminal workspaces that are actually mounted and can
    // therefore participate in Focus cycling.
    const runIds = await page.locator('[data-testid^="widget-root-"]').evaluateAll(roots => roots
      .filter(root => root.querySelector('iframe[title="Session terminal"]'))
      .map(root => root.getAttribute('data-testid')!.replace('widget-root-', '')))
    expect(runIds.length).toBeGreaterThan(1)

    const firstTestId = await focusedRunTestId(page)
    expect(firstTestId).not.toBeNull()
    const firstRunId = firstTestId!.replace('canvas-widget-run-', '')
    const before = new Map<string, number>()
    for (const runId of runIds) before.set(runId, await terminalResizeCount(page, runId))

    await page.keyboard.press('Control+Shift+]')
    await expect.poll(() => focusedRunTestId(page)).not.toBe(firstTestId)
    await page.waitForTimeout(300)

    const nextTestId = await focusedRunTestId(page)
    const nextRunId = nextTestId!.replace('canvas-widget-run-', '')
    expect(await terminalResizeCount(page, firstRunId)).toBe(before.get(firstRunId))
    expect(await terminalResizeCount(page, nextRunId)).toBe(before.get(nextRunId))
  })

  test('cycles from the terminal iframe bridge and shows a rate-limited boundary reminder', async ({ page }) => {
    // Keep the shipped terminal wrapper in the loop. Only replace the ttyd
    // document it embeds so the same-origin key and wheel bridges are exercised.
    await page.route('**/s/**', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>
        html, body { height: 100%; margin: 0; }
        .xterm-viewport { height: 60px; overflow-y: auto; }
        .scrollback { height: 400px; }
      </style></head><body tabindex="0">
        <div class="xterm-viewport" tabindex="0"><div class="scrollback">terminal</div></div>
        <script>
          window.term = {
            attachCustomKeyEventHandler(handler) { window.__terminalKeyHandler = handler },
            focus() { document.body.focus() }
          }
        </script>
      </body></html>`,
    }))
    await page.evaluate(async () => {
      await fetch('/api/simulator/patch-run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'R-241', port: 19999 }),
      })
    })
    await enterFocus(page)
    const run = page.getByTestId('widget-root-R-241')
    await run.getByRole('button', { name: 'Terminal', exact: true }).click()
    const wrapper = page.frameLocator('[data-testid="widget-root-R-241"] iframe[title="Session terminal"]')
    const terminal = wrapper.frameLocator('#term')
    await expect(terminal.locator('.xterm-viewport')).toBeVisible()
    await expect(wrapper.locator('#term')).toHaveAttribute('data-bridge-ready', 'true')

    await terminal.locator('.xterm-viewport').evaluate(viewport => {
      viewport.scrollTop = viewport.scrollHeight
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }))
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }))
    })
    const hint = page.getByRole('status').filter({ hasText: 'Ctrl + ]' })
    await expect(hint).toBeVisible()
    await expect(hint).toHaveCount(1)

    await terminal.locator('body').evaluate(body => {
      body.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'BracketRight', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }))
    })
    await expect.poll(() => focusedRunTestId(page)).not.toBe('canvas-widget-run-R-241')

    await page.locator('body').focus()
    await page.keyboard.press('Control+Shift+[')
    await expect.poll(() => focusedRunTestId(page)).toBe('canvas-widget-run-R-241')

    await page.evaluate(() => {
      const testWindow = window as Window & { __terminalCycleCount?: number }
      testWindow.__terminalCycleCount = 0
      window.addEventListener('tinstar:terminal-session-cycle', () => {
        testWindow.__terminalCycleCount = (testWindow.__terminalCycleCount ?? 0) + 1
      })
    })
    await terminal.locator('body').evaluate(body => {
      for (let index = 0; index < 2; index++) {
        body.dispatchEvent(new KeyboardEvent('keydown', {
          code: 'BracketRight', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }))
      }
    })
    await expect.poll(() => page.evaluate(() => (
      window as Window & { __terminalCycleCount?: number }
    ).__terminalCycleCount)).toBe(2)
  })

  test('falls back after live removal and reaches the empty state when the fleet disappears', async ({ page }) => {
    await enterFocus(page)
    expect(await focusedRunTestId(page)).toBe('canvas-widget-run-R-241')

    await page.evaluate(() => fetch('/api/simulator/remove-run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'R-241' }),
    }))
    await expect(page.getByTestId('canvas-widget-run-R-241')).not.toBeAttached()
    await expect(page.locator('[data-testid^="canvas-widget-run-"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-testid^="canvas-widget-run-"]:visible')).toHaveClass(/opacity-100/)

    await page.evaluate(async () => {
      const state = await fetch('/api/state').then(response => response.json()) as { runs: Array<{ id: string }> }
      await Promise.all(state.runs.map(run => fetch('/api/simulator/remove-run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: run.id }),
      })))
    })
    await expect(page.getByTestId('focus-empty-state')).toBeVisible()
    await expect(page.getByTestId('focus-empty-state').getByRole('button', { name: 'Return to Canvas' })).toBeVisible()
    await capture(page, 'empty-focus')
  })
})

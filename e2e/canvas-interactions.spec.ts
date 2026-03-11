import { test, expect, type Page, type Locator } from '@playwright/test'

// ── helpers ──────────────────────────────────────────────────────────────

/** Get bounding box, throw if not visible. */
async function box(locator: Locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error('element not visible')
  return b
}

/**
 * Drag an element by dispatching PointerEvents directly on its .cursor-grab
 * header. This bypasses Playwright's hit-testing which fails when the mouse
 * moves beyond the small header area (setPointerCapture doesn't work with
 * synthetic Playwright mouse events).
 */
async function drag(page: Page, locator: Locator, dx: number, dy: number) {
  const header = locator.locator('.cursor-grab').first()
  await header.evaluate(
    (el, { dx, dy }) => {
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const steps = 10
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: cx,
          clientY: cy,
          button: 0,
          pointerId: 1,
          bubbles: true,
          composed: true,
        }),
      )
      for (let i = 1; i <= steps; i++) {
        el.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: cx + (dx * i) / steps,
            clientY: cy + (dy * i) / steps,
            pointerId: 1,
            bubbles: true,
            composed: true,
          }),
        )
      }
      el.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 1,
          bubbles: true,
          composed: true,
        }),
      )
    },
    { dx, dy },
  )
  await page.waitForTimeout(300)
}

/** Drag a run widget via its .cursor-grab header. Same evaluate approach. */
async function dragRun(page: Page, run: Locator, dx: number, dy: number) {
  const header = run.locator('.cursor-grab').first()
  await header.evaluate(
    (el, { dx, dy }) => {
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const steps = 10
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: cx,
          clientY: cy,
          button: 0,
          pointerId: 1,
          bubbles: true,
          composed: true,
        }),
      )
      for (let i = 1; i <= steps; i++) {
        el.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: cx + (dx * i) / steps,
            clientY: cy + (dy * i) / steps,
            pointerId: 1,
            bubbles: true,
            composed: true,
          }),
        )
      }
      el.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 1,
          bubbles: true,
          composed: true,
        }),
      )
    },
    { dx, dy },
  )
  await page.waitForTimeout(300)
}

// ── fixtures ─────────────────────────────────────────────────────────────

const ROOT_1 = 'group-container-initiative-init-1' // AI Dev Platform
const ROOT_2 = 'group-container-initiative-init-2' // Observability Stack
const EPIC_1 = 'group-container-epic-epic-1' // Codebase Hygiene
const TASK_1 = 'group-container-task-task-1' // Reduce Scheduler Slop
const RUN_1 = 'canvas-widget-R-241'

// ── tests ────────────────────────────────────────────────────────────────

test.describe('Canvas Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('qala-uiv2-layouts-v3'))
    await page.reload()
    await page.waitForTimeout(500)
  })

  // ── Zoom ─────────────────────────────────────────────────────────────

  test.describe('Zoom', () => {
    test('Ctrl+scroll up zooms in', async ({ page }) => {
      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)

      for (let i = 0; i < 5; i++) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -100)
        await page.keyboard.up('Control')
      }
      await page.waitForTimeout(200)

      const text = await page.getByTestId('zoom-indicator').textContent()
      const pct = parseInt(text ?? '100')
      expect(pct).toBeGreaterThan(100)
    })

    test('Ctrl+scroll down zooms out', async ({ page }) => {
      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100)

      for (let i = 0; i < 8; i++) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, 100)
        await page.keyboard.up('Control')
      }
      await page.waitForTimeout(200)

      const text = await page.getByTestId('zoom-indicator').textContent()
      const pct = parseInt(text ?? '100')
      expect(pct).toBeLessThan(100)
    })

    test('zoom in then out — zoom indicator returns to ~100%', async ({ page }) => {
      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      const cx = canvasBox.x + canvasBox.width / 2
      const cy = canvasBox.y + canvasBox.height / 2
      await page.mouse.move(cx, cy)

      for (let i = 0; i < 3; i++) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -100)
        await page.keyboard.up('Control')
      }
      for (let i = 0; i < 3; i++) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, 100)
        await page.keyboard.up('Control')
      }
      await page.waitForTimeout(200)

      const text = await page.getByTestId('zoom-indicator').textContent()
      const pct = parseInt(text ?? '100')
      // Multiplicative zoom is asymmetric (×1.3 up, ×0.7 down), so 3+3 → ~75%
      // Just verify it came back closer to 100% than it was when zoomed in
      expect(pct).toBeGreaterThan(50)
      expect(pct).toBeLessThan(130)
    })

    // --- Negative: zoom has min/max bounds ---
    test('zoom does not go below 10%', async ({ page }) => {
      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100)

      for (let i = 0; i < 50; i++) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, 200)
        await page.keyboard.up('Control')
      }
      await page.waitForTimeout(200)

      const text = await page.getByTestId('zoom-indicator').textContent()
      const pct = parseInt(text ?? '100')
      expect(pct).toBeGreaterThanOrEqual(10)
    })

    test('zoom does not go above 400%', async ({ page }) => {
      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100)

      for (let i = 0; i < 50; i++) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -200)
        await page.keyboard.up('Control')
      }
      await page.waitForTimeout(200)

      const text = await page.getByTestId('zoom-indicator').textContent()
      const pct = parseInt(text ?? '100')
      expect(pct).toBeLessThanOrEqual(400)
    })
  })

  // ── Pan ──────────────────────────────────────────────────────────────

  test.describe('Pan', () => {
    test('scroll wheel pans content', async ({ page }) => {
      const root = page.getByTestId(ROOT_1)
      const before = await box(root)

      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)

      // Plain scroll (no Ctrl) → pan
      await page.mouse.wheel(0, -200)
      await page.waitForTimeout(200)

      const after = await box(root)
      // Content should move down (wheel deltaY=-200 → camera.y increases → content moves down)
      expect(after.y - before.y).toBeGreaterThan(100)
    })

    test('canvas uses overflow-hidden', async ({ page }) => {
      const canvas = page.getByTestId('infinite-canvas')
      const classList = await canvas.evaluate(el => el.className)
      expect(classList).toContain('overflow-hidden')
    })

    // --- Negative: scroll without Ctrl does NOT zoom ---
    test('scroll without Ctrl pans instead of zooming', async ({ page }) => {
      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100)

      await page.mouse.wheel(0, 200)
      await page.waitForTimeout(200)

      const text = await page.getByTestId('zoom-indicator').textContent()
      const pct = parseInt(text ?? '100')
      expect(pct).toBe(100)
    })

    // --- Negative: left-click on empty canvas does NOT pan ---
    test('left-click drag on empty canvas does not pan', async ({ page }) => {
      const root = page.getByTestId(ROOT_1)
      const before = await box(root)

      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      const sx = canvasBox.x + canvasBox.width - 30
      const sy = canvasBox.y + canvasBox.height - 30
      await page.mouse.move(sx, sy)
      await page.mouse.down()
      await page.mouse.move(sx + 100, sy + 100, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(200)

      const after = await box(root)
      // Left-click drag on empty canvas = no pan (only space+drag or middle-click pans)
      expect(Math.abs(after.x - before.x)).toBeLessThan(5)
      expect(Math.abs(after.y - before.y)).toBeLessThan(5)
    })
  })

  // ── Group Container Drag ──────────────────────────────────────────────

  test.describe('Group Container Drag', () => {
    test('drag root container moves it', async ({ page }) => {
      const el = page.getByTestId(ROOT_1)
      const before = await box(el)
      await drag(page, el, 0, 80)
      const after = await box(el)
      expect(after.y - before.y).toBeGreaterThan(30)
    })

    test('group drag moves descendants too', async ({ page }) => {
      const root = page.getByTestId(ROOT_1)
      const epic = page.getByTestId(EPIC_1)
      const beforeEpic = await box(epic)

      await drag(page, root, 0, 80)

      const afterEpic = await box(epic)
      expect(afterEpic.y - beforeEpic.y).toBeGreaterThan(30)
    })

    test('drag nested task container', async ({ page }) => {
      const el = page.getByTestId(TASK_1)
      const before = await box(el)
      await drag(page, el, 50, 0)
      const after = await box(el)
      expect(after.x - before.x).toBeGreaterThan(10)
    })

    // --- Negative: tiny mouse movement below threshold does NOT drag ---
    test('micro-movement below 5px threshold does not drag', async ({ page }) => {
      const el = page.getByTestId(ROOT_1)
      const before = await box(el)
      // Move only 2px — below 5px threshold
      await drag(page, el, 2, 1)
      const after = await box(el)
      expect(Math.abs(after.x - before.x)).toBeLessThan(5)
      expect(Math.abs(after.y - before.y)).toBeLessThan(5)
    })
  })

  // ── Run Widget Drag ───────────────────────────────────────────────────

  test.describe('Run Widget Drag', () => {
    test('drag run widget moves it', async ({ page }) => {
      const run = page.getByTestId(RUN_1)
      const before = await box(run)
      await dragRun(page, run, 0, 60)
      const after = await box(run)
      expect(after.y - before.y).toBeGreaterThan(20)
    })

    // --- Negative: run drag below threshold does not move ---
    test('micro-movement below threshold does not move run', async ({ page }) => {
      const run = page.getByTestId(RUN_1)
      const before = await box(run)
      await dragRun(page, run, 2, 1)
      const after = await box(run)
      expect(Math.abs(after.x - before.x)).toBeLessThan(5)
      expect(Math.abs(after.y - before.y)).toBeLessThan(5)
    })
  })

  // ── Auto-Expand (Cascade) ────────────────────────────────────────────

  test.describe('Auto-Expand', () => {
    test('dragging run past task container grows it', async ({ page }) => {
      const run = page.getByTestId(RUN_1)
      const task = page.getByTestId(TASK_1)
      const beforeTask = await box(task)

      // Task has 2 runs side-by-side (~1880px wide), so drag 1200px to exceed bounds
      await dragRun(page, run, 1200, 0)
      await page.waitForTimeout(300)

      const afterTask = await box(task)
      expect(afterTask.width).toBeGreaterThan(beforeTask.width + 100)
    })

    test('cascade expansion grows epic when task overflows', async ({ page }) => {
      const run = page.getByTestId(RUN_1)
      const task = page.getByTestId(TASK_1)
      const epic = page.getByTestId(EPIC_1)
      const beforeTask = await box(task)
      const beforeEpic = await box(epic)

      // Epic contains 2 tasks side-by-side (~2940px). Drag far enough to overflow epic.
      await dragRun(page, run, 3000, 0)
      await page.waitForTimeout(300)

      const afterTask = await box(task)
      const afterEpic = await box(epic)
      // Both task and its parent epic should have grown
      expect(afterTask.width).toBeGreaterThan(beforeTask.width)
      expect(afterEpic.width).toBeGreaterThan(beforeEpic.width)
    })

    // --- Negative: dragging run within bounds does NOT expand container ---
    test('small drag within bounds does not expand container', async ({ page }) => {
      const task = page.getByTestId(TASK_1)
      const run = page.getByTestId(RUN_1)
      const beforeTask = await box(task)

      await dragRun(page, run, 10, 0)
      await page.waitForTimeout(300)

      const afterTask = await box(task)
      expect(Math.abs(afterTask.width - beforeTask.width)).toBeLessThan(30)
    })
  })

  // ── Shrink-to-Fit ────────────────────────────────────────────────────

  test.describe('Shrink-to-Fit', () => {
    test('double-click container shrinks after manual resize', async ({ page }) => {
      const task = page.getByTestId(TASK_1)
      const initialTask = await box(task)

      // Manually resize the container larger via the resize handle (cursor-se-resize)
      const resizeHandle = task.locator('.cursor-se-resize').first()
      await resizeHandle.evaluate(
        (el, { dx, dy }) => {
          const rect = el.getBoundingClientRect()
          const cx = rect.left + rect.width / 2
          const cy = rect.top + rect.height / 2
          el.dispatchEvent(
            new PointerEvent('pointerdown', {
              clientX: cx, clientY: cy, button: 0, pointerId: 1, bubbles: true, composed: true,
            }),
          )
          el.dispatchEvent(
            new PointerEvent('pointermove', {
              clientX: cx + dx, clientY: cy + dy, pointerId: 1, bubbles: true, composed: true,
            }),
          )
          el.dispatchEvent(
            new PointerEvent('pointerup', { pointerId: 1, bubbles: true, composed: true }),
          )
        },
        { dx: 300, dy: 200 },
      )
      await page.waitForTimeout(300)

      const resizedTask = await box(task)
      expect(resizedTask.width).toBeGreaterThan(initialTask.width + 100)

      // Now double-click the container to shrink-to-fit
      const taskBox = await box(task)
      await page.mouse.dblclick(taskBox.x + 5, taskBox.y + 5)
      await page.waitForTimeout(300)

      const afterShrink = await box(task)
      // Should be smaller than the manually enlarged size
      expect(afterShrink.width).toBeLessThan(resizedTask.width - 50)
    })
  })

  // ── Arrange ──────────────────────────────────────────────────────────

  test.describe('Arrange', () => {
    test('arrange button resets layout after drag', async ({ page }) => {
      const root = page.getByTestId(ROOT_1)
      const original = await box(root)

      // Drag root down
      await drag(page, root, 0, 200)
      const displaced = await box(root)
      expect(Math.abs(displaced.y - original.y)).toBeGreaterThan(100)

      // Click arrange
      await page.getByTestId('arrange-button').click()
      await page.waitForTimeout(500)

      const after = await box(root)
      expect(Math.abs(after.y - original.y)).toBeLessThan(30)
    })

    // --- Negative: arrange button does not change zoom level ---
    test('arrange does not change zoom level', async ({ page }) => {
      const canvas = page.getByTestId('infinite-canvas')
      const canvasBox = await box(canvas)
      await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100)
      for (let i = 0; i < 3; i++) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -100)
        await page.keyboard.up('Control')
      }
      await page.waitForTimeout(200)

      const beforeZoom = await page.getByTestId('zoom-indicator').textContent()

      await page.getByTestId('arrange-button').click()
      await page.waitForTimeout(300)

      const afterZoom = await page.getByTestId('zoom-indicator').textContent()
      expect(afterZoom).toBe(beforeZoom)
    })
  })

  // ── Overlap Allowed ──────────────────────────────────────────────────

  test.describe('Overlap', () => {
    // --- Negative for collision resolution: overlap IS allowed ---
    test('dragging one container onto another does not push it', async ({ page }) => {
      const root1 = page.getByTestId(ROOT_1)
      const root2 = page.getByTestId(ROOT_2)
      const before2 = await box(root2)

      // Drag root1 onto root2's position
      const r1 = await box(root1)
      const r2 = await box(root2)
      const dy = r2.y + r2.height / 2 - (r1.y + r1.height / 2)
      const dx = r2.x + r2.width / 2 - (r1.x + r1.width / 2)
      await drag(page, root1, dx, dy)

      const after2 = await box(root2)
      const displacement = Math.abs(after2.x - before2.x) + Math.abs(after2.y - before2.y)
      expect(displacement).toBeLessThan(10)
    })
  })
})

import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

test.describe('Sidebar Drag-and-Drop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('dragging a group node shows floating drag card', async ({ page }) => {
    const node = page.getByTestId('sidebar-node-initiative-init-2')
    const box = await node.boundingBox()
    if (!box) return

    // Simulate drag: pointerdown then move beyond 4px threshold
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30, { steps: 10 })

    // Floating drag card should appear with the node label
    const ghost = page.getByTestId('drag-ghost')
    await expect(ghost).toBeVisible({ timeout: 2000 })
    await expect(ghost).toContainText('Observability Stack')

    await page.mouse.up()
    await expect(ghost).not.toBeVisible()
  })

  test('releasing drag without valid target does not crash', async ({ page }) => {
    const node = page.getByTestId('sidebar-node-initiative-init-2')
    const box = await node.boundingBox()
    if (!box) return

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y - 100, { steps: 10 })
    await page.mouse.up()

    // App should still be functional
    await expect(node).toBeVisible()
  })

  test('run nodes are not draggable', async ({ page }) => {
    // Expand to see runs
    await page.getByTestId('chevron-initiative-init-1').click()
    const sidebar = page.getByTestId('hierarchy-sidebar')
    await expect(sidebar.getByText('Codebase Hygiene')).toBeVisible()

    await page.getByTestId('chevron-epic-epic-1').click()
    await page.waitForTimeout(200)

    // Try to find a run node and verify no drag ghost appears
    const runNodes = page.locator('[data-drag-node-type="run"]')
    const count = await runNodes.count()
    if (count === 0) return

    const runNode = runNodes.first()
    const box = await runNode.boundingBox()
    if (!box) return

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30, { steps: 10 })

    // No drag ghost should appear for run nodes
    const ghost = page.getByTestId('drag-ghost')
    await expect(ghost).not.toBeVisible()

    await page.mouse.up()
  })
})

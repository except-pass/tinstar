import { test, expect } from './fixtures'

test.describe('Workspace Structure', () => {
  test.beforeEach(async ({ page }) => {
    // Clear persisted layouts so tests start with default arrangement
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('tinstar-layouts-v3'))
    await page.reload()
    await page.waitForTimeout(400)
  })

  test('page loads with all major sections', async ({ page }) => {
    await expect(page.getByTestId('controls-bar')).toBeVisible()
    await expect(page.getByTestId('sidebar-slot')).toBeVisible()
    await expect(page.getByTestId('canvas-slot')).toBeVisible()
    await expect(page.getByTestId('status-area')).toBeVisible()
    await expect(page.getByTestId('infinite-canvas')).toBeVisible()
  })

  test('status area shows run count', async ({ page }) => {
    await expect(page.getByTestId('status-area')).toContainText('14 runs')
  })

  test('arrange button and zoom indicator visible', async ({ page }) => {
    await expect(page.getByTestId('arrange-button')).toBeVisible()
    const zoom = page.getByTestId('zoom-indicator')
    await expect(zoom).toBeVisible()
    await expect(zoom).toContainText('100%')
  })
})

test.describe('Hierarchy Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('tinstar-layouts-v3'))
    await page.reload()
    await page.waitForTimeout(400)
  })

  test('sidebar renders initiative nodes', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByText('AI Dev Platform')).toBeVisible()
    await expect(sidebar.getByText('Observability Stack')).toBeVisible()
    await expect(sidebar.getByText('Developer Portal')).toBeVisible()
  })

  test('expand/collapse works', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')
    const chevron = page.getByTestId('chevron-initiative-init-1')
    await chevron.click()

    // Children should be visible
    await expect(sidebar.getByText('Codebase Hygiene')).toBeVisible()
    await expect(sidebar.getByText('Agent Orchestration')).toBeVisible()

    // Collapse
    await chevron.click()
    await expect(sidebar.getByText('Codebase Hygiene')).not.toBeVisible()
  })

  test('selection highlights node', async ({ page }) => {
    const node = page.getByTestId('sidebar-node-initiative-init-1')
    await node.click()
    await expect(node).toHaveClass(/bg-primary/)
  })

  test('add root button exists', async ({ page }) => {
    await expect(page.getByTestId('add-root')).toBeVisible()
  })

  test('run count badges on group nodes', async ({ page }) => {
    // Initiative nodes should show run count badges
    const node = page.getByTestId('sidebar-node-initiative-init-1')
    // The badge contains a number (run count)
    await expect(node.locator('.rounded-full')).toBeVisible()
  })

  // --- Negative: clicking run node does not show expand chevron ---
  test('run nodes do not have expand chevrons', async ({ page }) => {
    // Expand down to a run node
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.getByTestId('chevron-epic-epic-1').click()
    await page.getByTestId('chevron-task-task-1').click()
    await page.waitForTimeout(200)

    // Run node should exist but not have a chevron
    const runNode = page.getByTestId('sidebar-node-run-R-241')
    await expect(runNode).toBeVisible()
    const chevron = page.getByTestId('chevron-run-R-241')
    await expect(chevron).toHaveCount(0)
  })

  // --- Negative: run nodes do not have "+" add button ---
  test('run nodes do not have add child button', async ({ page }) => {
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.getByTestId('chevron-epic-epic-1').click()
    await page.getByTestId('chevron-task-task-1').click()
    await page.waitForTimeout(200)

    const addBtn = page.getByTestId('add-child-run-R-241')
    await expect(addBtn).toHaveCount(0)
  })
})

test.describe('Grouping Controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('tinstar-layouts-v3'))
    await page.reload()
    await page.waitForTimeout(400)
  })

  test('default pills are initiative, epic, task', async ({ page }) => {
    const controls = page.getByTestId('grouping-controls')
    await expect(controls.getByTestId('pill-initiative')).toBeVisible()
    await expect(controls.getByTestId('pill-epic')).toBeVisible()
    await expect(controls.getByTestId('pill-task')).toBeVisible()
    // Worktree should be an add button
    await expect(controls.getByTestId('add-worktree')).toBeVisible()
  })

  test('remove dimension — epic pill disappears, add-epic appears', async ({ page }) => {
    const controls = page.getByTestId('grouping-controls')
    await controls.getByTestId('remove-epic').click()

    await expect(controls.getByTestId('pill-epic')).toHaveCount(0)
    await expect(controls.getByTestId('add-epic')).toBeVisible()
  })

  test('add dimension — worktree pill appears', async ({ page }) => {
    const controls = page.getByTestId('grouping-controls')
    await controls.getByTestId('add-worktree').click()

    await expect(controls.getByTestId('pill-worktree')).toBeVisible()
  })

  test('remove dimension restructures sidebar', async ({ page }) => {
    const controls = page.getByTestId('grouping-controls')
    // Remove epic
    await controls.getByTestId('remove-epic').click()
    await page.waitForTimeout(300)

    // Expand initiative — should show tasks directly (no epic level)
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.waitForTimeout(200)

    const sidebar = page.getByTestId('hierarchy-sidebar')
    // Tasks should be visible directly under initiative
    await expect(sidebar.getByText('Reduce Scheduler Slop')).toBeVisible()
    // Epic nodes should not exist
    await expect(page.getByTestId('sidebar-node-epic-epic-1')).toHaveCount(0)
  })

  test('cannot remove last pill — no × button when only 1 remains', async ({ page }) => {
    const controls = page.getByTestId('grouping-controls')
    // Remove two pills
    await controls.getByTestId('remove-epic').click()
    await controls.getByTestId('remove-task').click()
    await page.waitForTimeout(200)

    // Only initiative pill remains — it should not have a remove button
    await expect(controls.getByTestId('pill-initiative')).toBeVisible()
    await expect(controls.getByTestId('remove-initiative')).toHaveCount(0)
  })

  // --- Negative: adding when at max 4 does nothing ---
  test('cannot add more than 4 dimensions', async ({ page }) => {
    const controls = page.getByTestId('grouping-controls')
    // Add worktree (now at 4)
    await controls.getByTestId('add-worktree').click()
    await page.waitForTimeout(200)

    // All 4 pills should be active
    await expect(controls.getByTestId('pill-initiative')).toBeVisible()
    await expect(controls.getByTestId('pill-epic')).toBeVisible()
    await expect(controls.getByTestId('pill-task')).toBeVisible()
    await expect(controls.getByTestId('pill-worktree')).toBeVisible()

    // No add buttons should remain
    await expect(controls.locator('[data-testid^="add-"]')).toHaveCount(0)
  })

  test('removing dimension removes canvas containers', async ({ page }) => {
    // Epic containers should exist initially
    await expect(page.getByTestId('group-container-epic-epic-1')).toBeVisible()

    // Remove epic
    await page.getByTestId('grouping-controls').getByTestId('remove-epic').click()
    await page.waitForTimeout(300)

    // Epic containers should be gone
    await expect(page.getByTestId('group-container-epic-epic-1')).toHaveCount(0)
    // But initiative and task containers should still exist
    await expect(page.getByTestId('group-container-initiative-init-1')).toBeVisible()
    await expect(page.getByTestId('group-container-task-task-1')).toBeVisible()
  })
})

test.describe('Canvas ↔ Sidebar Sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('tinstar-layouts-v3'))
    await page.reload()
    await page.waitForTimeout(400)
  })

  test('canvas has group containers', async ({ page }) => {
    await expect(page.getByTestId('group-container-initiative-init-1')).toBeVisible()
    await expect(page.getByTestId('group-container-epic-epic-1')).toBeVisible()
    await expect(page.getByTestId('group-container-task-task-1')).toBeVisible()
  })

  test('canvas has run widgets', async ({ page }) => {
    await expect(page.getByTestId('canvas-widget-R-241')).toBeVisible()
  })

  test('clicking canvas widget selects sidebar node', async ({ page }) => {
    const widget = page.getByTestId('canvas-widget-R-241')
    await widget.click()
    await page.waitForTimeout(200)

    // The sidebar node for this run should have selection styling
    const sidebarNode = page.getByTestId('sidebar-node-run-R-241')
    await expect(sidebarNode).toHaveClass(/bg-primary/)
  })

  // --- Clicking empty canvas deselects everything ---
  test('clicking empty canvas area deselects sidebar nodes', async ({ page }) => {
    // First select something
    const widget = page.getByTestId('canvas-widget-R-241')
    await widget.click()
    await page.waitForTimeout(200)

    // Now click far away on empty canvas (bottom-right corner)
    const canvas = page.getByTestId('infinite-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('canvas not visible')
    await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10)
    await page.waitForTimeout(200)

    // The run node should be deselected — clicking empty canvas clears selection
    const sidebarNode = page.getByTestId('sidebar-node-run-R-241')
    await expect(sidebarNode).not.toHaveClass(/bg-primary/)
  })
})

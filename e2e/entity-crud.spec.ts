import { test, expect } from './fixtures'
import { resetAndWaitForData } from './helpers'

// These tests mutate shared simulator state (delete entities).
// Running them in parallel causes races where one test's reset wipes another's data.
test.describe.configure({ mode: 'serial' })

/** Open the kebab menu for a sidebar node and click a menu action */
async function openMenuAndClick(page: import('@playwright/test').Page, nodeId: string, actionTestId: string) {
  const node = page.getByTestId(`sidebar-node-${nodeId}`)
  await expect(node).toBeVisible()
  await node.hover({ force: true })
  await page.getByTestId(`menu-${nodeId}`).click({ force: true })
  const menu = page.getByTestId('entity-menu')
  await expect(menu).toBeVisible()
  await page.getByTestId(actionTestId).click()
}

/** Open the kebab menu for a sidebar node and delete with confirmation */
async function deleteViaSidebarMenu(page: import('@playwright/test').Page, nodeId: string) {
  await openMenuAndClick(page, nodeId, 'menu-action-delete')
  await page.getByTestId('menu-confirm-delete').click()
}

test.describe('Entity Deletion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('delete initiative from sidebar removes it', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')
    await expect(sidebar.getByText('Developer Portal')).toBeVisible()

    await deleteViaSidebarMenu(page, 'initiative-init-3')

    await expect(sidebar.getByText('Developer Portal')).not.toBeVisible()
  })

  test('delete epic from sidebar removes it', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')

    // Expand init-1 to see epics
    await page.getByTestId('chevron-initiative-init-1').click()
    await expect(sidebar.getByText('Codebase Hygiene')).toBeVisible()

    await deleteViaSidebarMenu(page, 'epic-epic-1')

    await expect(sidebar.getByText('Codebase Hygiene')).not.toBeVisible()
  })

  test('delete group container from canvas removes it', async ({ page }) => {
    await expect(page.getByTestId('group-container-initiative-init-3')).toBeVisible()

    // Hover the container header to reveal menu button
    const container = page.getByTestId('group-container-initiative-init-3')
    const header = container.locator('.cursor-grab').first()
    await header.hover()

    // Click kebab menu on canvas group container
    await page.getByTestId('menu-group-initiative-init-3').click({ force: true })
    const menu = page.getByTestId('entity-menu')
    await expect(menu).toBeVisible()

    // Delete with confirmation
    await page.getByTestId('menu-action-delete').click()
    await page.getByTestId('menu-confirm-delete').click()

    await expect(page.getByTestId('group-container-initiative-init-3')).not.toBeVisible()
  })

  test('deleting entity orphans its children', async ({ page }) => {
    const sidebar = page.getByTestId('hierarchy-sidebar')

    // Expand init-1 to see epics
    await page.getByTestId('chevron-initiative-init-1').click()
    await expect(sidebar.getByText('Codebase Hygiene')).toBeVisible()

    await deleteViaSidebarMenu(page, 'initiative-init-1')

    await expect(sidebar.getByText('AI Dev Platform')).not.toBeVisible()

    // Child epics should still exist (as orphans)
    await expect(sidebar.getByText('Codebase Hygiene')).toBeVisible()
    await expect(sidebar.getByText('Agent Orchestration')).toBeVisible()
  })
})

test.describe('Entity Creation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('add root button opens create dialog', async ({ page }) => {
    await page.getByTestId('add-root').click()
    await page.getByTestId('add-root-initiative').click()

    const dialog = page.locator('[role="dialog"], .fixed, [class*="backdrop"]').first()
    await expect(dialog).toBeVisible({ timeout: 3000 })
  })

  test('add child via menu opens create dialog', async ({ page }) => {
    await page.getByTestId('chevron-initiative-init-1').click()
    await page.waitForTimeout(200)

    await openMenuAndClick(page, 'initiative-init-1', 'menu-action-add-child')

    const dialog = page.locator('[role="dialog"], .fixed, [class*="backdrop"]').first()
    await expect(dialog).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Entity Menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await resetAndWaitForData(page)
  })

  test('entity menu opens and shows all options', async ({ page }) => {
    const node = page.getByTestId('sidebar-node-initiative-init-2')
    await node.hover()
    await page.getByTestId('menu-initiative-init-2').click({ force: true })

    const menu = page.getByTestId('entity-menu')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('menu-action-start-session')).toBeVisible()
    await expect(page.getByTestId('menu-action-settings-')).toBeVisible()
    await expect(page.getByTestId('menu-action-rename')).toBeVisible()
    await expect(page.getByTestId('menu-action-add-child')).toBeVisible()
    await expect(page.getByTestId('menu-action-delete')).toBeVisible()

    // Close with Escape
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('delete confirmation flow', async ({ page }) => {
    const node = page.getByTestId('sidebar-node-initiative-init-2')
    await node.hover()
    await page.getByTestId('menu-initiative-init-2').click({ force: true })

    const menu = page.getByTestId('entity-menu')
    await expect(menu).toBeVisible()

    // Click delete — should show confirmation, not immediately delete
    await page.getByTestId('menu-action-delete').click()
    await expect(page.getByText('Children will be ungrouped')).toBeVisible()

    // Cancel should return to normal menu
    await page.getByText('Cancel').click()
    await expect(page.getByTestId('menu-action-delete')).toBeVisible()
  })
})

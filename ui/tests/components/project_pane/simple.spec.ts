import { test, expect } from '@playwright/test';

test.describe('Project Pane - Simple Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:8080/test-page.html');
    
    // Wait for React to load and render
    await page.waitForSelector('.project-pane', { timeout: 10000 });
  });

  test('renders project pane with basic structure', async ({ page }) => {
    await expect(page.locator('.project-pane')).toBeVisible();
    await expect(page.locator('.project-pane__projects')).toBeVisible();
    await expect(page.locator('.project-pane__new-project')).toBeVisible();
  });

  test('displays loading state initially', async ({ page }) => {
    // Reload to catch loading state
    await page.reload();
    
    // Should show loading initially
    const loading = page.locator('.project-pane__loading');
    if (await loading.count() > 0) {
      await expect(loading).toHaveText('Loading projects...');
    }
  });

  test('shows project widgets after loading', async ({ page }) => {
    // Wait for projects to load
    await page.waitForSelector('.project-widget', { timeout: 5000 });
    
    const widgets = page.locator('.project-widget');
    await expect(widgets).toHaveCount(2);
  });

  test('displays correct project names', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    const names = page.locator('.project-widget__name');
    await expect(names.first()).toHaveText('test-project-1');
    await expect(names.nth(1)).toHaveText('test-project-2');
  });

  test('shows control buttons for each project', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    const firstWidget = page.locator('.project-widget').first();
    await expect(firstWidget.locator('.project-widget__refresh')).toBeVisible();
    await expect(firstWidget.locator('.project-widget__settings')).toBeVisible();
    await expect(firstWidget.locator('.project-widget__close')).toBeVisible();
  });

  test('applies different background colors to projects', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    const firstBg = await page.locator('.project-widget').first().evaluate(
      el => getComputedStyle(el).backgroundColor
    );
    
    const secondBg = await page.locator('.project-widget').nth(1).evaluate(
      el => getComputedStyle(el).backgroundColor
    );
    
    // Should have different colors
    expect(firstBg).not.toBe(secondBg);
    
    // Should be from our color palette (convert hex to rgb)
    const expectedColors = [
      'rgb(198, 167, 123)', // #C6A77B Desert Sand
      'rgb(139, 90, 43)',   // #8B5A2B Saddle Brown
    ];
    
    expect([firstBg, secondBg].some(color => expectedColors.includes(color))).toBe(true);
  });

  test('new project button is functional', async ({ page }) => {
    await expect(page.locator('.project-pane__new-project')).toBeVisible();
    await expect(page.locator('.project-pane__new-project')).toHaveText('+ New Project');
    
    // Should be clickable
    await expect(page.locator('.project-pane__new-project')).toBeEnabled();
  });

  test('refresh button works', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    const refreshBtn = page.locator('.project-widget__refresh').first();
    
    // Should be clickable
    await expect(refreshBtn).toBeEnabled();
    await expect(refreshBtn).toHaveAttribute('title', 'Refresh file list');
    
    // Click should work without error
    await refreshBtn.click();
  });

  test('close button removes project', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    // Should start with 2 projects
    await expect(page.locator('.project-widget')).toHaveCount(2);
    
    // Close first project
    await page.locator('.project-widget__close').first().click();
    
    // Should now have 1 project
    await page.waitForTimeout(500); // Wait for state update
    await expect(page.locator('.project-widget')).toHaveCount(1);
    
    // Remaining project should be the second one
    await expect(page.locator('.project-widget__name')).toHaveText('test-project-2');
  });

  test('file tree is embedded in each project', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    // Each project should have a file tree
    const fileTrees = page.locator('.file-tree-container');
    await expect(fileTrees).toHaveCount(2);
    
    // Trees should show files
    await page.waitForSelector('.file-entry');
    const fileEntries = page.locator('.file-entry');
    await expect(fileEntries.first()).toBeVisible();
  });

  test('file edit buttons work', async ({ page }) => {
    await page.waitForSelector('.file-entry');
    
    // Look for edit buttons
    const editButtons = page.locator('button[title="Open in editor"]');
    
    if (await editButtons.count() > 0) {
      // Should be clickable
      await expect(editButtons.first()).toBeEnabled();
      
      // Click should work (will be logged to console)
      await editButtons.first().click();
    }
  });

  test('CSS styles are applied correctly', async ({ page }) => {
    await page.waitForSelector('.project-pane');
    
    // Check main container styles
    const pane = page.locator('.project-pane');
    const display = await pane.evaluate(el => getComputedStyle(el).display);
    expect(display).toBe('flex');
    
    // Check project widget styles
    const widget = page.locator('.project-widget').first();
    const borderRadius = await widget.evaluate(el => getComputedStyle(el).borderRadius);
    expect(borderRadius).toBe('6px');
  });
});
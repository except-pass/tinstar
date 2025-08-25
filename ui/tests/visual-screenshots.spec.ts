/**
 * Visual Screenshot Tests
 * 
 * Generates screenshots of the FileTree component for visual inspection
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

test.describe('FileTree Visual Screenshots', () => {
  let htmlContent: string;

  test.beforeAll(() => {
    htmlContent = readFileSync(join(__dirname, '../simple-test.html'), 'utf8');
  });

  test.beforeEach(async ({ page }) => {
    await page.setContent(htmlContent);
    await page.waitForSelector('[data-testid="filetree-container"]');
    await page.waitForTimeout(200);
  });

  test('screenshot - full component with expanded tree', async ({ page }) => {
    // Take screenshot of the entire component
    await page.screenshot({ 
      path: 'test-results/filetree-full-component.png',
      fullPage: true 
    });
    
    // Take screenshot of just the file tree container
    const container = page.locator('[data-testid="filetree-container"]');
    await container.screenshot({ 
      path: 'test-results/filetree-component-only.png' 
    });
  });

  test('screenshot - component after running tests', async ({ page }) => {
    // Run the automated tests first
    await page.click('[data-testid="run-all"]');
    await page.waitForTimeout(1000);
    
    // Take screenshot showing test results
    await page.screenshot({ 
      path: 'test-results/filetree-with-test-results.png',
      fullPage: true 
    });
  });

  test('screenshot - individual component elements', async ({ page }) => {
    // Screenshot of file entries
    const fileEntries = page.locator('.file-entry').first();
    await fileEntries.screenshot({ 
      path: 'test-results/file-entry-example.png' 
    });
    
    // Screenshot of stats display
    const statsElement = page.locator('.stats').first();
    await statsElement.screenshot({ 
      path: 'test-results/stats-display.png' 
    });
    
    // Screenshot of edit button
    const editButton = page.locator('.edit-button').first();
    await editButton.screenshot({ 
      path: 'test-results/edit-button.png' 
    });
  });

  test('screenshot - different file types and stats', async ({ page }) => {
    // Get different types of entries for comparison
    const fileWithStats = page.locator('[data-path="README.md"]');
    await fileWithStats.screenshot({ 
      path: 'test-results/file-with-stats.png' 
    });
    
    // Take a screenshot showing the hierarchy
    const container = page.locator('[data-testid="filetree-container"]');
    await container.screenshot({ 
      path: 'test-results/file-hierarchy.png' 
    });
  });
});
import { test, expect } from '@playwright/test';

test.describe('QuickDraw', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/master.html');
    
    // Wait for the page to be loaded
    await page.waitForLoadState('networkidle');
    
    // Mock the API endpoints
    await page.route('/api/sessions', async route => {
      const sessions = [
        {
          id: 'session-1',
          name: 'test-agent-1',
          project: 'test-project',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          last_activity: '2024-01-01T01:00:00Z',
          agent_type: 'claude'
        },
        {
          id: 'session-2',
          name: 'test-agent-2',
          project: 'test-project',
          status: 'active',
          created_at: '2024-01-01T00:00:00Z',
          last_activity: '2024-01-01T01:00:00Z',
          agent_type: 'claude'
        }
      ];
      
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions })
      });
    });

    await page.route('/api/projects', async route => {
      const projects = [
        {
          name: 'test-project',
          path: '/test/path',
          created_at: '2024-01-01T00:00:00Z',
          unignore_paths: []
        }
      ];
      
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ projects })
      });
    });

    await page.route('/api/events**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([])
      });
    });

    // Reload to pick up mocked data
    await page.reload();
    await page.waitForLoadState('networkidle');
  });

  test('displays QuickDraw icon in header', async ({ page }) => {
    const quickDrawIcon = page.locator('.quick-draw-icon');
    await expect(quickDrawIcon).toBeVisible();
    await expect(quickDrawIcon).toContainText('Quick Draw');
  });

  test('shows tooltip on hover', async ({ page }) => {
    const quickDrawIcon = page.locator('.quick-draw-icon');
    await quickDrawIcon.hover();
    
    const tooltip = page.locator('.quick-draw-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('Quick Draw - Keyboard shortcuts for rapid UI navigation');
  });

  test('activates namespace when pressing "a"', async ({ page }) => {
    // Press 'a' key
    await page.keyboard.press('a');
    
    // Should show active namespace indicator
    const activeIndicator = page.locator('.quick-draw-active');
    await expect(activeIndicator).toBeVisible();
    await expect(activeIndicator).toContainText('Agents a+');
  });

  test('shows help context overlay after timeout', async ({ page }) => {
    // Press 'a' key to activate namespace
    await page.keyboard.press('a');
    
    // Wait for help context timeout (2 seconds + buffer)
    await page.waitForTimeout(2500);
    
    // Help overlay should appear
    const helpOverlay = page.locator('.help-context-overlay');
    await expect(helpOverlay).toBeVisible();
    
    // Should show instructions
    const instructions = page.locator('.overlay-instructions');
    await expect(instructions).toBeVisible();
    await expect(instructions).toContainText('Agents namespace active');
  });

  test('clears namespace on Escape', async ({ page }) => {
    // Press 'a' key to activate namespace
    await page.keyboard.press('a');
    
    const activeIndicator = page.locator('.quick-draw-active');
    await expect(activeIndicator).toBeVisible();
    
    // Press Escape to clear
    await page.keyboard.press('Escape');
    
    // Should return to icon state
    await expect(activeIndicator).not.toBeVisible();
    const quickDrawIcon = page.locator('.quick-draw-icon');
    await expect(quickDrawIcon).toBeVisible();
  });

  test('executes agent selection action', async ({ page }) => {
    // Mock agent click handler
    await page.evaluate(() => {
      (window as any).agentClicked = null;
      // Add event listener for agent clicks
      document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-testid^="agent-"]')) {
          const agentId = target.closest('[data-testid^="agent-"]')?.getAttribute('data-testid')?.replace('agent-', '');
          (window as any).agentClicked = agentId;
        }
      });
    });
    
    // Wait for agents to load
    await page.waitForSelector('[data-testid^="agent-"]', { timeout: 5000 });
    
    // Press 'a' to activate namespace, then 'a' to select first agent
    await page.keyboard.press('a');
    await page.keyboard.press('a');
    
    // Check that agent was clicked
    const agentClicked = await page.evaluate(() => (window as any).agentClicked);
    expect(agentClicked).toBe('session-1');
  });

  test('shows new agent dialog on "a" then "n"', async ({ page }) => {
    // Press 'a' to activate namespace, then 'n' for new agent
    await page.keyboard.press('a');
    await page.keyboard.press('n');
    
    // Should open new agent dialog
    const dialog = page.locator('.new-agent-dialog');
    await expect(dialog).toBeVisible();
    
    const dialogTitle = page.locator('.dialog-content h4');
    await expect(dialogTitle).toContainText('Create New Agent');
  });
});
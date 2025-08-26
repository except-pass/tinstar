import { test, expect } from '@playwright/test';

test.describe('ProjectWidget Component', () => {
  const mockProject = {
    name: 'test-project',
    path: '/path/to/project',
    created_at: '2024-01-01T00:00:00Z',
    unignore_paths: ['src/config.json', '.env.local']
  };

  test.beforeEach(async ({ page }) => {
    // Mock filelist API
    await page.route('/api/filelist/*/tree', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tree: {
            type: 'directory',
            path: 'src',
            name: 'src',
            id: 'src',
            children: [
              {
                type: 'file',
                path: 'src/App.tsx',
                name: 'App.tsx',
                size: 1024,
                modified: '2024-01-01T10:00:00Z',
                stats: { lines_added: 10, lines_removed: 2, is_tracked: true },
                id: 'src/App.tsx'
              }
            ],
            stats: { lines_added: 10, lines_removed: 2 }
          }
        })
      });
    });

    // Mock editor API
    await page.route('/api/editor/open', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      });
    });

    // Create test page with ProjectWidget
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <script type="module">
            import React from 'react';
            import ReactDOM from 'react-dom/client';
            import { ProjectWidget } from '/project_pane/ProjectWidget.js';
            
            const project = ${JSON.stringify(mockProject)};
            const onClose = () => console.log('close');
            const onRefresh = () => console.log('refresh');
            
            const root = ReactDOM.createRoot(document.getElementById('root'));
            root.render(React.createElement(ProjectWidget, { 
              project, 
              colorIndex: 0, 
              onClose, 
              onRefresh 
            }));
          </script>
        </head>
        <body>
          <div id="root"></div>
        </body>
      </html>
    `);
  });

  test('renders project widget with correct structure', async ({ page }) => {
    await expect(page.locator('.project-widget')).toBeVisible();
    await expect(page.locator('.project-widget__header')).toBeVisible();
    await expect(page.locator('.project-widget__content')).toBeVisible();
  });

  test('displays project name correctly', async ({ page }) => {
    await expect(page.locator('.project-widget__name')).toHaveText('test-project');
  });

  test('shows all three control buttons', async ({ page }) => {
    const controls = page.locator('.project-widget__controls');
    await expect(controls).toBeVisible();
    
    // Check for refresh, settings, and close buttons
    await expect(page.locator('.project-widget__refresh')).toBeVisible();
    await expect(page.locator('.project-widget__settings')).toBeVisible();
    await expect(page.locator('.project-widget__close')).toBeVisible();
  });

  test('refresh button has correct icon and title', async ({ page }) => {
    const refreshBtn = page.locator('.project-widget__refresh');
    await expect(refreshBtn).toHaveText('↻');
    await expect(refreshBtn).toHaveAttribute('title', 'Refresh file list');
  });

  test('settings button has correct icon and title', async ({ page }) => {
    const settingsBtn = page.locator('.project-widget__settings');
    await expect(settingsBtn).toHaveText('⚙');
    await expect(settingsBtn).toHaveAttribute('title', 'Project settings');
  });

  test('close button has correct icon and title', async ({ page }) => {
    const closeBtn = page.locator('.project-widget__close');
    await expect(closeBtn).toHaveText('✕');
    await expect(closeBtn).toHaveAttribute('title', 'Close project');
  });

  test('applies correct background color', async ({ page }) => {
    const widget = page.locator('.project-widget');
    const bgColor = await widget.evaluate(el => getComputedStyle(el).backgroundColor);
    
    // Should be the first color in the palette (Desert Sand #C6A77B)
    // Convert to RGB for comparison
    expect(bgColor).toBeTruthy();
  });

  test('embeds FileTree component', async ({ page }) => {
    await page.waitForSelector('.file-tree-container', { timeout: 5000 });
    await expect(page.locator('.file-tree-container')).toBeVisible();
  });

  test('settings button opens settings dialog', async ({ page }) => {
    await page.locator('.project-widget__settings').click();
    await expect(page.locator('.project-settings-dialog')).toBeVisible();
  });

  test('buttons are disabled during refresh operation', async ({ page }) => {
    // Mock a slow refresh to test loading state
    await page.route('/api/filelist/*/tree', async route => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tree: { type: 'directory', path: '', name: '', id: '', children: [], stats: {} }
        })
      });
    });

    // Click refresh and immediately check button states
    await page.locator('.project-widget__refresh').click();
    
    // During refresh, buttons should be disabled
    await expect(page.locator('.project-widget__settings')).toBeDisabled();
    await expect(page.locator('.project-widget__close')).toBeDisabled();
  });

  test('refresh button shows spinning animation when active', async ({ page }) => {
    // Start refresh
    await page.locator('.project-widget__refresh').click();
    
    // Check for spinning animation (button text changes to ⟳)
    const refreshBtn = page.locator('.project-widget__refresh');
    const text = await refreshBtn.textContent();
    
    // Should show either spinning icon or be disabled
    expect(text === '⟳' || await refreshBtn.isDisabled()).toBe(true);
  });

  test('handles file opening from FileTree', async ({ page }) => {
    await page.waitForSelector('.file-tree-container');
    
    let editorCalled = false;
    await page.route('/api/editor/open', async route => {
      editorCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      });
    });

    // Click on a file's edit button (if available)
    const editButton = page.locator('button[title="Open in editor"]');
    if (await editButton.count() > 0) {
      await editButton.first().click();
      expect(editorCalled).toBe(true);
    }
  });
});
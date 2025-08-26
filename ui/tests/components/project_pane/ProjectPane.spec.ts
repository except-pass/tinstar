import { test, expect } from '@playwright/test';

test.describe('ProjectPane Component', () => {
  const mockProjects = [
    {
      name: 'test-project-1',
      path: '/path/to/project1',
      created_at: '2024-01-01T00:00:00Z',
      unignore_paths: ['src/config.json', '.env.local']
    },
    {
      name: 'test-project-2', 
      path: '/path/to/project2',
      created_at: '2024-01-02T00:00:00Z',
      unignore_paths: []
    }
  ];

  test.beforeEach(async ({ page }) => {
    // Mock the projects API
    await page.route('/api/projects', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          projects: mockProjects
        })
      });
    });

    // Mock filelist API for FileTree components
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

    // Create a test page with the ProjectPane
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <script type="module">
            import React from 'react';
            import ReactDOM from 'react-dom/client';
            import { ProjectPane } from '/project_pane/ProjectPane.js';
            
            const root = ReactDOM.createRoot(document.getElementById('root'));
            root.render(React.createElement(ProjectPane));
          </script>
        </head>
        <body>
          <div id="root"></div>
        </body>
      </html>
    `);
  });

  test('renders project pane container', async ({ page }) => {
    await expect(page.locator('.project-pane')).toBeVisible();
  });

  test('displays loading state initially', async ({ page }) => {
    await expect(page.locator('.project-pane__loading')).toBeVisible();
  });

  test('renders project widgets after loading', async ({ page }) => {
    await page.waitForSelector('.project-widget', { timeout: 5000 });
    
    const widgets = page.locator('.project-widget');
    await expect(widgets).toHaveCount(2);
    
    // Check project names are displayed
    await expect(page.locator('.project-widget__name').first()).toHaveText('test-project-1');
    await expect(page.locator('.project-widget__name').nth(1)).toHaveText('test-project-2');
  });

  test('displays new project button', async ({ page }) => {
    await expect(page.locator('.project-pane__new-project')).toBeVisible();
    await expect(page.locator('.project-pane__new-project')).toHaveText('+ New Project');
  });

  test('applies different colors to project widgets', async ({ page }) => {
    await page.waitForSelector('.project-widget', { timeout: 5000 });
    
    const firstWidget = page.locator('.project-widget').first();
    const secondWidget = page.locator('.project-widget').nth(1);
    
    const firstColor = await firstWidget.evaluate(el => getComputedStyle(el).backgroundColor);
    const secondColor = await secondWidget.evaluate(el => getComputedStyle(el).backgroundColor);
    
    // Colors should be different (cycling through palette)
    expect(firstColor).not.toBe(secondColor);
  });

  test('handles API error gracefully', async ({ page }) => {
    // Override with error response
    await page.route('/api/projects', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Internal server error' })
      });
    });

    await page.reload();
    
    await expect(page.locator('.project-pane__error')).toBeVisible();
    await expect(page.locator('.project-pane__error')).toContainText('Failed to fetch projects');
  });

  test('can dismiss error messages', async ({ page }) => {
    // Setup error state
    await page.route('/api/projects', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Test error' })
      });
    });

    await page.reload();
    await expect(page.locator('.project-pane__error')).toBeVisible();
    
    // Click dismiss button
    await page.locator('.project-pane__error-dismiss').click();
    await expect(page.locator('.project-pane__error')).not.toBeVisible();
  });

  test('new project button triggers directory picker', async ({ page }) => {
    await page.waitForSelector('.project-pane__new-project');
    
    // Mock file input creation and interaction
    let fileInputCreated = false;
    await page.evaluateOnNewDocument(() => {
      const originalCreateElement = document.createElement;
      document.createElement = function(tagName) {
        const element = originalCreateElement.call(document, tagName);
        if (tagName === 'input' && element.type === 'file') {
          window.fileInputCreated = true;
          element.webkitdirectory = true;
        }
        return element;
      };
    });
    
    await page.locator('.project-pane__new-project').click();
    
    const wasCreated = await page.evaluate(() => window.fileInputCreated);
    expect(wasCreated).toBe(true);
  });
});
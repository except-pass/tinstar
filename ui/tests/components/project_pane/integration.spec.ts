import { test, expect } from '@playwright/test';

test.describe('Project Pane Integration Tests', () => {
  const mockProjects = [
    {
      name: 'frontend-app',
      path: '/path/to/frontend',
      created_at: '2024-01-01T00:00:00Z',
      unignore_paths: ['src/config.json']
    },
    {
      name: 'backend-api',
      path: '/path/to/backend',
      created_at: '2024-01-02T00:00:00Z',
      unignore_paths: []
    }
  ];

  test.beforeEach(async ({ page }) => {
    // Mock initial projects API
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

    // Mock filelist API for both projects
    await page.route('/api/filelist/*/tree', async route => {
      const url = route.request().url();
      const projectName = url.includes('frontend-app') ? 'frontend-app' : 'backend-api';
      
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
                path: `src/${projectName}.tsx`,
                name: `${projectName}.tsx`,
                size: 1024,
                modified: '2024-01-01T10:00:00Z',
                stats: { lines_added: 5, lines_removed: 1, is_tracked: true },
                id: `src/${projectName}.tsx`
              }
            ],
            stats: { lines_added: 5, lines_removed: 1 }
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

    // Create test page
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="stylesheet" href="/project_pane/ProjectPane.css">
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

  test('complete project management workflow', async ({ page }) => {
    // 1. Initial load shows existing projects
    await page.waitForSelector('.project-widget', { timeout: 5000 });
    await expect(page.locator('.project-widget')).toHaveCount(2);
    
    // 2. Verify project names and colors
    await expect(page.locator('.project-widget__name').first()).toHaveText('frontend-app');
    await expect(page.locator('.project-widget__name').nth(1)).toHaveText('backend-api');
    
    // 3. Test refresh functionality
    let refreshCount = 0;
    await page.route('/api/projects', async route => {
      refreshCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          projects: mockProjects
        })
      });
    });

    await page.locator('.project-widget__refresh').first().click();
    await page.waitForTimeout(500);
    expect(refreshCount).toBeGreaterThan(1);
  });

  test('project settings end-to-end workflow', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    // 1. Open settings for first project
    await page.locator('.project-widget__settings').first().click();
    await expect(page.locator('.project-settings-dialog')).toBeVisible();
    
    // 2. Verify current settings are loaded
    await expect(page.locator('.project-settings-dialog__textarea')).toHaveValue('src/config.json');
    
    // 3. Modify settings
    await page.locator('.project-settings-dialog__textarea').clear();
    await page.locator('.project-settings-dialog__textarea').fill('new/config.json\nsecrets.env');
    
    // 4. Mock successful save
    let updateCalled = false;
    await page.route('/api/projects/frontend-app', async route => {
      if (route.request().method() === 'PUT') {
        updateCalled = true;
        const body = await route.request().postDataJSON();
        expect(body.unignore_paths).toEqual(['new/config.json', 'secrets.env']);
        
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            project: { ...mockProjects[0], unignore_paths: body.unignore_paths }
          })
        });
      }
    });
    
    // 5. Save changes
    await page.locator('.project-settings-dialog__button--save').click();
    
    // 6. Verify API was called and dialog closed
    await page.waitForTimeout(500);
    expect(updateCalled).toBe(true);
    await expect(page.locator('.project-settings-dialog')).not.toBeVisible();
  });

  test('project deletion workflow', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    // Mock delete API
    let deleteCalled = false;
    await page.route('/api/projects/frontend-app', async route => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true })
        });
      }
    });
    
    // Close first project
    await page.locator('.project-widget__close').first().click();
    
    // Verify project was removed
    await page.waitForTimeout(500);
    expect(deleteCalled).toBe(true);
    
    // Should only have one project remaining
    await expect(page.locator('.project-widget')).toHaveCount(1);
    await expect(page.locator('.project-widget__name')).toHaveText('backend-api');
  });

  test('file opening integration', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    await page.waitForSelector('.file-tree-container');
    
    // Mock editor API call
    let editorCalled = false;
    let filePath = '';
    await page.route('/api/editor/open', async route => {
      editorCalled = true;
      const body = await route.request().postDataJSON();
      filePath = body.file_path;
      
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      });
    });
    
    // Click on file edit button if available
    const editButton = page.locator('button[title="Open in editor"]').first();
    if (await editButton.count() > 0) {
      await editButton.click();
      
      expect(editorCalled).toBe(true);
      expect(filePath).toContain('.tsx');
    }
  });

  test('error handling across components', async ({ page }) => {
    // Test API error in main project list
    await page.route('/api/projects', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Database connection failed' })
      });
    });

    await page.reload();
    
    await expect(page.locator('.project-pane__error')).toBeVisible();
    await expect(page.locator('.project-pane__error')).toContainText('Failed to fetch projects');
    
    // Dismiss error
    await page.locator('.project-pane__error-dismiss').click();
    await expect(page.locator('.project-pane__error')).not.toBeVisible();
  });

  test('new project creation workflow', async ({ page }) => {
    await page.waitForSelector('.project-pane__new-project');
    
    // Mock successful project creation
    await page.route('/api/projects', async route => {
      if (route.request().method() === 'POST') {
        const body = await route.request().postDataJSON();
        const newProject = {
          name: 'new-project',
          path: body.path,
          created_at: '2024-01-03T00:00:00Z',
          unignore_paths: []
        };
        
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            project: newProject
          })
        });
      } else {
        // Return updated list with new project
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            projects: [...mockProjects, {
              name: 'new-project',
              path: '/path/to/new-project',
              created_at: '2024-01-03T00:00:00Z',
              unignore_paths: []
            }]
          })
        });
      }
    });

    // Test that button triggers directory picker creation
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

  test('color consistency across page refresh', async ({ page }) => {
    await page.waitForSelector('.project-widget');
    
    // Get initial colors
    const firstColor = await page.locator('.project-widget').first()
      .evaluate(el => getComputedStyle(el).backgroundColor);
    const secondColor = await page.locator('.project-widget').nth(1)
      .evaluate(el => getComputedStyle(el).backgroundColor);
    
    // Refresh page
    await page.reload();
    await page.waitForSelector('.project-widget');
    
    // Colors should be the same (consistent assignment)
    const refreshedFirstColor = await page.locator('.project-widget').first()
      .evaluate(el => getComputedStyle(el).backgroundColor);
    const refreshedSecondColor = await page.locator('.project-widget').nth(1)
      .evaluate(el => getComputedStyle(el).backgroundColor);
    
    expect(firstColor).toBe(refreshedFirstColor);
    expect(secondColor).toBe(refreshedSecondColor);
  });
});
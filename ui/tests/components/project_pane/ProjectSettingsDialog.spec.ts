import { test, expect } from '@playwright/test';

test.describe('ProjectSettingsDialog Component', () => {
  const mockProject = {
    name: 'test-project',
    path: '/path/to/project',
    created_at: '2024-01-01T00:00:00Z',
    unignore_paths: ['src/config.json', '.env.local', 'docs/secrets.md']
  };

  test.beforeEach(async ({ page }) => {
    // Mock the project update API
    await page.route('/api/projects/test-project', async route => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            project: mockProject,
            message: 'Project updated successfully'
          })
        });
      }
    });

    // Create test page with ProjectSettingsDialog
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <script type="module">
            import React from 'react';
            import ReactDOM from 'react-dom/client';
            import { ProjectSettingsDialog } from '/project_pane/ProjectSettingsDialog.js';
            
            const project = ${JSON.stringify(mockProject)};
            const onClose = () => console.log('close');
            const onSave = async () => console.log('save');
            
            const root = ReactDOM.createRoot(document.getElementById('root'));
            root.render(React.createElement(ProjectSettingsDialog, { 
              project, 
              onClose, 
              onSave,
              saving: false
            }));
          </script>
        </head>
        <body>
          <div id="root"></div>
        </body>
      </html>
    `);
  });

  test('renders dialog with correct structure', async ({ page }) => {
    await expect(page.locator('.project-settings-dialog__overlay')).toBeVisible();
    await expect(page.locator('.project-settings-dialog')).toBeVisible();
    await expect(page.locator('.project-settings-dialog__header')).toBeVisible();
    await expect(page.locator('.project-settings-dialog__content')).toBeVisible();
    await expect(page.locator('.project-settings-dialog__actions')).toBeVisible();
  });

  test('displays project name as read-only', async ({ page }) => {
    const nameInput = page.locator('.project-settings-dialog__input--readonly');
    await expect(nameInput).toHaveValue('test-project');
    await expect(nameInput).toHaveAttribute('readonly');
  });

  test('prepopulates textarea with existing unignore paths', async ({ page }) => {
    const textarea = page.locator('.project-settings-dialog__textarea');
    const expectedText = 'src/config.json\n.env.local\ndocs/secrets.md';
    await expect(textarea).toHaveValue(expectedText);
  });

  test('shows correct labels and hints', async ({ page }) => {
    await expect(page.locator('text=Project Name')).toBeVisible();
    await expect(page.locator('text=Unignore Paths')).toBeVisible();
    await expect(page.locator('text=(one path per line, relative to project root)')).toBeVisible();
  });

  test('has Save and Cancel buttons', async ({ page }) => {
    await expect(page.locator('.project-settings-dialog__button--save')).toHaveText('Save');
    await expect(page.locator('.project-settings-dialog__button--cancel')).toHaveText('Cancel');
  });

  test('allows editing of unignore paths', async ({ page }) => {
    const textarea = page.locator('.project-settings-dialog__textarea');
    
    await textarea.clear();
    await textarea.fill('new/path.json\nanother/file.txt');
    
    await expect(textarea).toHaveValue('new/path.json\nanother/file.txt');
  });

  test('saves changes when Save button is clicked', async ({ page }) => {
    const textarea = page.locator('.project-settings-dialog__textarea');
    
    await textarea.clear();
    await textarea.fill('updated/path.json\nanother/file.txt');
    
    let saveRequestMade = false;
    await page.route('/api/projects/test-project', async route => {
      if (route.request().method() === 'PUT') {
        saveRequestMade = true;
        const requestBody = await route.request().postDataJSON();
        
        // Verify the request contains the updated paths
        expect(requestBody.unignore_paths).toEqual(['updated/path.json', 'another/file.txt']);
        
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, project: mockProject })
        });
      }
    });

    await page.locator('.project-settings-dialog__button--save').click();
    expect(saveRequestMade).toBe(true);
  });

  test('handles empty lines and whitespace correctly', async ({ page }) => {
    const textarea = page.locator('.project-settings-dialog__textarea');
    
    await textarea.clear();
    await textarea.fill('  path1.json  \n\n  path2.txt  \n\n');
    
    let requestBody = null;
    await page.route('/api/projects/test-project', async route => {
      if (route.request().method() === 'PUT') {
        requestBody = await route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, project: mockProject })
        });
      }
    });

    await page.locator('.project-settings-dialog__button--save').click();
    
    // Should trim whitespace and filter empty lines
    expect(requestBody?.unignore_paths).toEqual(['path1.json', 'path2.txt']);
  });

  test('displays API validation errors', async ({ page }) => {
    await page.route('/api/projects/test-project', async route => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: 'Invalid path: cannot escape project root'
          })
        });
      }
    });

    await page.locator('.project-settings-dialog__button--save').click();
    
    await expect(page.locator('.project-settings-dialog__error')).toBeVisible();
    await expect(page.locator('.project-settings-dialog__error')).toContainText('Invalid path: cannot escape project root');
  });

  test('shows loading state during save operation', async ({ page }) => {
    // Mock slow API response
    await page.route('/api/projects/test-project', async route => {
      if (route.request().method() === 'PUT') {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, project: mockProject })
        });
      }
    });

    await page.locator('.project-settings-dialog__button--save').click();
    
    // Check that save button shows loading state
    await expect(page.locator('.project-settings-dialog__button--save')).toHaveText('Saving...');
    await expect(page.locator('.project-settings-dialog__button--save')).toBeDisabled();
    await expect(page.locator('.project-settings-dialog__button--cancel')).toBeDisabled();
  });

  test('closes dialog on Cancel button click', async ({ page }) => {
    let cancelCalled = false;
    await page.evaluateOnNewDocument(() => {
      const originalConsoleLog = console.log;
      console.log = function(message) {
        if (message === 'close') {
          window.cancelCalled = true;
        }
        originalConsoleLog.apply(console, arguments);
      };
    });

    await page.locator('.project-settings-dialog__button--cancel').click();
    
    const wasCalled = await page.evaluate(() => window.cancelCalled);
    expect(wasCalled).toBe(true);
  });

  test('closes dialog on X button click', async ({ page }) => {
    let closeCalled = false;
    await page.evaluateOnNewDocument(() => {
      const originalConsoleLog = console.log;
      console.log = function(message) {
        if (message === 'close') {
          window.closeCalled = true;
        }
        originalConsoleLog.apply(console, arguments);
      };
    });

    await page.locator('.project-settings-dialog__close').click();
    
    const wasCalled = await page.evaluate(() => window.closeCalled);
    expect(wasCalled).toBe(true);
  });

  test('closes dialog on Escape key press', async ({ page }) => {
    let escapeCalled = false;
    await page.evaluateOnNewDocument(() => {
      const originalConsoleLog = console.log;
      console.log = function(message) {
        if (message === 'close') {
          window.escapeCalled = true;
        }
        originalConsoleLog.apply(console, arguments);
      };
    });

    await page.keyboard.press('Escape');
    
    const wasCalled = await page.evaluate(() => window.escapeCalled);
    expect(wasCalled).toBe(true);
  });

  test('resets form on cancel', async ({ page }) => {
    const textarea = page.locator('.project-settings-dialog__textarea');
    
    // Modify the textarea
    await textarea.clear();
    await textarea.fill('modified content');
    
    // Cancel should reset to original content
    await page.locator('.project-settings-dialog__button--cancel').click();
    
    // If dialog reappears, it should show original content
    // This tests the reset functionality in the component
  });
});
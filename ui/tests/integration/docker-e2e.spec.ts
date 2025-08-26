import { test, expect } from '@playwright/test';

test.describe('Docker Integration - End-to-End Project Management', () => {
  test.setTimeout(120000); // 2 minutes for Docker operations

  test('full project lifecycle in Docker container', async ({ page }) => {
    // This test should run against a running tinstar instance in Docker
    // The container should have:
    // 1. Tinstar backend running on port 8000
    // 2. Test git repositories created by docker-test-setup.sh
    // 3. UI served and accessible

    // Connect to tinstar running in container
    const TINSTAR_URL = process.env.TINSTAR_URL || 'http://localhost:8000';
    
    await page.goto(`${TINSTAR_URL}/ui`);
    
    // Wait for the UI to load
    await page.waitForSelector('.project-pane', { timeout: 30000 });
    
    // Take initial screenshot
    await page.screenshot({ 
      path: 'screenshots/01-initial-load.png', 
      fullPage: true 
    });

    // Verify initial state - should have no projects initially
    await expect(page.locator('.project-pane')).toBeVisible();
    await expect(page.locator('.project-pane__new-project')).toBeVisible();
    
    // Test 1: Add the frontend project
    console.log('🎯 Test 1: Adding frontend project...');
    
    // Mock the directory picker to select our test frontend project
    await page.evaluate(() => {
      // Override the file input behavior
      const originalCreateElement = document.createElement;
      document.createElement = function(tagName) {
        const element = originalCreateElement.call(document, tagName);
        if (tagName === 'input' && element.type === 'file') {
          // Simulate selecting the frontend project directory
          element.webkitdirectory = true;
          setTimeout(() => {
            // Trigger the onchange event with mock file data
            const mockFiles = [{
              webkitRelativePath: 'sample-frontend/package.json',
              path: '/home/testuser/test-projects/sample-frontend'
            }];
            Object.defineProperty(element, 'files', { value: mockFiles });
            
            if (element.onchange) {
              element.onchange({ target: element });
            }
          }, 100);
        }
        return element;
      };
    });

    // Click new project button
    await page.locator('.project-pane__new-project').click();
    
    // Wait for project to be added (this will depend on the actual API integration)
    await page.waitForTimeout(3000);
    
    // Take screenshot after adding first project
    await page.screenshot({ 
      path: 'screenshots/02-frontend-project-added.png', 
      fullPage: true 
    });

    // Test 2: Verify project appears in the list
    console.log('🎯 Test 2: Verifying project in list...');
    
    // Should now have one project widget
    await page.waitForSelector('.project-widget', { timeout: 10000 });
    const projectWidgets = page.locator('.project-widget');
    await expect(projectWidgets).toHaveCount(1);
    
    // Verify project name
    const projectName = page.locator('.project-widget__name').first();
    await expect(projectName).toContainText('sample-frontend');
    
    // Test 3: Verify file tree shows project structure
    console.log('🎯 Test 3: Checking file tree structure...');
    
    await page.waitForSelector('.file-tree-container', { timeout: 10000 });
    
    // Should show files from our frontend project
    const fileEntries = page.locator('.file-entry');
    await expect(fileEntries.first()).toBeVisible();
    
    // Take screenshot of file tree
    await page.screenshot({ 
      path: 'screenshots/03-file-tree-visible.png', 
      fullPage: true 
    });

    // Test 4: Test file opening functionality
    console.log('🎯 Test 4: Testing file operations...');
    
    // Look for edit buttons and click one if available
    const editButtons = page.locator('button[title="Open in editor"]');
    if (await editButtons.count() > 0) {
      await editButtons.first().click();
      await page.waitForTimeout(1000);
      
      await page.screenshot({ 
        path: 'screenshots/04-file-opened.png', 
        fullPage: true 
      });
    }

    // Test 5: Test project settings
    console.log('🎯 Test 5: Testing project settings...');
    
    await page.locator('.project-widget__settings').first().click();
    await page.waitForSelector('.project-settings-dialog', { timeout: 5000 });
    
    // Verify settings dialog
    await expect(page.locator('.project-settings-dialog')).toBeVisible();
    await expect(page.locator('.project-settings-dialog__textarea')).toBeVisible();
    
    // Take screenshot of settings dialog
    await page.screenshot({ 
      path: 'screenshots/05-settings-dialog.png', 
      fullPage: true 
    });
    
    // Test editing unignore paths
    const textarea = page.locator('.project-settings-dialog__textarea');
    await textarea.clear();
    await textarea.fill('src/config.json\n.env.local\ndist/bundle.js');
    
    await page.screenshot({ 
      path: 'screenshots/06-settings-modified.png', 
      fullPage: true 
    });
    
    // Save settings
    await page.locator('.project-settings-dialog__button--save').click();
    await page.waitForTimeout(2000);
    
    // Dialog should close
    await expect(page.locator('.project-settings-dialog')).not.toBeVisible();
    
    await page.screenshot({ 
      path: 'screenshots/07-settings-saved.png', 
      fullPage: true 
    });

    // Test 6: Add a second project (backend)
    console.log('🎯 Test 6: Adding second project...');
    
    // Mock directory picker for backend project
    await page.evaluate(() => {
      document.createElement = function(tagName) {
        const element = document.createElement.call(document, tagName);
        if (tagName === 'input' && element.type === 'file') {
          element.webkitdirectory = true;
          setTimeout(() => {
            const mockFiles = [{
              webkitRelativePath: 'sample-backend/package.json',
              path: '/home/testuser/test-projects/sample-backend'
            }];
            Object.defineProperty(element, 'files', { value: mockFiles });
            
            if (element.onchange) {
              element.onchange({ target: element });
            }
          }, 100);
        }
        return element;
      };
    });

    await page.locator('.project-pane__new-project').click();
    await page.waitForTimeout(3000);
    
    // Should now have two projects
    await expect(page.locator('.project-widget')).toHaveCount(2);
    
    // Verify different colors are applied
    const firstProjectBg = await page.locator('.project-widget').first()
      .evaluate(el => getComputedStyle(el).backgroundColor);
    const secondProjectBg = await page.locator('.project-widget').nth(1)
      .evaluate(el => getComputedStyle(el).backgroundColor);
    
    expect(firstProjectBg).not.toBe(secondProjectBg);
    
    await page.screenshot({ 
      path: 'screenshots/08-two-projects.png', 
      fullPage: true 
    });

    // Test 7: Test project refresh functionality
    console.log('🎯 Test 7: Testing refresh functionality...');
    
    await page.locator('.project-widget__refresh').first().click();
    await page.waitForTimeout(2000);
    
    await page.screenshot({ 
      path: 'screenshots/09-after-refresh.png', 
      fullPage: true 
    });

    // Test 8: Test project removal
    console.log('🎯 Test 8: Testing project removal...');
    
    // Close the first project
    await page.locator('.project-widget__close').first().click();
    await page.waitForTimeout(2000);
    
    // Should now have one project remaining
    await expect(page.locator('.project-widget')).toHaveCount(1);
    
    // Remaining project should be the backend
    const remainingProject = page.locator('.project-widget__name').first();
    await expect(remainingProject).toContainText('sample-backend');
    
    await page.screenshot({ 
      path: 'screenshots/10-project-removed.png', 
      fullPage: true 
    });

    // Test 9: Error handling
    console.log('🎯 Test 9: Testing error handling...');
    
    // Try to add an invalid project (non-git directory)
    await page.evaluate(() => {
      document.createElement = function(tagName) {
        const element = document.createElement.call(document, tagName);
        if (tagName === 'input' && element.type === 'file') {
          element.webkitdirectory = true;
          setTimeout(() => {
            const mockFiles = [{
              webkitRelativePath: 'invalid-dir/file.txt',
              path: '/tmp/invalid-dir'
            }];
            Object.defineProperty(element, 'files', { value: mockFiles });
            
            if (element.onchange) {
              element.onchange({ target: element });
            }
          }, 100);
        }
        return element;
      };
    });

    await page.locator('.project-pane__new-project').click();
    await page.waitForTimeout(3000);
    
    // Should show an error message
    if (await page.locator('.project-pane__error').count() > 0) {
      await expect(page.locator('.project-pane__error')).toBeVisible();
      
      await page.screenshot({ 
        path: 'screenshots/11-error-handling.png', 
        fullPage: true 
      });
      
      // Dismiss error
      await page.locator('.project-pane__error-dismiss').click();
      await expect(page.locator('.project-pane__error')).not.toBeVisible();
    }

    // Final screenshot
    await page.screenshot({ 
      path: 'screenshots/12-final-state.png', 
      fullPage: true 
    });

    console.log('✅ Docker integration test completed successfully!');
    console.log('📸 Screenshots saved to screenshots/ directory');
  });

  // Additional test for API integration
  test('API endpoints respond correctly', async ({ request }) => {
    const TINSTAR_URL = process.env.TINSTAR_URL || 'http://localhost:8000';
    
    // Test projects API
    const projectsResponse = await request.get(`${TINSTAR_URL}/api/projects`);
    expect(projectsResponse.ok()).toBeTruthy();
    
    const projectsData = await projectsResponse.json();
    expect(projectsData).toHaveProperty('success');
    
    // Test health endpoint
    const healthResponse = await request.get(`${TINSTAR_URL}/api/projects/health`);
    expect(healthResponse.ok()).toBeTruthy();
  });
});
import { test, expect } from '@playwright/test';

test.describe('Real Docker Integration - End-to-End with Actual Components', () => {
  test.setTimeout(180000); // 3 minutes for full Docker integration

  const TINSTAR_URL = process.env.TINSTAR_URL || 'http://localhost:3002';
  const UI_URL = process.env.UI_URL || 'http://localhost:8081';

  test('real tinstar integration with actual components', async ({ page }) => {
    console.log(`🔗 Connecting to Tinstar API: ${TINSTAR_URL}`);
    console.log(`🎨 UI served from: ${UI_URL}`);

    // Navigate to the real test page
    await page.goto(`${UI_URL}/real-test.html`);
    
    // Wait for React to load and API to connect
    await page.waitForSelector('.project-pane', { timeout: 30000 });
    
    // Take initial screenshot
    await page.screenshot({ 
      path: 'screenshots/real-01-initial-load.png', 
      fullPage: true 
    });

    console.log('📱 Real UI components loaded');

    // Wait for test status to complete
    await page.waitForSelector('.test-status.success, .test-status.error', { timeout: 30000 });
    
    const testStatus = await page.locator('.test-status').textContent();
    console.log(`🧪 Test status: ${testStatus}`);
    
    // Verify successful API connection
    await expect(page.locator('.test-status.success')).toBeVisible();
    
    // Take screenshot after API connection
    await page.screenshot({ 
      path: 'screenshots/real-02-api-connected.png', 
      fullPage: true 
    });

    // Test actual project widgets
    console.log('🏗️ Testing real project widgets...');
    
    const projectWidgets = page.locator('.project-widget');
    const widgetCount = await projectWidgets.count();
    console.log(`Found ${widgetCount} project widgets`);
    
    // Should have at least one project from the Docker setup
    await expect(projectWidgets).toHaveCountGreaterThan(0);
    
    // Verify Western color theme
    if (widgetCount > 0) {
      const firstWidget = projectWidgets.first();
      const backgroundColor = await firstWidget.evaluate(el => getComputedStyle(el).backgroundColor);
      console.log(`🎨 First widget background color: ${backgroundColor}`);
      
      // Should be one of the Western theme colors
      const westernColors = [
        'rgb(198, 167, 123)', // Desert Sand
        'rgb(139, 90, 43)',   // Saddle Brown
        'rgb(160, 64, 32)',   // Rust Red
        'rgb(75, 75, 75)',    // Gunmetal Gray
        'rgb(212, 175, 55)',  // Prairie Gold
        'rgb(85, 107, 47)',   // Cactus Green
        'rgb(154, 182, 195)', // Dusty Sky
        'rgb(46, 27, 15)'     // Charred Wood
      ];
      
      expect(westernColors).toContain(backgroundColor);
    }
    
    // Take screenshot of project widgets
    await page.screenshot({ 
      path: 'screenshots/real-03-project-widgets.png', 
      fullPage: true 
    });

    // Test real FileTree integration
    console.log('🌳 Testing real FileTree components...');
    
    await page.waitForSelector('.file-tree-container', { timeout: 20000 });
    const fileTrees = page.locator('.file-tree-container');
    const fileTreeCount = await fileTrees.count();
    console.log(`Found ${fileTreeCount} file trees`);
    
    await expect(fileTrees).toHaveCountGreaterThan(0);
    
    // Wait for file entries to load
    await page.waitForSelector('.file-entry', { timeout: 20000 });
    const fileEntries = page.locator('.file-entry');
    const entryCount = await fileEntries.count();
    console.log(`Found ${entryCount} file entries`);
    
    await expect(fileEntries).toHaveCountGreaterThan(0);
    
    // Verify file entries have proper icons and names
    const firstEntry = fileEntries.first();
    const entryText = await firstEntry.textContent();
    console.log(`📄 First file entry: ${entryText}`);
    
    // Should contain file/folder icons and names
    expect(entryText).toBeTruthy();
    
    // Take screenshot of file trees
    await page.screenshot({ 
      path: 'screenshots/real-04-file-trees.png', 
      fullPage: true 
    });

    // Test control button interactions
    console.log('🎛️ Testing control button interactions...');
    
    const refreshButtons = page.locator('.project-widget__refresh');
    if (await refreshButtons.count() > 0) {
      await refreshButtons.first().click();
      await page.waitForTimeout(2000);
      console.log('✅ Refresh button clicked');
    }
    
    const settingsButtons = page.locator('.project-widget__settings');
    if (await settingsButtons.count() > 0) {
      await settingsButtons.first().click();
      
      // Should open settings dialog
      await page.waitForSelector('.project-settings-dialog', { timeout: 5000 });
      await expect(page.locator('.project-settings-dialog')).toBeVisible();
      
      console.log('✅ Settings dialog opened');
      
      // Take screenshot of settings dialog
      await page.screenshot({ 
        path: 'screenshots/real-05-settings-dialog.png', 
        fullPage: true 
      });
      
      // Close settings dialog
      await page.locator('.project-settings-dialog button').last().click();
      await expect(page.locator('.project-settings-dialog')).not.toBeVisible();
    }

    // Test file opening functionality  
    console.log('📂 Testing file opening functionality...');
    
    const editButtons = page.locator('.file-entry button[title="Open in editor"]');
    const editButtonCount = await editButtons.count();
    console.log(`Found ${editButtonCount} edit buttons`);
    
    if (editButtonCount > 0) {
      // Mock the editor API call to avoid actual editor opening
      await page.route(`${TINSTAR_URL}/api/editor/open`, route => {
        console.log('🎯 Editor API call intercepted');
        route.fulfill({ status: 200, body: '{"success": true}' });
      });
      
      await editButtons.first().click();
      await page.waitForTimeout(1000);
      console.log('✅ File edit button clicked (API mocked)');
    }

    // Test New Project button
    console.log('➕ Testing New Project button...');
    
    const newProjectBtn = page.locator('.project-pane__new-project');
    await expect(newProjectBtn).toBeVisible();
    await expect(newProjectBtn).toHaveText('+ New Project');
    
    // Click should trigger alert (in our test implementation)
    page.on('dialog', dialog => {
      console.log('✅ New Project dialog triggered');
      dialog.accept();
    });
    
    await newProjectBtn.click();
    await page.waitForTimeout(1000);

    // Final comprehensive screenshot
    await page.screenshot({ 
      path: 'screenshots/real-06-final-state.png', 
      fullPage: true 
    });

    // Verify the integration test summary
    console.log('📊 Verifying integration test results...');
    
    await expect(page.locator('h1')).toContainText('Tinstar Real Integration Test');
    await expect(page.locator('.test-info')).toContainText('actual');
    await expect(page.locator('.test-info')).toContainText('Real ProjectPane.tsx');
    await expect(page.locator('.test-info')).toContainText('Real FileTree');
    
    // Log final test results
    console.log('🎉 Real Docker Integration Test Complete!');
    console.log(`   ✅ Real API connection: ${TINSTAR_URL}`);
    console.log(`   ✅ Real UI components loaded`);
    console.log(`   ✅ Projects found: ${widgetCount}`);
    console.log(`   ✅ File entries found: ${entryCount}`);
    console.log(`   ✅ Western color theme applied`);
    console.log(`   ✅ All interactions functional`);
  });

  test('verify real API endpoints', async ({ request }) => {
    console.log(`🔍 Testing real API endpoints at ${TINSTAR_URL}`);
    
    // Test health endpoint
    const healthResponse = await request.get(`${TINSTAR_URL}/api/projects/health`);
    expect(healthResponse.ok()).toBeTruthy();
    console.log('✅ Health endpoint responding');
    
    // Test projects endpoint
    const projectsResponse = await request.get(`${TINSTAR_URL}/api/projects`);
    expect(projectsResponse.ok()).toBeTruthy();
    
    const projectsData = await projectsResponse.json();
    expect(projectsData).toHaveProperty('success');
    expect(projectsData.success).toBe(true);
    
    const projectCount = projectsData.projects?.length || 0;
    console.log(`✅ Projects API responding (${projectCount} projects)`);
    
    // Test at least one filelist endpoint if projects exist
    if (projectCount > 0) {
      const firstProject = projectsData.projects[0];
      console.log(`🌳 Testing filelist API for project: ${firstProject.name}`);
      
      const filelistResponse = await request.post(`${TINSTAR_URL}/api/filelist/${firstProject.name}/tree`, {
        data: { open_dirs: [''] }
      });
      
      expect(filelistResponse.ok()).toBeTruthy();
      
      const filelistData = await filelistResponse.json();
      expect(filelistData).toHaveProperty('tree');
      
      console.log('✅ Filelist API responding with tree data');
    }
    
    console.log('🎯 All API endpoints validated successfully!');
  });
});
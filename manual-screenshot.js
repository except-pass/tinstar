const { chromium } = require('playwright');

(async () => {
  console.log('🚀 Starting manual screenshot capture...');
  
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    console.log('🌐 Navigating to real test page...');
    await page.goto('http://localhost:8081/real-test.html');
    
    console.log('⏳ Waiting for page to load...');
    await page.waitForTimeout(5000);
    
    console.log('📸 Taking screenshot 1: Initial load');
    await page.screenshot({ 
      path: './ui/screenshots/manual-01-initial.png', 
      fullPage: true 
    });
    
    // Try to wait for the project pane
    try {
      console.log('🎯 Waiting for project pane...');
      await page.waitForSelector('.project-pane', { timeout: 10000 });
      console.log('✅ Project pane found!');
    } catch (e) {
      console.log('⚠️ Project pane not found, continuing...');
    }
    
    console.log('📸 Taking screenshot 2: After wait');
    await page.screenshot({ 
      path: './ui/screenshots/manual-02-loaded.png', 
      fullPage: true 
    });
    
    // Check for test status
    try {
      await page.waitForSelector('.test-status', { timeout: 10000 });
      console.log('✅ Test status element found!');
    } catch (e) {
      console.log('⚠️ Test status not found');
    }
    
    console.log('📸 Taking screenshot 3: Final state');
    await page.screenshot({ 
      path: './ui/screenshots/manual-03-final.png', 
      fullPage: true 
    });
    
    // Get page content
    const title = await page.title();
    console.log(`📄 Page title: ${title}`);
    
    const content = await page.textContent('body');
    console.log(`📝 Page contains: ${content.substring(0, 200)}...`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
    console.log('🎉 Manual screenshots completed!');
  }
})();